/**
 * Bounded native issue corpus and freshness reads.
 *
 * @file
 */
import { createHash } from 'node:crypto';

import { z } from 'zod';

import { MeshError } from './protocol.ts';

import type { GitHubRunner } from './github.ts';

/** Explicit request and field ceilings. */
const CORPUS_LIMITS = { id: 200, page: 100, defaultPage: 50, cursor: 1000, title: 1024, body: 100_000, label: 256 };
/** Bounded label shape. */
const corpusLabel = z.object({ name: z.string().max(CORPUS_LIMITS.label) });

/** Bounded intake scan settings; cursors belong to the verified repository. */
export const issueCorpusInput = z.object({
  repositoryId: z.string().min(1).max(CORPUS_LIMITS.id),
  closedSince: z.string().datetime(),
  first: z.number().int().min(1).max(CORPUS_LIMITS.page).default(CORPUS_LIMITS.defaultPage),
  after: z.string().min(1).max(CORPUS_LIMITS.cursor).nullable().default(null),
});
/** Native pagination metadata. */
const issuePageInfo = z.object({
  hasNextPage: z.boolean(),
  endCursor: z.string().max(CORPUS_LIMITS.cursor).nullable(),
});
/** Native issue links retain node IDs, including cross-repository parents. */
const issueLink = z.object({ id: z.string().min(1).max(CORPUS_LIMITS.id), number: z.number().int().positive() });
/** Full relevant fields; overlarge responses fail rather than silently hashing prefixes. */
const observedIssueSchema = issueLink.extend({
  title: z.string().max(CORPUS_LIMITS.title),
  body: z.string().max(CORPUS_LIMITS.body),
  state: z.enum(['OPEN', 'CLOSED']),
  updatedAt: z.string().datetime(),
  closedAt: z.string().datetime().nullable(),
  repository: z.object({ id: z.string() }),
  parent: issueLink.nullable(),
  labels: z.object({ nodes: z.array(corpusLabel).max(CORPUS_LIMITS.page), pageInfo: issuePageInfo }),
  subIssues: z.object({ nodes: z.array(issueLink).max(CORPUS_LIMITS.page), pageInfo: issuePageInfo }),
});
/** Fixed selection never incorporates issue text. */
const OBSERVED_ISSUE_FIELDS = `id number title body state updatedAt closedAt repository { id }
  parent { id number } labels(first:100) { nodes { name } pageInfo { hasNextPage endCursor } }
  subIssues(first:100) { nodes { id number } pageInfo { hasNextPage endCursor } }`;
/** Relevant immutable snapshot and exact revision, absent if link pagination is incomplete. */
export interface ObservedIssue {
  /** Snapshot id. */
  id: string;
  /** Snapshot number. */
  number: number;
  /** Snapshot title. */
  title: string;
  /** Snapshot body. */
  body: string;
  /** Snapshot state. */
  state: 'OPEN' | 'CLOSED';
  /** Snapshot updatedAt. */
  updatedAt: string;
  /** Snapshot labels. */
  labels: string[];
  /** Snapshot parent. */
  parent: z.output<typeof issueLink> | null;
  /** Snapshot children. */
  children: z.output<typeof issueLink>[];
  /** Snapshot revision. */
  revision: string | null;
}
/** One bounded native page, including explicit completeness and continuation. */
export interface IssueCorpusPage {
  /** Snapshot repositoryId. */
  repositoryId: string;
  /** Snapshot items. */
  items: ObservedIssue[];
  /** Snapshot nextCursor. */
  nextCursor: string | null;
  /** Snapshot complete. */
  complete: boolean;
}

/**
 * Normalize unordered sets before hashing all freshness-relevant fields.
 *
 * @param issue - Validated native snapshot.
 * @returns Inert issue data with a revision only for a complete snapshot.
 */
function observeIssue(issue: z.output<typeof observedIssueSchema>): ObservedIssue {
  const snapshot = {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    updatedAt: issue.updatedAt,
    labels: [...new Set(issue.labels.nodes.map((label) => label.name))].toSorted((left, right) =>
      left.localeCompare(right),
    ),
    parent: issue.parent,
    children: issue.subIssues.nodes.toSorted((left, right) => left.id.localeCompare(right.id)),
  };
  return {
    ...snapshot,
    revision:
      issue.labels.pageInfo.hasNextPage || issue.subIssues.pageInfo.hasNextPage
        ? null
        : createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'),
  };
}

