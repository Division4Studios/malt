/**
 * Read-only Jira intake: page through a configured JQL filter with the
 * enhanced search API and decide which issues may become objectives. Each
 * candidate keeps its typed key and Jira's stable issue ID, so an issue whose
 * project key was renamed is still recognised. Done, resolved and issues
 * assigned to someone else are skipped with the reason, never queued. Reads
 * are bounded; a rate limit stops the read and is reported with its
 * `Retry-After`, so the supervisor retries later instead of spinning.
 *
 * @file
 */
import { z } from 'zod/v3';

import { adfPlainText } from './adf.ts';
import { JiraRequestError, jiraGet, jiraIssueKeySchema } from './client.ts';

import type { JiraIssueKey, JiraTransport } from './client.ts';

/** Issues read per page. */
const PAGE_SIZE = 50;
/** Most issues one intake read considers. */
export const INTAKE_LIMIT = 200;
/** Longest JQL accepted from settings. */
export const JQL_MAX = 2000;
/** Fields intake needs. */
const FIELDS = 'summary,description,status,assignee,resolution,issuetype,updated';

/** A configured intake filter. */
export const jqlSchema = z.string().trim().min(1).max(JQL_MAX);

/** An issue's status with its category. */
const statusSchema = z.object({
  id: z.string(),
  name: z.string(),
  statusCategory: z.object({ key: z.string() }).optional(),
});
/** The fields intake reads. */
const fieldsSchema = z.object({
  summary: z.string().default(''),
  status: statusSchema,
  assignee: z.object({ accountId: z.string() }).nullable().default(null),
  resolution: z.object({ name: z.string() }).nullable().default(null),
  /** Atlassian Document Format; absent when the read did not ask for it. */
  description: z.unknown().optional(),
});
/** One issue from the search response. */
export const searchIssueSchema = z.object({ id: z.string().min(1), key: jiraIssueKeySchema, fields: fieldsSchema });
/** One page of `GET /rest/api/3/search/jql`. */
const searchPageSchema = z.object({
  issues: z.array(searchIssueSchema),
  nextPageToken: z.string().min(1).optional(),
  isLast: z.boolean().optional(),
});

/** An issue intake can consider. */
export interface IntakeIssue {
  /** Jira's stable issue ID, which survives project key renames. */
  readonly id: string;
  /** Current issue key. */
  readonly key: JiraIssueKey;
  /** Summary, the objective's first line. */
  readonly summary: string;
  /** Current status name. */
  readonly status: string;
  /** Status category key (`new`, `indeterminate` or `done`). */
  readonly category: string | null;
  /** Assignee account, if any. */
  readonly assignee: string | null;
  /** Resolution name, if resolved. */
  readonly resolution: string | null;
  /** Description as plain text, when the read included it. */
  readonly description?: string;
}

/** Why intake skipped an issue. */
export type SkipReason = 'done' | 'resolved' | 'reassigned' | 'already_queued';

/** What an intake read found. */
export interface IntakeRead {
  /** Issues that may become objectives, in search order. */
  readonly queue: readonly IntakeIssue[];
  /** Issues not queued, each with why. */
  readonly skipped: readonly { readonly key: JiraIssueKey; readonly reason: SkipReason }[];
  /** Whether more matches exist beyond the bounded read. */
  readonly isTruncated: boolean;
  /** Cursor the next read resumes from, or `null` at the end of the filter. */
  readonly next: string | null;
  /** Seconds to wait when Jira rate-limited the read; earlier pages are kept. */
  readonly retryAfterSeconds: number | null;
}

/** A bounded intake read, with where the next read resumes. */
export interface IntakeSearch {
  /** Issues of every page read, in search order. */
  readonly issues: IntakeIssue[];
  /** Whether more matches exist beyond this read. */
  readonly isTruncated: boolean;
  /** Cursor the next read resumes from, or `null` when the filter was read to its end. */
  readonly next: string | null;
  /** Seconds to wait when Jira rate-limited the read. */
  readonly retryAfterSeconds: number | null;
}

/**
 * Read matches of a JQL filter, whole pages at a time, until the intake bound.
 * A truncated read returns its cursor; passing it back resumes after the
 * pages already read, so a filter with more matches than the bound is still
 * read in full over successive reads.
 *
 * @param transport - Site, credential and transport.
 * @param jql - Configured filter.
 * @param options - Bound and resume point.
 * @param options.limit - Issues after which no further page is read.
 * @param options.cursor - Cursor returned by the previous truncated read.
 * @returns Matching issues, the cursor to resume from and any rate-limit wait.
 * @throws {JiraRequestError} For anything other than a rate limit.
 */
