/**
 * Bounded native Project pages without the CLI's oversized nested item query.
 *
 * @file
 */
import { z } from 'zod';

import { hasErrorCode, readJsonFile } from './config.ts';
import { MeshError } from './protocol.ts';

/** Maximum native connection page size. */
const PAGE_SIZE = 100;
/** Avoid polling the same board on every scheduler tick. */
const CACHE_MS = 120_000;
/** Maximum explicit board snapshot window. */
const BOARD_MAX = 1000;
/** Bounded validated cached item records. */
const cachedItemsSchema = z.array(z.record(z.unknown())).max(BOARD_MAX);
/** Derived cache must belong to this exact Project and workflow field. */
const cacheSchema = z.object({
  projectId: z.string(),
  statusFieldId: z.string(),
  items: cachedItemsSchema,
  totalCount: z.number().int().nonnegative(),
  complete: z.boolean(),
  fetchedAt: z.string().datetime(),
  pendingOperations: z.array(z.unknown()),
});

/** A narrowly selected remote single-select value. */
const valueSchema = z.object({
  name: z.string().optional(),
  field: z.object({ id: z.string(), name: z.string() }).optional(),
});
/** Supported issue/PR/draft content; null denotes inaccessible content. */
const contentSchema = z
  .object({
    type: z.string(),
    number: z.number().optional(),
    title: z.string(),
    body: z.string(),
    url: z.string().optional(),
  })
  .nullable();
/** Selected single-select values attached to one item. */
const fieldValuesSchema = z.object({ nodes: z.array(valueSchema) });
/** Validated native content and field values. */
const itemSchema = z.object({ id: z.string(), content: contentSchema, fieldValues: fieldValuesSchema });
/** Native connection cursor without client authority. */
const pageInfoSchema = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() });
/** Bounded native connection page. */
const itemsPageSchema = z.object({
  nodes: z.array(itemSchema),
  totalCount: z.number().int().nonnegative(),
  pageInfo: pageInfoSchema,
});
/** Selected Project node. */
const projectNodeSchema = z.object({ items: itemsPageSchema });
/** Page boundary before any remote data becomes a local board snapshot. */
const pageSchema = z.object({ node: projectNodeSchema });
/** Only the content and selected workflow value needed by delivery import. */
const QUERY = `query($id:ID!,$first:Int!,$after:String) {
  node(id:$id) { ... on ProjectV2 { items(first:$first,after:$after) {
    totalCount pageInfo { hasNextPage endCursor }
    nodes { id content {
      type: __typename
      ... on Issue { number title body url }
      ... on PullRequest { number title body url }
      ... on DraftIssue { title body }
    } fieldValues(first:50) { nodes {
      ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2SingleSelectField { id name } } }
    } } }
  } } }
}`;

/**
 * Page a Project through the authenticated native GraphQL boundary.
 *
 * @param request - Selected Project, field identity and bounded caller limit.
 * @returns CLI-compatible content with an unambiguous selected workflow value.
 * @throws {MeshError} For malformed or nonadvancing native pagination.
 */
export async function readBoard(request: {
  project: string;
  field: string;
  limit: number;
  graphql: (query: string, variables: Record<string, unknown>) => Promise<unknown>;
}): Promise<{ items: Record<string, unknown>[]; totalCount: number }> {
  const items: Record<string, unknown>[] = [];
  let after: string | null = null;
  let totalCount: number;
  do {
    const first = Math.min(PAGE_SIZE, request.limit - items.length);
    // eslint-disable-next-line no-await-in-loop -- Each bounded page depends on the verified native cursor of the previous page.
    const raw = await request.graphql(QUERY, { id: request.project, first, after });
    const page: z.output<typeof pageSchema>['node']['items'] = pageSchema.parse(raw).node.items;
    totalCount = page.totalCount;
    for (const item of page.nodes) {
      const selected = item.fieldValues.nodes.find((value) => value.field?.id === request.field);
      items.push({
        id: item.id,
        content: item.content,
        mltStatus: selected?.name,
      });
    }
    if (!page.pageInfo.hasNextPage || items.length >= request.limit) {
      break;
    }
    if (page.nodes.length === 0 || page.pageInfo.endCursor === null || page.pageInfo.endCursor === after) {
      throw new MeshError('GITHUB_UNAVAILABLE', 'GitHub Project pagination did not advance.');
    }
    after = page.pageInfo.endCursor;
  } while (items.length < request.limit);
  return { items, totalCount };
}

/**
 * Reuse only a recent sufficient derived board window for automatic import.
 *
 * @param file - Known project-local board cache.
 * @param project - Selected Project identity.
 * @param field - Selected workflow field identity.
 * @param limit - Required bounded window size.
 * @returns Recent snapshot, absent when a fresh read is needed.
 * @throws {Error} For an unreadable derived cache other than a missing file.
 */
export function cachedBoard(file: string, project: string, field: string, limit: number): unknown {
  let raw: unknown;
  try {
    raw = readJsonFile(file);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return undefined;
    }
    throw error;
  }
  const parsed = cacheSchema.safeParse(raw);
  if (!parsed.success) {
    return undefined;
  }
  const cache = parsed.data;
  const age = Date.now() - Date.parse(cache.fetchedAt);
  return cache.projectId !== project ||
    cache.statusFieldId !== field ||
    age < 0 ||
    age >= CACHE_MS ||
    cache.items.length < Math.min(limit, cache.totalCount) ||
    cache.pendingOperations.length > 0
    ? undefined
    : { ...cache, items: cache.items.slice(0, limit), complete: limit >= cache.totalCount, cached: true };
}
