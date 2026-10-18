/**
 * Saved views of the connected Project. Before any read or create, a live
 * check decides how this account and Project expose views: GraphQL
 * (`views` and `createProjectV2View`), the REST Project view endpoints, or
 * neither, which is reported as unsupported rather than assumed. Reading is
 * `view-field-read`; creating is `view-field-create`, runs as a durable intent
 * reconciled by view name, and never modifies existing views or fields.
 *
 * @file
 */
import path from 'node:path';

import { z } from 'zod/v3';

import { runIntent } from './connector-intents.ts';
import { dataOf, readGraphQL } from './github-read.ts';
import { MeshError, parseInput } from './protocol.ts';

import type { GitHubRunner } from './github-runner.ts';
import type { OperationInput } from './protocol.ts';

/** Views read in one page. */
const VIEW_LIMIT = 50;
/** Fields read for each view. */
export const VIEW_FIELDS = 'id number name layout';

/** One saved view. */
export const viewSchema = z.object({
  id: z.union([z.string(), z.number()]),
  number: z.number().int(),
  name: z.string(),
  layout: z.string(),
});
/** A saved Project view. */
export type ProjectView = z.output<typeof viewSchema>;
/** View page under a Project node. */
const viewPageSchema = z.object({ nodes: z.array(viewSchema) });
/** `node.views` for a Project. */
const projectViewsSchema = z.object({ node: z.object({ views: viewPageSchema }) });
/** One mutation name from introspection. */
const mutationFieldSchema = z.object({ name: z.string() });
/** Mutation type fields, aliased so no response field starts with an underscore. */
const mutationTypeSchema = z.object({ fields: z.array(mutationFieldSchema) });
/** Mutation names from introspection. */
export const mutationFieldsSchema = z.object({ mutations: mutationTypeSchema.nullable() });
/** Owner kind, aliased from `__typename`. */
const ownerKindSchema = z.object({ repositoryOwner: z.object({ kind: z.enum(['Organization', 'User']) }).nullable() });
/** REST view list. */
const restViewsSchema = z.array(viewSchema);
/** GraphQL create response. */
const viewCreationResponseSchema = z.object({
  data: z.object({ createProjectV2View: z.object({ projectV2View: viewSchema }) }),
});
/** Result of a view create. */
const createdSchema = z.object({ path: z.enum(['graphql', 'rest']), view: viewSchema });

/** The connected Project a view belongs to. */
export interface ViewContext {
  /** GitHub CLI seam. */
  readonly runner: GitHubRunner;
  /** This project's private GitHub integration directory. */
  readonly directory: string;
  /** Project owner login. */
  readonly owner: string;
  /** Project node ID. */
  readonly projectId: string;
  /** Project number. */
  readonly projectNumber: number;
}

/** How this account and Project expose views. */
export type ViewSupport =
  | { readonly path: 'graphql'; readonly canCreate: boolean }
  | { readonly path: 'rest'; readonly endpoint: string }
  | { readonly path: 'unsupported'; readonly reason: string };

/**
 * The REST endpoint for the Project's views, when the owner kind can be read.
 *
 * @param context - Connected Project.
 * @returns Endpoint path, or null.
 */
export async function restEndpoint(context: ViewContext): Promise<string | null> {
  const result = await readGraphQL(
    context.runner,
    'query($login: String!) { repositoryOwner(login: $login) { kind: __typename } }',
    { login: context.owner },
  );
  const owner = dataOf(result, ownerKindSchema)?.repositoryOwner;
  if (owner === undefined || owner === null) {
    return null;
  }
  const scope = owner.kind === 'Organization' ? 'orgs' : 'users';
  return `${scope}/${context.owner}/projectsV2/${String(context.projectNumber)}/views`;
}

/**
 * Whether the REST view list answers for this account.
 *
 * @param context - Connected Project.
 * @param endpoint - REST view list path.
 * @returns True when it returns a view list.
 */
export async function isRestReadable(context: ViewContext, endpoint: string): Promise<boolean> {
  try {
    restViewsSchema.parse(await context.runner(['api', endpoint]));
    return true;
  } catch {
    return false;
  }
}

/**
 * Check, live, how views can be read and created for this account and Project.
 *
 * @param context - Connected Project.
 * @returns Supported path, or unsupported with the reason.
 */
