/** @file Bounded read-only native issue corpus, fenced by verified repository node identity. */
import { createHash } from 'node:crypto';

import { z } from 'zod/v3';

import { MeshError } from './protocol.ts';

import type { SourceConnection } from './connector.ts';

/** Finite pages; the native runner independently enforces its response byte ceiling. */
const PAGE_MAX = 10;
/** Native nested relationships are independently bounded and report truncation. */
const RELATED_MAX = 100;
/** GitHub issue bodies are bounded before observation or hashing. */
const BODY_MAX = 65_536;
/** Native titles and identifiers are finite. */
const ID_MAX = 256;
/** Opaque GitHub cursor bound. */
const CURSOR_MAX = 1024;
/** Native issue URLs are bounded and cannot become executable or foreign links. */
const URL_MAX = 2048;
/** Canonical GitHub links, never credentials or another origin. */
const issueUrlSchema = z
  .string()
  .url()
  .max(URL_MAX)
  .refine((value) => {
    const url = new URL(value);
    return url.origin === 'https://github.com' && url.username === '' && url.password === '';
  });
/** Default recent-closed horizon; retained in the continuation cursor. */
const RECENT_MS = 2_592_000_000;
/** SHA-256 hex observation address. */
const REVISION_LENGTH = 64;
/** Stable native relation identity, including foreign-repository parents/children. */
const relationSchema = z.object({
  id: z.string().min(1).max(ID_MAX),
  number: z.number().int().safe().positive(),
  repository: z.object({ id: z.string().min(1).max(ID_MAX) }),
});
/** Bounded label and relation envelopes avoid nested unvalidated objects. */
const labelSchema = z.object({ name: z.string().max(ID_MAX) });
/** Native relationship completeness metadata. */
const relationPageInfo = z.object({ hasNextPage: z.boolean() });
/** Finite issue labels. */
const labelConnectionSchema = z.object({ nodes: z.array(labelSchema).max(RELATED_MAX), pageInfo: relationPageInfo });
/** Finite native child identities. */
const relationConnectionSchema = z.object({
  nodes: z.array(relationSchema).max(RELATED_MAX),
  pageInfo: relationPageInfo,
});
/** Native issue fields only; a PR is never interpreted as an issue. */
const nativeIssueSchema = relationSchema.extend({
  __typename: z.literal('Issue'),
  title: z.string().max(ID_MAX),
  body: z.string().max(BODY_MAX),
  url: issueUrlSchema,
  state: z.enum(['OPEN', 'CLOSED']),
  stateReason: z.string().max(ID_MAX).nullable(),
  updatedAt: z.string().datetime(),
  closedAt: z.string().datetime().nullable(),
  parent: relationSchema.nullable(),
  labels: labelConnectionSchema,
  subIssues: relationConnectionSchema,
});
/** Canonical observed issue, with honest nested-relationship completeness. */
export const observedIssueSchema = z.object({
  repositoryId: z.string().min(1).max(ID_MAX),
  id: z.string().min(1).max(ID_MAX),
  number: z.number().int().safe().positive(),
  title: z.string().max(ID_MAX),
  body: z.string().max(BODY_MAX),
  url: issueUrlSchema,
  state: z.enum(['open', 'closed']),
  stateReason: z.string().max(ID_MAX).nullable(),
  updatedAt: z.string().datetime(),
  closedAt: z.string().datetime().nullable(),
  parent: relationSchema.nullable(),
  children: z.array(relationSchema).max(RELATED_MAX),
  labels: z.array(z.string().max(ID_MAX)).max(RELATED_MAX),
  complete: z.boolean(),
  revision: z.string().length(REVISION_LENGTH),
});
/** Public issue observation; the revision covers exactly the retained canonical fields. */
export type ObservedIssue = z.output<typeof observedIssueSchema>;
/** Cross-page scope and cutoff are explicit, never an unscoped cursor string. */
const cursorSchema = z
  .object({
    repositoryId: z.string().min(1).max(ID_MAX),
    phase: z.enum(['open', 'closed']),
    after: z.string().min(1).max(CURSOR_MAX).nullable(),
    closedSince: z.number().int().safe().positive(),
    hasTruncatedItems: z.boolean(),
  })
  .strict();
/** Bounded page request; callers decide how many pages their intake budget permits. */
const pageInputSchema = z
  .object({
    limit: z.number().int().min(1).max(PAGE_MAX).default(PAGE_MAX),
    cursor: cursorSchema.nullable().optional(),
    closedSince: z.number().int().safe().positive().optional(),
  })
  .strict();
/** Explicit continuation and coverage, including earlier nested truncation. */
export interface IssueCorpusPage {
  /** Stable selected repository node identity. */
  repositoryId: string;
  /** Only this page's issue observations. */
  items: ObservedIssue[];
  /** Continue with the same cutoff, or null after both issue phases finish. */
  nextCursor: z.output<typeof cursorSchema> | null;
  /** True only after both phases finish without observed nested truncation. */
  complete: boolean;
}
/** Existing shell-free authenticated GraphQL transport, injectable for fixtures. */
export type IssueQuery = (query: string, variables: Record<string, unknown>) => Promise<unknown>;
/** Reused static selection; no untrusted text is interpolated into GraphQL. */
const FIELDS =
  '__typename id number title body url state stateReason updatedAt closedAt repository{id} parent{id number repository{id}} labels(first:100){nodes{name} pageInfo{hasNextPage}} subIssues(first:100){nodes{id number repository{id}} pageInfo{hasNextPage}}';
