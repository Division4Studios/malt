/**
 * Idempotent Jira issue creation. Each request has a stable ID; its journal is
 * written before Jira is called and records the created issue afterwards, so
 * a retry returns the same issue instead of creating another. When a call was
 * interrupted after Jira may have created the issue, the journal stays
 * pending and the next attempt reconciles first: it reads the issues MALT's
 * account reported since the request started and matches the request's
 * marker in their descriptions. Only when no match exists is creation retried;
 * an ambiguous result (more than one match) is refused for a human to settle.
 *
 * @file
 */
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { z } from 'zod/v3';

import { readJsonFile, writeIfAbsent } from '../config.ts';
import { MeshError } from '../protocol.ts';
import { writeAtomic } from '../summary.ts';

import { jiraGet, jiraIssueKeySchema, jiraProjectKeySchema } from './client.ts';
import { createJiraIssue } from './writes.ts';

import type { JiraIssueKey, JiraTransport } from './client.ts';
import type { JiraWriteContext } from './writes.ts';

/** Minutes of clock skew allowed when looking for an interrupted creation. */
const SKEW_MINUTES = 10;
/** Issues read while reconciling one request. */
const RECONCILE_LIMIT = 100;
/** Milliseconds per minute. */
const MINUTE_MS = 60_000;

/** Longest summary Jira accepts. */
const SUMMARY_MAX = 255;
/** Longest description text MALT sends. */
const DESCRIPTION_MAX = 30_000;
/** Longest acceptance criterion. */
const CRITERION_MAX = 1000;
/** Most acceptance criteria on one issue. */
const CRITERIA_MAX = 50;
/** Most labels on one issue. */
const LABELS_MAX = 20;

/** A stable request ID, the same shape GitHub creation uses. */
export const requestIdSchema = z.string().regex(/^[\w\-]{1,64}$/v);
/** One acceptance criterion. */
const criterionSchema = z.string().trim().min(1).max(CRITERION_MAX);
/** One existing label; Jira labels have no spaces. */
const labelSchema = z.string().regex(/^\S{1,255}$/v);

/** One creation request. */
export const creationSchema = z
  .object({
    requestId: requestIdSchema,
    projectKey: jiraProjectKeySchema,
    issueTypeId: z.string().min(1),
    summary: z.string().trim().min(1).max(SUMMARY_MAX),
    description: z.string().max(DESCRIPTION_MAX),
    acceptanceCriteria: z.array(criterionSchema).max(CRITERIA_MAX),
    parentKey: jiraIssueKeySchema.optional(),
    labels: z.array(labelSchema).max(LABELS_MAX).optional(),
  })
  .strict();
/** One creation request. */
export type JiraCreation = z.input<typeof creationSchema>;

/** A created issue. */
const createdSchema = z.object({ id: z.string().min(1), key: jiraIssueKeySchema });
/** The journal written before Jira is called. */
const journalSchema = z.object({
  fingerprint: z.string(),
  marker: z.string(),
  startedAt: z.number(),
  issue: createdSchema.nullable(),
});
/** One saved creation. */
type Journal = z.output<typeof journalSchema>;

/** Where journals live and which project they belong to. */
export interface CreationLedger {
  /** The project's private state directory. */
  readonly directory: string;
  /** Durable project identity, scoping markers to this workspace. */
  readonly projectId: string;
  /** Clock. */
  readonly now: () => number;
}

/** One issue found while reconciling. */
const foundSchema = z.object({
  id: z.string(),
  key: jiraIssueKeySchema,
  fields: z.object({ description: z.unknown() }),
});
/** Search answer while reconciling. */
const reconcileSchema = z.object({ issues: z.array(foundSchema) });

/**
 * The marker line a request leaves in its issue's description.
 *
 * @param ledger - Project identity.
 * @param requestId - Stable request ID.
 * @returns Marker text, unique to this workspace and request.
 */
export function creationMarker(ledger: Pick<CreationLedger, 'projectId'>, requestId: string): string {
  return `MALT request ${ledger.projectId}:${requestId}`;
}

/**
 * Every text run in an Atlassian Document Format node.
 *
 * @param node - Any ADF value.
 * @returns Its text, depth first.
 */