/**
 * Read one issue-only page or one current issue using a verified repository node.
 *
 * @param runner - Bounded CLI or fixture runner.
 * @param repository - Connected repository name, never issue-provided text.
 * @param input - Page policy and expected stable repository identity.
 * @param number - Optional issue number for a freshness read.
 * @returns Bounded snapshot page; unavailable issues fail with a fixed message.
 * @throws {MeshError} If identity, permissions, data or pagination cannot be verified.
 */
export async function readIssueCorpus(
  runner: GitHubRunner,
  repository: string,
  input: z.input<typeof issueCorpusInput>,
  number?: number,
): Promise<IssueCorpusPage> {
  const settings = issueCorpusInput.parse(input);
  if (number !== undefined) {
    z.number().int().positive().parse(number);
  }
  try {
    return await readVerifiedIssues(runner, repository, settings, number);
  } catch {
    throw new MeshError(
      'GITHUB_UNAVAILABLE',
      'Issue read unavailable: not found, transferred, incomplete or permission denied.',
    );
  }
}

/**
 * Fetch and validate one native response after input validation.
 *
 * @param runner - Bounded runner.
 * @param repository - Connected repository.
 * @param settings - Validated paging settings.
 * @param number - Optional issue number.
 * @returns Current bounded observations.
 */
async function readVerifiedIssues(
  runner: GitHubRunner,
  repository: string,
  settings: z.output<typeof issueCorpusInput>,
  number: number | undefined,
): Promise<IssueCorpusPage> {
  const verified = z.object({ node_id: z.string() }).parse(await runner(['api', `repos/${repository}`]));
  if (verified.node_id !== settings.repositoryId) {
    throw new Error('Repository identity changed');
  }
  const selection =
    number === undefined
      ? `issues(first:$first, after:$after, orderBy:{field:UPDATED_AT,direction:DESC}) {
            nodes { ${OBSERVED_ISSUE_FIELDS} } pageInfo { hasNextPage endCursor } }`
      : `issue(number:$number) { ${OBSERVED_ISSUE_FIELDS} }`;
  const argumentsDeclaration = number === undefined ? '$first:Int!, $after:String' : '$number:Int!';
  const envelope = z.object({ data: z.unknown(), errors: z.unknown().optional() }).parse(
    await runner(['api', 'graphql', '--input', '-'], {
      query: `query($id:ID!, ${argumentsDeclaration}) { node(id:$id) { ... on Repository { id ${selection} } } }`,
      variables:
        number === undefined
          ? { id: verified.node_id, first: settings.first, after: settings.after }
          : { id: verified.node_id, number },
    }),
  );
  if (envelope.errors !== undefined) {
    throw new Error('GraphQL rejected the read');
  }
  const { node } = z
    .object({ node: z.object({ id: z.literal(settings.repositoryId) }).passthrough() })
    .parse(envelope.data);
  const page =
    number === undefined
      ? z
          .object({ nodes: z.array(observedIssueSchema).max(settings.first), pageInfo: issuePageInfo })
          .parse(node['issues'])
      : { nodes: [observedIssueSchema.parse(node['issue'])], pageInfo: { hasNextPage: false, endCursor: null } };
  if (
    page.nodes.some(
      (issue) => issue.repository.id !== settings.repositoryId || (number !== undefined && issue.number !== number),
    )
  ) {
    throw new Error('Issue transferred');
  }
  if (page.pageInfo.hasNextPage && (page.pageInfo.endCursor === null || page.pageInfo.endCursor === settings.after)) {
    throw new Error('Nonadvancing cursor');
  }
  const items = page.nodes
    .filter((issue) => {
      return (
        number !== undefined ||
        issue.state === 'OPEN' ||
        (issue.closedAt !== null && issue.closedAt >= settings.closedSince)
      );
    })
    .map((issue) => observeIssue(issue));
  if (number !== undefined && items.some((issue) => issue.revision === null)) {
    throw new Error('Incomplete issue');
  }
  return {
    repositoryId: verified.node_id,
    items,
    nextCursor: page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null,
    complete: !page.pageInfo.hasNextPage && items.every((issue) => issue.revision !== null),
  };
}