/** Both phases use the repository issue connection, excluding pull requests by construction. */
const PAGE_QUERY = `query MaltIssueCorpus($id:ID!,$states:[IssueState!]!,$limit:Int!,$after:String){node(id:$id){... on Repository{id issues(states:$states,first:$limit,after:$after,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{${FIELDS}} pageInfo{hasNextPage endCursor}}}}}`;
/** Re-read within the same repository node, not a global issue/PR lookup. */
const ONE_QUERY = `query MaltObservedIssue($id:ID!,$number:Int!){node(id:$id){... on Repository{id issue(number:$number){${FIELDS}}}}}`;
/** Explicit native cursor progress. */
const pageInfoSchema = z.object({ hasNextPage: z.boolean(), endCursor: z.string().min(1).max(CURSOR_MAX).nullable() });
/** Bounded issue page within the verified repository. */
const issuePageSchema = z.object({ nodes: z.array(nativeIssueSchema).max(PAGE_MAX), pageInfo: pageInfoSchema });
/** Repository node envelope, absent for inaccessible or deleted sources. */
const repositoryPageSchema = z.object({ id: z.string(), issues: issuePageSchema });
/** Validate the page before iterating or retaining any response data. */
const pageSchema = z.object({ node: repositoryPageSchema.nullable() });
/** Single native issue lookup; a PR or missing issue cannot become an empty record. */
const repositoryIssueSchema = z.object({ id: z.string(), issue: nativeIssueSchema.nullable() });
/** Nullable repository identity reports unavailable access explicitly. */
const oneSchema = z.object({ node: repositoryIssueSchema.nullable() });

/**
 * Canonicalize one exact observation; set ordering cannot create false revisions.
 *
 * @param issue - Validated native issue fields.
 * @param repositoryId - Verified selected repository node.
 * @returns Immutable observed fields and deterministic content address.
 * @throws {MeshError} For a transferred/foreign issue.
 */
function observe(issue: z.output<typeof nativeIssueSchema>, repositoryId: string): ObservedIssue {
  if (issue.repository.id !== repositoryId) {
    throw new MeshError('WRONG_PROJECT', 'The issue belongs to another repository. Refresh the selected connection.');
  }
  const content = {
    repositoryId,
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    url: issue.url,
    state: issue.state === 'OPEN' ? 'open' : 'closed',
    stateReason: issue.stateReason,
    updatedAt: issue.updatedAt,
    closedAt: issue.closedAt,
    parent: issue.parent,
    children: issue.subIssues.nodes.toSorted((a, b) => a.id.localeCompare(b.id)),
    labels: issue.labels.nodes.map((label) => label.name).toSorted((a, b) => a.localeCompare(b, 'en')),
    complete: !issue.labels.pageInfo.hasNextPage && !issue.subIssues.pageInfo.hasNextPage,
  };
  return observedIssueSchema.parse({
    ...content,
    revision: createHash('sha256').update(JSON.stringify(content)).digest('hex'),
  });
}

/**
 * Scope continuation and cutoff without trusting another repository's cursor.
 *
 * @param repositoryId - Verified selected node.
 * @param request - Validated bounded page request.
 * @returns Current ordered traversal position.
 * @throws {MeshError} For a foreign cursor or changed cutoff.
 */
function requestScope(repositoryId: string, request: z.output<typeof pageInputSchema>): z.output<typeof cursorSchema> {
  const { cursor } = request;
  if (cursor !== undefined && cursor !== null && cursor.repositoryId !== repositoryId) {
    throw new MeshError('WRONG_PROJECT', 'The issue cursor belongs to another selected repository.');
  }
  const scope = cursor ?? {
    repositoryId,
    phase: 'open',
    after: null,
    closedSince: request.closedSince ?? Date.now() - RECENT_MS,
    hasTruncatedItems: false,
  };
  if (request.closedSince !== undefined && request.closedSince !== scope.closedSince) {
    throw new MeshError('INVALID_INPUT', 'A continuation must retain its original recent-closed cutoff.');
  }
  return cursorSchema.parse(scope);
}

/**
 * Reject malformed native pages before advancing an unpaid intake traversal.
 *
 * @param scope - Current repository/phase/cursor.
 * @param limit - Requested bounded page size.
 * @param page - Validated native response.
 * @throws {MeshError} For repeated cursors, oversize pages or wrong lifecycle state.
 */