function adfText(node: unknown): string[] {
  if (typeof node !== 'object' || node === null) {
    return [];
  }
  const own = 'text' in node && typeof node.text === 'string' ? [node.text] : [];
  const children: unknown[] = 'content' in node && Array.isArray(node.content) ? node.content : [];
  return [...own, ...children.flatMap((child) => adfText(child))];
}

/**
 * The issues MALT's account reported since a request started that carry its marker.
 *
 * @param transport - Site, credential and transport.
 * @param input - Request whose issue is looked for.
 * @param journal - Its pending journal.
 * @param now - Current time; the search window is relative, so Jira's time zone does not matter.
 * @returns Matching issues.
 */
async function findCreated(
  transport: JiraTransport,
  input: z.output<typeof creationSchema>,
  journal: Journal,
  now: number,
): Promise<z.output<typeof createdSchema>[]> {
  const minutes = Math.ceil(Math.max(0, now - journal.startedAt) / MINUTE_MS) + SKEW_MINUTES;
  const answer = reconcileSchema.parse(
    await jiraGet(transport, '/rest/api/3/search/jql', {
      jql: `project = "${input.projectKey}" AND reporter = currentUser() AND created >= -${String(minutes)}m ORDER BY created ASC`,
      fields: 'description',
      maxResults: String(RECONCILE_LIMIT),
    }),
  );
  return answer.issues
    .filter((issue) => adfText(issue.fields.description).includes(journal.marker))
    .map(({ id, key }) => ({ id, key }));
}

/**
 * The description an issue is created with: the text, its acceptance criteria and the marker.
 *
 * @param input - Validated request.
 * @param marker - Request marker.
 * @returns Plain text for the ADF description.
 */
function describe(input: z.output<typeof creationSchema>, marker: string): string {
  const criteria = input.acceptanceCriteria.map((criterion) => `[ ] ${criterion}`);
  return [input.description, ...(criteria.length > 0 ? ['Acceptance criteria:', ...criteria] : []), marker].join('\n');
}

/**
 * Create an issue once per request ID, reconciling an interrupted earlier attempt first.
 *
 * @param context - Transport, capability gate and caller.
 * @param ledger - Journal directory, project identity and clock.
 * @param request - Stable request and desired issue.
 * @returns The issue this request created.
 * @throws {MeshError} INVALID_INPUT when the ID was used for a different issue; FACTORY_GATED when an
 *   interrupted creation matches more than one issue.
 */
export async function createJiraIssueOnce(
  context: JiraWriteContext,
  ledger: CreationLedger,
  request: JiraCreation,
): Promise<{ id: string; key: JiraIssueKey }> {
  const input = creationSchema.parse(request);
  const file = path.join(ledger.directory, 'jira', 'operations', `${input.requestId}.json`);
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ ...input, requestId: undefined }))
    .digest('hex');
  const marker = creationMarker(ledger, input.requestId);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- The project's own private state directory.
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const fresh: Journal = { fingerprint, marker, startedAt: ledger.now(), issue: null };
  const isFresh = writeIfAbsent(file, `${JSON.stringify(fresh, null, 2)}\n`) === 'created';
  const journal = journalSchema.parse(readJsonFile(file));
  if (journal.fingerprint !== fingerprint) {
    throw new MeshError('INVALID_INPUT', 'This requestId already belongs to a different Jira issue.');
  }
  if (journal.issue !== null) {
    return journal.issue;
  }
  if (!isFresh) {
    const matches = await findCreated(context.transport, input, journal, ledger.now());
    if (matches.length > 1) {
      throw new MeshError(
        'FACTORY_GATED',
        `More than one Jira issue carries ${marker}; keep one and remove the others before retrying.`,
      );
    }
    const [match] = matches;
    if (match !== undefined) {
      writeAtomic(file, `${JSON.stringify({ ...journal, issue: match }, null, 2)}\n`);
      return match;
    }
  }
  const created = await createJiraIssue(context, {
    projectKey: input.projectKey,
    issueTypeId: input.issueTypeId,
    summary: input.summary,
    description: describe(input, marker),
    ...(input.parentKey !== undefined && { parentKey: input.parentKey }),
    ...(input.labels !== undefined && { labels: input.labels }),
  });
  writeAtomic(file, `${JSON.stringify({ ...journal, issue: created }, null, 2)}\n`);
  return created;
}
