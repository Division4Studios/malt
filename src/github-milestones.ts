/**
 * Repository milestones under the capability policy. Reading milestones needs
 * no capability. Assigning an existing milestone to an issue is
 * `milestone-use`; an unknown title is refused and never created. Creating,
 * editing, closing and deleting milestones is `milestone-manage`, runs as a
 * durable intent reconciled by title, and is confirmed against the remote
 * state afterwards. Milestones are not labels, Projects or Jira versions.
 *
 * @file
 */
import path from 'node:path';

import { z } from 'zod/v3';

import { runIntent } from './connector-intents.ts';
import { MeshError, parseInput } from './protocol.ts';

import type { GitHubRunner } from './github-runner.ts';
import type { OperationInput } from './protocol.ts';

/** One repository milestone. */
const milestoneSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  state: z.enum(['open', 'closed']),
  description: z.string().nullable(),
  due_on: z.string().nullable(),
});
/** Pages of milestones from `gh api --paginate --slurp`. */
const milestonePagesSchema = z.array(z.array(milestoneSchema));
/** A repository milestone. */
export type Milestone = z.output<typeof milestoneSchema>;
/** Result of a milestone change. */
const changeSchema = z.object({
  action: z.enum(['create', 'edit', 'close', 'delete']),
  milestone: milestoneSchema.nullable(),
});
/** A milestone change's result. */
type Change = z.output<typeof changeSchema>;
/** A milestone change request. */
type ManageInput = OperationInput<'github_milestone_manage'>;

/** What milestone operations need from the integration. */
export interface MilestoneContext {
  /** GitHub CLI seam. */
  readonly runner: GitHubRunner;
  /** Connected `owner/name`. */
  readonly repository: string;
  /** This project's private GitHub integration directory. */
  readonly directory: string;
}

/**
 * List open and closed milestones.
 *
 * @param context - Integration.
 * @returns Every milestone.
 */
export async function listMilestones(context: MilestoneContext): Promise<Milestone[]> {
  const endpoint = `repos/${context.repository}/milestones?state=all&per_page=100`;
  return milestonePagesSchema.parse(await context.runner(['api', endpoint, '--paginate', '--slurp'])).flat();
}

/**
 * A milestone by exact title.
 *
 * @param milestones - Current milestones.
 * @param title - Title to find.
 * @returns The milestone, if present.
 */
function titled(milestones: readonly Milestone[], title: string): Milestone | undefined {
  return milestones.find((milestone) => milestone.title === title);
}

/**
 * Assign an existing milestone to an issue; an unknown title is refused, never created.
 *
 * @param context - Integration.
 * @param input - Issue and milestone title.
 * @returns The issue and its milestone.
 * @throws {MeshError} CAPABILITY_DENIED for a title that does not exist.
 */
export async function assignMilestone(
  context: MilestoneContext,
  input: OperationInput<'github_milestone_assign'>,
): Promise<{ issue: number; milestone: string }> {
  const milestone = titled(await listMilestones(context), input.title);
  if (milestone === undefined) {
    throw new MeshError(
      'CAPABILITY_DENIED',
      `Milestone "${input.title}" does not exist. Assigning never creates one; creating milestones needs milestone-manage.`,
    );
  }
  const endpoint = `repos/${context.repository}/issues/${String(input.issue)}`;
  await context.runner(['api', endpoint, '--method', 'PATCH', '--input', '-'], { milestone: milestone.number });
  return { issue: input.issue, milestone: milestone.title };
}

/**
 * The change's result if the remote already shows it.
 *
 * @param milestones - Current milestones.
 * @param input - Requested change.
 * @returns Result when the change is visible, otherwise undefined.
 */
function observed(milestones: readonly Milestone[], input: ManageInput): Change | undefined {
  const current = titled(milestones, input.title);
  if (input.action === 'delete') {
    return current === undefined ? { action: 'delete', milestone: null } : undefined;
  }
  if (input.action === 'close') {
    return current?.state === 'closed' ? { action: 'close', milestone: current } : undefined;
  }
  const target = titled(milestones, input.action === 'edit' ? (input.retitle ?? input.title) : input.title);
  return target === undefined ? undefined : { action: input.action, milestone: target };
}

/**
 * Make one change on GitHub.
 *
 * @param context - Integration.
 * @param input - Requested change.
 * @returns Nothing; the result is read back from the remote.
 * @throws {MeshError} INVALID_INPUT when the milestone to change does not exist.
 */
async function perform(context: MilestoneContext, input: ManageInput): Promise<void> {
  const base = `repos/${context.repository}/milestones`;
  const fields = {
    ...(input.description !== undefined && { description: input.description }),
    ...(input.dueOn !== undefined && { due_on: input.dueOn }),
  };
  if (input.action === 'create') {
    await context.runner(['api', base, '--method', 'POST', '--input', '-'], { title: input.title, ...fields });
    return;
  }
  const current = titled(await listMilestones(context), input.title);
  if (current === undefined) {
    throw new MeshError('INVALID_INPUT', `No milestone is titled "${input.title}".`);
  }
  const endpoint = `${base}/${String(current.number)}`;
  if (input.action === 'delete') {
    await context.runner(['api', endpoint, '--method', 'DELETE']);
    return;
  }
  const change =
    input.action === 'close'
      ? { state: 'closed' }
      : { ...(input.retitle !== undefined && { title: input.retitle }), ...fields };
  await context.runner(['api', endpoint, '--method', 'PATCH', '--input', '-'], change);
}

/**
 * Create, edit, close or delete one milestone once per request ID, then confirm it on GitHub.
 *
 * @param context - Integration.
 * @param input - Requested change with its request ID.
 * @returns The changed milestone, or null after a delete.
 * @throws {MeshError} GITHUB_UNAVAILABLE when GitHub does not show the change afterwards.
 */
export async function manageMilestone(context: MilestoneContext, input: ManageInput): Promise<Change> {
  return runIntent(path.join(context.directory, 'intents', 'milestones'), input.requestId, input, {
    reconcile: async () => observed(await listMilestones(context), input),
    perform: async () => {
      await perform(context, input);
      const confirmed = observed(await listMilestones(context), input);
      if (confirmed === undefined) {
        throw new MeshError(
          'GITHUB_UNAVAILABLE',
          `GitHub does not show the milestone ${input.action} yet; retry the same requestId.`,
        );
      }
      return confirmed;
    },
    result: changeSchema,
  });
}

/**
 * Dispatch one milestone operation.
 *
 * @param context - Integration.
 * @param operation - Which milestone operation: list, assign or manage.
 * @param input - Untrusted input.
 * @returns Its result.
 */
export async function milestoneOperation(
  context: MilestoneContext,
  operation: 'github_milestones' | 'github_milestone_assign' | 'github_milestone_manage',
  input: unknown,
): Promise<unknown> {
  switch (operation) {
    case 'github_milestones': {
      parseInput(operation, input);
      return { milestones: await listMilestones(context) };
    }
    case 'github_milestone_assign': {
      return assignMilestone(context, parseInput(operation, input));
    }
    case 'github_milestone_manage': {
      return manageMilestone(context, parseInput(operation, input));
    }
  }
}