function assertNativePage(
  scope: z.output<typeof cursorSchema>,
  limit: number,
  page: z.output<typeof issuePageSchema>,
): void {
  const expected = scope.phase === 'open' ? 'OPEN' : 'CLOSED';
  const { nodes, pageInfo } = page;
  const isRepeated = pageInfo.hasNextPage && (pageInfo.endCursor === null || pageInfo.endCursor === scope.after);
  if (isRepeated || nodes.length > limit || nodes.some((issue) => issue.state !== expected)) {
    throw new MeshError(
      'GITHUB_UNAVAILABLE',
      'GitHub returned invalid issue pagination; no complete corpus was reported.',
    );
  }
}

/**
 * Preserve coverage and phase continuation without loading an unbounded corpus.
 *
 * @param scope - Exact current traversal position.
 * @param page - Validated, progress-checked native page.
 * @returns Page observations and explicit remaining range.
 */
function corpusResult(scope: z.output<typeof cursorSchema>, page: z.output<typeof issuePageSchema>): IssueCorpusPage {
  const { nodes, pageInfo } = page;
  const isClosed = scope.phase === 'closed';
  const isAtCutoff = isClosed && nodes.some((issue) => Date.parse(issue.updatedAt) < scope.closedSince);
  const observed = nodes.map((issue) => observe(issue, scope.repositoryId));
  const items = isClosed
    ? observed.filter((issue) => issue.closedAt !== null && Date.parse(issue.closedAt) >= scope.closedSince)
    : observed;
  const hasTruncatedItems = scope.hasTruncatedItems || items.some((issue) => !issue.complete);
  let nextCursor: IssueCorpusPage['nextCursor'] = null;
  if (!isAtCutoff && pageInfo.hasNextPage) {
    nextCursor = { ...scope, after: pageInfo.endCursor, hasTruncatedItems };
  } else if (!isClosed) {
    nextCursor = { ...scope, phase: 'closed', after: null, hasTruncatedItems };
  }
  return { repositoryId: scope.repositoryId, items, nextCursor, complete: nextCursor === null && !hasTruncatedItems };
}

/**
 * Read one finite page of open, then recently closed native issues.
 *
 * @param query - Existing project-authenticated native boundary.
 * @param repositoryId - Verified selected repository node ID.
 * @param input - Bounded request and returned scoped continuation.
 * @returns Current page and continuation; callers must retain all pages for coverage.
 * @throws {MeshError} For unavailable repositories or invalid native pagination.
 */
export async function readIssueCorpus(
  query: IssueQuery,
  repositoryId: string,
  input: unknown,
): Promise<IssueCorpusPage> {
  const request = pageInputSchema.parse(input);
  const scope = requestScope(repositoryId, request);
  const { node } = pageSchema.parse(
    await query(PAGE_QUERY, {
      id: repositoryId,
      states: [scope.phase === 'open' ? 'OPEN' : 'CLOSED'],
      limit: request.limit,
      after: scope.after,
    }),
  );
  if (node?.id !== repositoryId) {
    throw new MeshError(
      'GITHUB_UNAVAILABLE',
      'The selected repository is unavailable. Check authentication and repository access.',
    );
  }
  assertNativePage(scope, request.limit, node.issues);
  return corpusResult(scope, node.issues);
}

/**
 * Re-read a ticket's current observed revision before a consequential decision.
 *
 * @param query - Existing authenticated native boundary.
 * @param repositoryId - Verified selected repository node.
 * @param number - Repository-local issue number, never a PR lookup.
 * @returns Current bounded issue observation.
 * @throws {MeshError} For a missing, transferred or inaccessible issue.
 */
export async function readObservedIssue(
  query: IssueQuery,
  repositoryId: string,
  number: number,
): Promise<ObservedIssue> {
  const issue = z.number().int().safe().positive().parse(number);
  const { node } = oneSchema.parse(await query(ONE_QUERY, { id: repositoryId, number: issue }));
  if (node?.id !== repositoryId || node.issue?.number !== issue) {
    throw new MeshError(
      'NOT_FOUND',
      'The selected issue is missing or inaccessible; refresh repository permissions and scope.',
    );
  }
  return observe(node.issue, repositoryId);
}

/** Selected-source reader capabilities; no mutation or scheduler authority. */
export interface IssueReader {
  /** Read one scoped, bounded page. */
  readonly page: (input: unknown) => Promise<IssueCorpusPage>;
  /** Refresh the exact native issue revision. */
  readonly get: (number: number) => Promise<ObservedIssue>;
}

/**
 * Bind read capabilities to the current verified source without copying credentials.
 *
 * @param query - Existing authenticated transport.
 * @param source - Selected project's verified source metadata.
 * @returns Read-only repository-fenced capabilities.
 * @throws {MeshError} Until connection setup verifies the source node.
 */
export function createIssueReader(
  query: IssueQuery,
  source: Pick<SourceConnection, 'repositoryId' | 'verifiedAt'>,
): IssueReader {
  const { repositoryId } = source;
  if (repositoryId === null || source.verifiedAt === null) {
    throw new MeshError(
      'GITHUB_NOT_CONNECTED',
      'Reconnect the selected repository to verify its source node before reading the issue corpus.',
    );
  }
  return {
    page: async (input) => readIssueCorpus(query, repositoryId, input),
    get: async (number) => readObservedIssue(query, repositoryId, number),
  };
}
