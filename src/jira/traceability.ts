/**
 * Jira traceability: progress, pull request and merged-main evidence comments,
 * the source-of-truth re-read before a job starts, and one blocker for a
 * rejected credential. Comments are idempotent: each has a stable request ID
 * journaled before Jira is called and a marker line in its text, so a retry,
 * or a retry after a lost response, never posts the same evidence twice.
 * Before any paid turn the supervisor re-reads the issue and works it only
 * when it is not done, resolved or assigned to someone else.
 *
 * @file
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { z } from 'zod/v3';

import { readJsonFile, writeIfAbsent } from '../config.ts';
import { writeAtomic } from '../summary.ts';

import { JiraRequestError, jiraGet } from './client.ts';
import { requestIdSchema } from './creation.ts';
import { intakeIssue, searchIssueSchema, unworkableReason } from './intake.ts';
import { commentOnJiraIssue } from './writes.ts';

import type { JiraIssueKey, JiraTransport } from './client.ts';
import type { CreationLedger } from './creation.ts';
import type { IntakeIssue, SkipReason } from './intake.ts';
import type { JiraWriteContext } from './writes.ts';

/** Fields read for the source-of-truth check. */
const STATE_FIELDS = 'summary,status,assignee,resolution';
/** Recent comments read while reconciling one. */
const COMMENT_PAGE = 50;

/** What a traceability comment reports. */
export type Evidence =
  | { readonly kind: 'progress'; readonly summary: string }
  | { readonly kind: 'pull_request'; readonly url: string; readonly head: string }
  | { readonly kind: 'merged'; readonly url: string; readonly commit: string; readonly verified: boolean };

/** The journal of one comment. */
const journalSchema = z.object({ marker: z.string(), commentId: z.string().nullable() });
/** One comment. */
const commentSchema = z.object({ id: z.string(), body: z.unknown() });
/** `GET /rest/api/3/issue/{key}/comment` answer. */
const commentsSchema = z.object({ comments: z.array(commentSchema) });

/** Commit IDs shown in comments. */
const SHORT_SHA = 12;

/**
 * The text of an evidence comment.
 *
 * @param evidence - What to report.
 * @returns Plain text lines for the comment.
 * @throws {Error} For an evidence kind this version does not know.
 */
export function evidenceText(evidence: Evidence): string {
  switch (evidence.kind) {
    case 'progress': {
      return `MALT progress: ${evidence.summary}`;
    }
    case 'pull_request': {
      return `MALT opened a pull request for this issue at ${evidence.head.slice(0, SHORT_SHA)}: ${evidence.url}`;
    }
    case 'merged': {
      const proof = evidence.verified ? 'and verified on main' : 'and is being verified on main';
      return `MALT merged ${evidence.url} as ${evidence.commit.slice(0, SHORT_SHA)} ${proof}.`;
    }
    default: {
      throw new Error('Unknown evidence.');
    }
  }
}

/**
 * Whether an ADF comment body contains a marker.
 *
 * @param body - Comment body.
 * @param marker - Marker line.
 * @returns True when a text run equals the marker.
 */
function hasMarker(body: unknown, marker: string): boolean {
  return JSON.stringify(body).includes(JSON.stringify(marker));
}

/**
 * Post an evidence comment once per request ID.
 *
 * @param context - Transport, capability gate and caller.
 * @param ledger - Journal directory and project identity.
 * @param input - Request ID, issue and evidence.
 * @param input.requestId - Stable ID, for example derived from the delivery, kind and head.
 * @param input.issueKey - Issue to comment on.
 * @param input.evidence - What to report.
 * @returns The comment's ID.
 * @throws {MeshError} CAPABILITY_DENIED before any request when comments are not allowed.
 */
export async function commentEvidenceOnce(
  context: JiraWriteContext,
  ledger: Pick<CreationLedger, 'directory' | 'projectId'>,
  input: { readonly requestId: string; readonly issueKey: JiraIssueKey; readonly evidence: Evidence },
): Promise<{ id: string }> {
  const requestId = requestIdSchema.parse(input.requestId);
  const file = path.join(ledger.directory, 'jira', 'comments', `${requestId}.json`);
  const marker = `MALT evidence ${ledger.projectId}:${requestId}`;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- The project's own private state directory.
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const isFresh = writeIfAbsent(file, `${JSON.stringify({ marker, commentId: null }, null, 2)}\n`) === 'created';
  const journal = journalSchema.parse(readJsonFile(file));
  if (journal.commentId !== null) {
    return { id: journal.commentId };
  }
  if (!isFresh) {
    const recent = commentsSchema.parse(
      await jiraGet(context.transport, `/rest/api/3/issue/${input.issueKey}/comment`, {
        orderBy: '-created',
        maxResults: String(COMMENT_PAGE),
      }),
    );
    const found = recent.comments.find((comment) => hasMarker(comment.body, marker));
    if (found !== undefined) {
      writeAtomic(file, `${JSON.stringify({ marker, commentId: found.id }, null, 2)}\n`);
      return { id: found.id };
    }
  }
  const posted = await commentOnJiraIssue(context, input.issueKey, `${evidenceText(input.evidence)}\n${marker}`);
  writeAtomic(file, `${JSON.stringify({ marker, commentId: posted.id }, null, 2)}\n`);
  return posted;
}

/**
 * Re-read an issue right before a job and decide whether it may be worked.
 *
 * @param transport - Site, credential and transport.
 * @param issueKey - Issue the job would work.
 * @param account - MALT's Jira account ID.
 * @returns The issue as Jira reports it now and why it may not be worked, if it may not.
 * @throws {JiraRequestError} For a deleted issue (`not_found`) or any other request failure.
 */
export async function recheckIssue(
  transport: JiraTransport,
  issueKey: JiraIssueKey,
  account: string,
): Promise<{ issue: IntakeIssue; blocked: Exclude<SkipReason, 'already_queued'> | null }> {
  const issue = intakeIssue(
    searchIssueSchema.parse(await jiraGet(transport, `/rest/api/3/issue/${issueKey}`, { fields: STATE_FIELDS })),
  );
  return { issue, blocked: unworkableReason(issue, account) };
}

/**
 * The single blocker a rejected credential becomes, so the supervisor parks
 * the connection instead of spending paid turns on calls that will fail.
 *
 * @param error - Failure of any Jira request.
 * @returns Operator action, or `null` when the failure is not about the credential.
 */
export function credentialBlocker(error: unknown): string | null {
  return error instanceof JiraRequestError && error.failure === 'unauthorized'
    ? 'Jira rejected the MALT credential: the API token was revoked, rotated or expired. Create a new token and update the credential handle, then resume.'
    : null;
}
