/**
 * Repository labels under the capability policy. Reading labels needs no
 * capability. Applying existing labels to an issue is `label-use`; an unknown
 * name is refused and never created. Creating, editing and deleting labels
 * is `label-manage` and runs as a durable intent reconciled by label name, so
 * a create whose response was lost yields exactly one label. Labels are
 * repository labels only: milestones and Project fields are separate.
 *
 * @file
 */
import path from 'node:path';

import { z } from 'zod/v3';

import { runIntent } from './connector-intents.ts';
import { MeshError, parseInput } from './protocol.ts';

import type { GitHubRunner } from './github-runner.ts';
import type { OperationInput } from './protocol.ts';

/** One repository label. */
const labelSchema = z.object({ name: z.string(), color: z.string(), description: z.string().nullable() });
/** Pages of labels from `gh api --paginate --slurp`. */
const labelPagesSchema = z.array(z.array(labelSchema));
/** A repository label. */
export type Label = z.output<typeof labelSchema>;
/** Result of a label change. */
const changeSchema = z.object({ action: z.enum(['create', 'edit', 'delete']), label: labelSchema.nullable() });

/** What label operations need from the integration. */
export interface LabelContext {
  /** GitHub CLI seam. */
  readonly runner: GitHubRunner;
  /** Connected `owner/name`. */
  readonly repository: string;
  /** This project's private GitHub integration directory. */
  readonly directory: string;
}

/**
 * List the repository's labels.
 *
 * @param context - Integration.
 * @returns Every label.
 */
export async function listLabels(context: LabelContext): Promise<Label[]> {
  const endpoint = `repos/${context.repository}/labels?per_page=100`;
  return labelPagesSchema.parse(await context.runner(['api', endpoint, '--paginate', '--slurp'])).flat();
}

/**
 * Apply existing labels to an issue; unknown names are refused, never created.
 *
 * @param context - Integration.
 * @param input - Issue and label names.
 * @returns The issue's labels afterwards.
 * @throws {MeshError} INVALID_INPUT for a name that differs from an existing label only in case; CAPABILITY_DENIED for one that does not exist.
 */
export async function applyLabels(
  context: LabelContext,
  input: OperationInput<'github_label_apply'>,
): Promise<{ issue: number; labels: string[] }> {
  const existing = await listLabels(context);
  for (const name of input.labels) {
    if (existing.some((label) => label.name === name)) {
      continue;
    }
    const near = existing.find((label) => label.name.toLowerCase() === name.toLowerCase());
    if (near !== undefined) {
      throw new MeshError('INVALID_INPUT', `No label "${name}" exists; did you mean "${near.name}"? Names are exact.`);
    }
    throw new MeshError(
      'CAPABILITY_DENIED',
      `Repository label "${name}" does not exist. Applying labels never creates one; creating labels needs label-manage.`,
    );
  }
  const endpoint = `repos/${context.repository}/issues/${String(input.issue)}/labels`;
  const applied = z
    .array(labelSchema)
    .parse(await context.runner(['api', endpoint, '--method', 'POST', '--input', '-'], { labels: input.labels }));
  return { issue: input.issue, labels: applied.map((label) => label.name) };
}

/**
 * The label a change produces, if it is already visible on GitHub.
 *
 * @param labels - Current repository labels.
 * @param input - Requested change.
 * @returns The change's result when it already happened.
 */
function reconciled(
  labels: readonly Label[],
  input: OperationInput<'github_label_manage'>,
): z.output<typeof changeSchema> | undefined {
  const named = (name: string): Label | undefined => labels.find((label) => label.name === name);
  if (input.action === 'delete') {
    return named(input.name) === undefined ? { action: 'delete', label: null } : undefined;
  }
  const target = named(input.action === 'edit' ? (input.rename ?? input.name) : input.name);
  const isRenamed = input.action === 'create' || input.rename === undefined || named(input.name) === undefined;
  // A retried edit counts as done only when the label already carries every requested attribute.
  return target !== undefined && isRenamed && hasAttributes(target, input)
    ? { action: input.action, label: target }
    : undefined;
}

/**
 * Whether a label already has the requested color and description.
 *
 * @param label - Remote label.
 * @param input - Requested change.
 * @returns True when every requested attribute matches.
 */
function hasAttributes(label: Label, input: OperationInput<'github_label_manage'>): boolean {
  const isColor = input.color === undefined || input.color.toLowerCase() === label.color.toLowerCase();
  const isDescription = input.description === undefined || input.description === (label.description ?? '');
  return isColor && isDescription;
}

/**
 * Create, edit or delete a repository label once per request ID.
 *
 * @param context - Integration.
 * @param input - Requested change with its request ID.
 * @returns The changed label, or null after a delete.
 */
export async function manageLabel(
  context: LabelContext,
  input: OperationInput<'github_label_manage'>,
): Promise<z.output<typeof changeSchema>> {
  const base = `repos/${context.repository}/labels`;
  const body = {
    ...(input.color !== undefined && { color: input.color }),
    ...(input.description !== undefined && { description: input.description }),
  };
  const perform = async (): Promise<z.output<typeof changeSchema>> => {
    if (input.action === 'delete') {
      await context.runner(['api', `${base}/${encodeURIComponent(input.name)}`, '--method', 'DELETE']);
      return { action: 'delete', label: null };
    }
    const label =
      input.action === 'create'
        ? await context.runner(['api', base, '--method', 'POST', '--input', '-'], { name: input.name, ...body })
        : await context.runner(
            ['api', `${base}/${encodeURIComponent(input.name)}`, '--method', 'PATCH', '--input', '-'],
            {
              ...(input.rename !== undefined && { new_name: input.rename }),
              ...body,
            },
          );
    return { action: input.action, label: labelSchema.parse(label) };
  };
  // The intent names its repository, so a retry after the workspace switched repositories is refused.
  const intent = { ...input, repository: context.repository };
  return runIntent(path.join(context.directory, 'intents', 'labels'), input.requestId, intent, {
    reconcile: async () => reconciled(await listLabels(context), input),
    perform,
    result: changeSchema,
  });
}

/**
 * Dispatch one label operation.
 *
 * @param context - Integration.
 * @param operation - Which label operation: list, apply or manage.
 * @param input - Untrusted input.
 * @returns Its result.
 */
export async function labelOperation(
  context: LabelContext,
  operation: 'github_labels' | 'github_label_apply' | 'github_label_manage',
  input: unknown,
): Promise<unknown> {
  switch (operation) {
    case 'github_labels': {
      parseInput(operation, input);
      return { labels: await listLabels(context) };
    }
    case 'github_label_apply': {
      return applyLabels(context, parseInput(operation, input));
    }
    case 'github_label_manage': {
      return manageLabel(context, parseInput(operation, input));
    }
  }
}