export async function viewSupport(context: ViewContext): Promise<ViewSupport> {
  const read = await readGraphQL(
    context.runner,
    `query($id: ID!) { node(id: $id) { ... on ProjectV2 { views(first: 1) { nodes { ${VIEW_FIELDS} } } } } }`,
    { id: context.projectId },
  );
  if ('data' in read) {
    const introspection = await readGraphQL(
      context.runner,
      'query { mutations: __type(name: "Mutation") { fields { name } } }',
    );
    const fields = dataOf(introspection, mutationFieldsSchema)?.mutations?.fields ?? [];
    return { path: 'graphql', canCreate: fields.some((field) => field.name === 'createProjectV2View') };
  }
  const endpoint = await restEndpoint(context);
  if (endpoint !== null && (await isRestReadable(context, endpoint))) {
    return { path: 'rest', endpoint };
  }
  const reason = `Neither GraphQL nor REST exposes views of Project ${String(context.projectNumber)} to this account.`;
  return { path: 'unsupported', reason };
}

/**
 * List the Project's saved views through a supported path.
 *
 * @param context - Connected Project.
 * @param support - Result of the live check; never unsupported.
 * @returns Saved views.
 */
export async function readViews(
  context: ViewContext,
  support: Exclude<ViewSupport, { path: 'unsupported' }>,
): Promise<ProjectView[]> {
  if (support.path === 'rest') {
    return restViewsSchema.parse(await context.runner(['api', support.endpoint]));
  }
  const result = await readGraphQL(
    context.runner,
    `query($id: ID!) { node(id: $id) { ... on ProjectV2 { views(first: ${String(VIEW_LIMIT)}) { nodes { ${VIEW_FIELDS} } } } } }`,
    { id: context.projectId },
  );
  return dataOf(result, projectViewsSchema)?.node.views.nodes ?? [];
}

/**
 * List saved views, after the live capability check.
 *
 * @param context - Connected Project.
 * @returns Support and views; unsupported lists none.
 */
export async function listViews(context: ViewContext): Promise<{ support: ViewSupport; views: ProjectView[] }> {
  const support = await viewSupport(context);
  return { support, views: support.path === 'unsupported' ? [] : await readViews(context, support) };
}

/**
 * Make the create call on the supported path.
 *
 * @param context - Connected Project.
 * @param support - Creatable path.
 * @param input - View name and layout.
 * @returns The created view.
 */
async function postView(
  context: ViewContext,
  support: Exclude<ViewSupport, { path: 'unsupported' }>,
  input: OperationInput<'github_view_create'>,
): Promise<ProjectView> {
  if (support.path === 'rest') {
    const body = { name: input.name, layout: input.layout };
    return viewSchema.parse(await context.runner(['api', support.endpoint, '--method', 'POST', '--input', '-'], body));
  }
  const query = `mutation($input: CreateProjectV2ViewInput!) { createProjectV2View(input: $input) { projectV2View { ${VIEW_FIELDS} } } }`;
  const layout = `${input.layout.toUpperCase()}_LAYOUT`;
  const variables = { input: { projectId: context.projectId, name: input.name, layout } };
  const response = viewCreationResponseSchema.parse(
    await context.runner(['api', 'graphql', '--input', '-'], { query, variables }),
  );
  return response.data.createProjectV2View.projectV2View;
}

/**
 * Create one view, reconciled by name so a lost response yields one view.
 *
 * @param context - Connected Project.
 * @param input - View name, layout and request ID.
 * @returns The created or adopted view and the path used.
 * @throws {MeshError} CAPABILITY_DENIED when this account cannot create views on the Project.
 */
export async function createView(
  context: ViewContext,
  input: OperationInput<'github_view_create'>,
): Promise<z.output<typeof createdSchema>> {
  const support = await viewSupport(context);
  if (support.path === 'unsupported') {
    throw new MeshError('CAPABILITY_DENIED', `Views cannot be created here: ${support.reason}`);
  }
  if (support.path === 'graphql' && !support.canCreate) {
    throw new MeshError(
      'CAPABILITY_DENIED',
      'Views cannot be created here: GitHub does not offer createProjectV2View.',
    );
  }
  return runIntent(path.join(context.directory, 'intents', 'views'), input.requestId, input, {
    reconcile: async () => {
      const views = await readViews(context, support);
      const found = views.find((view) => view.name === input.name);
      return found === undefined ? undefined : { path: support.path, view: found };
    },
    perform: async () => ({ path: support.path, view: await postView(context, support, input) }),
    result: createdSchema,
  });
}

/**
 * Dispatch one view operation.
 *
 * @param context - Connected Project.
 * @param operation - Which view operation: list or create.
 * @param input - Untrusted input.
 * @returns Its result.
 */
export async function viewOperation(
  context: ViewContext,
  operation: 'github_views' | 'github_view_create',
  input: unknown,
): Promise<unknown> {
  if (operation === 'github_views') {
    parseInput(operation, input);
    return listViews(context);
  }
  return createView(context, parseInput(operation, input));
}