export async function searchIntake(
  transport: JiraTransport,
  jql: string,
  options: { readonly limit?: number; readonly cursor?: string | null } = {},
): Promise<IntakeSearch> {
  const filter = jqlSchema.parse(jql);
  const limit = options.limit ?? INTAKE_LIMIT;
  const issues: IntakeIssue[] = [];
  let cursor = options.cursor ?? undefined;
  do {
    // eslint-disable-next-line no-await-in-loop -- Each page's cursor comes from the previous page.
    const page = await readPage(transport, filter, cursor);
    if (page.retryAfterSeconds !== null) {
      // Resume with the page that was refused, after the wait.
      return { issues, isTruncated: true, next: cursor ?? null, retryAfterSeconds: page.retryAfterSeconds };
    }
    issues.push(...page.issues);
    cursor = page.next;
  } while (cursor !== undefined && issues.length < limit);
  return { issues, isTruncated: cursor !== undefined, next: cursor ?? null, retryAfterSeconds: null };
}

/**
 * Read one search page.
 *
 * @param transport - Site, credential and transport.
 * @param jql - Validated filter.
 * @param cursor - The previous page's `nextPageToken`, if any.
 * @returns The page's issues and next cursor, or the rate-limit wait.
 * @throws {JiraRequestError} For anything other than a rate limit.
 */
async function readPage(
  transport: JiraTransport,
  jql: string,
  cursor: string | undefined,
): Promise<{ issues: IntakeIssue[]; next: string | undefined; retryAfterSeconds: number | null }> {
  const query: Record<string, string> = { jql, fields: FIELDS, maxResults: String(PAGE_SIZE) };
  if (cursor !== undefined) {
    query['nextPageToken'] = cursor;
  }
  let page: z.output<typeof searchPageSchema>;
  try {
    page = searchPageSchema.parse(await jiraGet(transport, '/rest/api/3/search/jql', query));
  } catch (error) {
    if (error instanceof JiraRequestError && error.failure === 'rate_limited') {
      return { issues: [], next: undefined, retryAfterSeconds: error.retryAfterSeconds ?? 0 };
    }
    throw error;
  }
  return {
    issues: page.issues.map((issue) => intakeIssue(issue)),
    next: page.isLast === true ? undefined : page.nextPageToken,
    retryAfterSeconds: null,
  };
}

/**
 * Flatten one search result.
 *
 * @param issue - Validated search issue.
 * @returns The fields intake decides on.
 */
export function intakeIssue(issue: z.output<typeof searchIssueSchema>): IntakeIssue {
  return {
    id: issue.id,
    key: issue.key,
    summary: issue.fields.summary,
    status: issue.fields.status.name,
    category: issue.fields.status.statusCategory?.key ?? null,
    assignee: issue.fields.assignee?.accountId ?? null,
    resolution: issue.fields.resolution?.name ?? null,
    ...(issue.fields.description !== undefined && { description: adfPlainText(issue.fields.description) }),
  };
}

/**
 * Why an issue may not be worked, if it may not.
 *
 * @param issue - Issue as Jira reports it now.
 * @param account - MALT's Jira account; issues assigned to anyone else are left alone.
 * @returns Skip reason, or `null` when MALT may work it.
 */
export function unworkableReason(issue: IntakeIssue, account: string): Exclude<SkipReason, 'already_queued'> | null {
  if (issue.category === 'done') {
    return 'done';
  }
  if (issue.resolution !== null) {
    return 'resolved';
  }
  return issue.assignee !== null && issue.assignee !== account ? 'reassigned' : null;
}

/**
 * Choose which matches become objectives.
 *
 * @param read - Search result.
 * @param read.issues - Matching issues in search order.
 * @param read.isTruncated - Whether more matches exist.
 * @param read.next - Cursor the next read resumes from.
 * @param read.retryAfterSeconds - Rate-limit wait, if any.
 * @param account - MALT's Jira account.
 * @param queuedIds - Jira issue IDs already filed as objectives.
 * @returns The queue and every skipped issue with its reason.
 */
export function chooseIntake(
  read: {
    readonly issues: readonly IntakeIssue[];
    readonly isTruncated: boolean;
    readonly next: string | null;
    readonly retryAfterSeconds: number | null;
  },
  account: string,
  queuedIds: ReadonlySet<string>,
): IntakeRead {
  const seen = new Set(queuedIds);
  const queue: IntakeIssue[] = [];
  const skipped: { key: JiraIssueKey; reason: SkipReason }[] = [];
  for (const issue of read.issues) {
    const reason = seen.has(issue.id) ? 'already_queued' : unworkableReason(issue, account);
    if (reason === null) {
      queue.push(issue);
      seen.add(issue.id);
    } else {
      skipped.push({ key: issue.key, reason });
    }
  }
  return { queue, skipped, isTruncated: read.isTruncated, next: read.next, retryAfterSeconds: read.retryAfterSeconds };
}
