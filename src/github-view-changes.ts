/**
 * Exact-target changes to the connected Project's saved views. A view is
 * changed under `view-field-change` and deleted under `view-field-delete`,
 * only by the exact view number supplied and after confirming it exists.
 * A live check picks the GraphQL mutation when the schema offers it, else the
 * REST Project view endpoints; when neither does, the change is refused as
 * unsupported. Each change runs as a durable intent reconciled against the
 * views as GitHub reports them.
 *
 * @file
 */
import path from 'node:path';

import { z } from 'zod/v3';

import { runIntent } from './connector-intents.ts';
import { dataOf, readGraphQL } from './github-read.ts';
import {
  VIEW_FIELDS,
  isRestReadable,
  mutationFieldsSchema,
  readViews,
  restEndpoint,
  viewSchema,
} from './github-views.ts';
import { MeshError, parseInput } from './protocol.ts';

import type { ProjectView, ViewContext } from './github-views.ts';
import type { OperationInput } from './protocol.ts';

/** A view change request. */
type ChangeInput = OperationInput<'github_view_manage'>;
/** Result of a view change. */
const resultSchema = z.object({ action: z.enum(['change', 'delete']), view: viewSchema.nullable() });
/** A view change's result. */
type ChangeResult = z.output<typeof resultSchema>;
/** GraphQL mutation each action uses when the schema offers it. */
const MUTATIONS = { change: 'updateProjectV2View', delete: 'deleteProjectV2View' } as const;

/** How a view change can be made. */
type ChangePath =
  | { readonly path: 'graphql' }
  | { readonly path: 'rest'; readonly endpoint: string }
  | { readonly path: 'unsupported'; readonly reason: string };

/**
 * Check, live, how this account can change or delete views.
 *
 * @param context - Connected Project.
 * @param action - Change or delete.
 * @returns The path to use, or unsupported.
 */
async function changePath(context: ViewContext, action: ChangeInput['action']): Promise<ChangePath> {
  const introspection = await readGraphQL(
    context.runner,
    'query { mutations: __type(name: "Mutation") { fields { name } } }',
  );
  const fields = dataOf(introspection, mutationFieldsSchema)?.mutations?.fields ?? [];
  if (fields.some((field) => field.name === MUTATIONS[action])) {
    return { path: 'graphql' };
  }
  const endpoint = await restEndpoint(context);
  return endpoint !== null && (await isRestReadable(context, endpoint))
    ? { path: 'rest', endpoint }
    : {
        path: 'unsupported',
        reason: `GitHub offers neither ${MUTATIONS[action]} nor the REST view endpoints to this account.`,
      };
}

/**
 * The current views, read through the same path the change will use.
 *
 * @param context - Connected Project.
 * @param via - Change path; never unsupported.
 * @returns Saved views.
 */
async function currentViews(
  context: ViewContext,
  via: Exclude<ChangePath, { path: 'unsupported' }>,
): Promise<ProjectView[]> {
  return readViews(context, via.path === 'rest' ? via : { path: 'graphql', canCreate: false });
}

/**
 * The change's result if GitHub already shows it.
 *
 * @param views - Current views.
 * @param input - Requested change.
 * @returns Result when visible, otherwise undefined.
 */
function observed(views: readonly ProjectView[], input: ChangeInput): ChangeResult | undefined {
  const target = views.find((view) => view.number === input.viewNumber);
  if (input.action === 'delete') {
    return target === undefined ? { action: 'delete', view: null } : undefined;
  }
  const isRenamed = input.name === undefined || target?.name === input.name;
  const isLaidOut = input.layout === undefined || target?.layout.toLowerCase().startsWith(input.layout) === true;
  return target !== undefined && isRenamed && isLaidOut ? { action: 'change', view: target } : undefined;
}

/**
 * Make the change on GitHub.
 *
 * @param context - Connected Project.
 * @param via - Change path.
 * @param input - Requested change.
 * @param target - The exact existing view.
 */
async function perform(
  context: ViewContext,
  via: Exclude<ChangePath, { path: 'unsupported' }>,
  input: ChangeInput,
  target: ProjectView,
): Promise<void> {
  const changes = {
    ...(input.name !== undefined && { name: input.name }),
    ...(input.layout !== undefined && {
      layout: via.path === 'rest' ? input.layout : `${input.layout.toUpperCase()}_LAYOUT`,
    }),
  };
  if (via.path === 'rest') {
    const endpoint = `${via.endpoint}/${String(target.number)}`;
    await (input.action === 'delete'
      ? context.runner(['api', endpoint, '--method', 'DELETE'])
      : context.runner(['api', endpoint, '--method', 'PATCH', '--input', '-'], changes));
    return;
  }
  const mutation = MUTATIONS[input.action];
  const query = `mutation($input: ${mutation.charAt(0).toUpperCase()}${mutation.slice(1)}Input!) { ${mutation}(input: $input) { projectV2View { ${VIEW_FIELDS} } } }`;
  const variables = { input: { viewId: target.id, ...(input.action === 'change' && changes) } };
  await context.runner(['api', 'graphql', '--input', '-'], { query, variables });
}

/**
 * Change or delete one saved view by its exact number, once per request ID.
 *
 * @param context - Connected Project.
 * @param input - Requested change with its request ID.
 * @returns The changed view, or null after a delete.
 * @throws {MeshError} CAPABILITY_DENIED when unsupported; INVALID_INPUT for an unknown view.
 */
export async function manageView(context: ViewContext, input: ChangeInput): Promise<ChangeResult> {
  const via = await changePath(context, input.action);
  if (via.path === 'unsupported') {
    throw new MeshError(
      'CAPABILITY_DENIED',
      `Views cannot be ${input.action === 'delete' ? 'deleted' : 'changed'} here: ${via.reason}`,
    );
  }
  return runIntent(path.join(context.directory, 'intents', 'view-changes'), input.requestId, input, {
    reconcile: async () => observed(await currentViews(context, via), input),
    perform: async () => {
      const views = await currentViews(context, via);
      const target = views.find((view) => view.number === input.viewNumber);
      if (target === undefined) {
        throw new MeshError(
          'INVALID_INPUT',
          `No saved view ${String(input.viewNumber)} exists on the connected Project.`,
        );
      }
      await perform(context, via, input, target);
      const confirmed = observed(await currentViews(context, via), input);
      if (confirmed === undefined) {
        throw new MeshError(
          'GITHUB_UNAVAILABLE',
          'GitHub does not show the view change yet; retry the same requestId.',
        );
      }
      return confirmed;
    },
    result: resultSchema,
  });
}

/**
 * Dispatch the view change operation.
 *
 * @param context - Connected Project.
 * @param input - Untrusted input.
 * @returns Its result.
 */
export async function viewChangeOperation(context: ViewContext, input: unknown): Promise<unknown> {
  return manageView(context, parseInput('github_view_manage', input));
}
