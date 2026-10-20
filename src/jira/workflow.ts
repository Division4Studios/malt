/**
 * The factory's Jira workflow settings for a saved Jira tracker: the JQL
 * intake filter whose matches become objectives, and the Jira status each
 * MALT stage moves an issue to. Both are checked against Jira before they are
 * saved: the filter runs once through the enhanced search API, so a filter
 * Jira rejects is never saved and the operator sees what intake would file,
 * and every mapped status must exist in one of the project's workflows. The
 * check only reads; nothing in Jira changes.
 *
 * @file
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { z } from 'zod/v3';

import { hasErrorCode, readJsonFile } from '../config.ts';
import { connectionV2Schema } from '../connector.ts';
import { MeshError } from '../protocol.ts';
import { writeAtomic } from '../summary.ts';

import { JiraRequestError, jiraGet } from './client.ts';
import { jiraTrackerTransport, savedJiraTracker } from './connection.ts';
import { chooseIntake, searchIntake } from './intake.ts';
import { statusesSchema } from './permissions.ts';
import { credentialBlocker } from './traceability.ts';
import { mappingProblems, stageMappingSchema } from './transitions.ts';

import type { ConnectionV2, JiraWorkflow } from '../connector.ts';
import type { MeshErrorCode } from '../protocol.ts';
import type { JiraFetch, JiraIssueKey, JiraTransport } from './client.ts';
import type { SkipReason } from './intake.ts';

/** Issues the intake preview lists. */
const PREVIEW_MAX = 20;
/** Skipped issues the intake record keeps. */
const SKIPPED_KEPT = 50;
/** Why intake skipped an issue. */
const SKIP_REASONS = ['done', 'resolved', 'reassigned', 'already_queued'] as const;
/** One issue intake skipped, with why. */
const skippedSchema = z.object({ key: z.string(), reason: z.enum(SKIP_REASONS) });
/** The last intake read, as `.malt/jira/intake.json` keeps it. */
const intakeRecordSchema = z.object({
  checkedAt: z.string().datetime(),
  offered: z.array(z.string()),
  skipped: z.array(skippedSchema).max(SKIPPED_KEPT),
  isTruncated: z.boolean(),
  retryAfterSeconds: z.number().int().nonnegative().nullable(),
  error: z.string().nullable(),
});
/** The last intake read: what was offered, what was skipped and why, and any failure. */
export type IntakeRecord = z.output<typeof intakeRecordSchema>;
/** `GET /rest/api/3/myself`. */
const myselfSchema = z.object({ accountId: z.string().min(1) });

/** A workflow change: a new filter (`null` turns intake off) and/or a new stage mapping. */
export interface JiraWorkflowChange {
  /** Intake filter; `null` turns intake off, absent keeps it. */
  readonly jql?: string | null | undefined;
  /** Stage mapping; an empty mapping leaves every Jira status alone, absent keeps it. */
  readonly stages?: Readonly<Record<string, { readonly statusId: string; readonly statusName: string }>> | undefined;
}

/** What intake would file now, from the first page of the filter. */
export interface IntakePreview {
  /** Issues that would become objectives. */
  readonly queue: readonly JiraIssueKey[];
  /** Issues intake would skip, with why. */
  readonly skipped: readonly { readonly key: JiraIssueKey; readonly reason: SkipReason }[];
  /** Whether the filter matches more issues than the preview read. */
  readonly isTruncated: boolean;
}

/**
 * Where a workspace keeps its last intake read.
 *
 * @param directory - The workspace's private state directory.
 * @returns Path of `jira/intake.json`.
 */
function intakeFile(directory: string): string {
  return path.join(directory, 'jira', 'intake.json');
}

/**
 * Keep the last intake read for the console and CLI.
 *
 * @param directory - The workspace's private state directory.
 * @param record - What the read found; skipped issues beyond the bound are dropped.
 */
export function writeIntakeRecord(directory: string, record: IntakeRecord): void {
  const file = intakeFile(directory);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- The project's own private state directory.
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const kept = intakeRecordSchema.parse({ ...record, skipped: record.skipped.slice(0, SKIPPED_KEPT) });
  writeAtomic(file, `${JSON.stringify(kept, null, 2)}\n`);
}

/**
 * Read the last intake read.
 *
 * @param directory - The workspace's private state directory.
 * @returns The record, or `null` before the first read or for a damaged file.
 * @throws {Error} For a file that cannot be read for another reason.
 */
export function readIntakeRecord(directory: string): IntakeRecord | null {
  try {
    return intakeRecordSchema.parse(readJsonFile(intakeFile(directory)));
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT') || error instanceof z.ZodError || error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

/**
 * The MeshError a failed Jira read becomes, keeping Jira's own explanation.
 *
 * @param error - Thrown value.
 * @param what - What was being checked, for the message.
 * @returns Error safe to show; the token was already redacted by the client.
 */
export function jiraFailure(error: unknown, what: string): unknown {
  if (!(error instanceof JiraRequestError)) {
    return error;
  }
  const credential = credentialBlocker(error);
  if (credential !== null) {
    return new MeshError('CREDENTIALS_MISSING', credential, { cause: error });
  }
  if (error.failure === 'rate_limited') {
    const wait = error.retryAfterSeconds === null ? 'a short while' : `${String(error.retryAfterSeconds)} seconds`;
    return new MeshError('RATE_LIMITED', `Jira rate-limited ${what}; retry after ${wait}.`, { cause: error });
  }
  const codes: Readonly<Partial<Record<JiraRequestError['failure'], MeshErrorCode>>> = {
    invalid: 'INVALID_INPUT',
    not_found: 'NOT_FOUND',
  };
  const code = codes[error.failure] ?? 'HTTP_ERROR';
  return new MeshError(code, `Jira could not check ${what}: ${error.message}`, { cause: error });
}

/**
 * Run the filter once and preview what intake would file.
 *
 * @param transport - Site, credential and transport.
 * @param jql - Proposed filter.
 * @returns The first page's queue and skips.
 * @throws {MeshError} When Jira rejects the filter or cannot be read.
 */
async function previewIntake(transport: JiraTransport, jql: string): Promise<IntakePreview> {
  try {
    const account = myselfSchema.parse(await jiraGet(transport, '/rest/api/3/myself')).accountId;
    const read = await searchIntake(transport, jql, { limit: 1 });
    if (read.retryAfterSeconds !== null) {
      throw new JiraRequestError('Jira rate-limited the intake filter.', {
        failure: 'rate_limited',
        retryAfterSeconds: read.retryAfterSeconds,
      });
    }
    const chosen = chooseIntake(read, account, new Set());
    return {
      queue: chosen.queue.slice(0, PREVIEW_MAX).map((issue) => issue.key),
      skipped: chosen.skipped.slice(0, PREVIEW_MAX),
      isTruncated: read.isTruncated || chosen.queue.length + chosen.skipped.length > PREVIEW_MAX,
    };
  } catch (error) {
    throw jiraFailure(error, 'the intake filter');
  }
}

/**
 * Check a stage mapping against the project's workflows.
 *
 * @param transport - Site, credential and transport.
 * @param projectKey - Saved project.
 * @param stages - Proposed mapping.
 * @returns The validated mapping.
 * @throws {MeshError} INVALID_INPUT for an unknown stage or a status no workflow has.
 */
async function checkStages(
  transport: JiraTransport,
  projectKey: string,
  stages: NonNullable<JiraWorkflowChange['stages']>,
): Promise<NonNullable<JiraWorkflow['stages']>> {
  const mapping = stageMappingSchema.safeParse(stages);
  if (!mapping.success) {
    throw new MeshError('INVALID_INPUT', 'Map only MALT delivery stages, each to one Jira status ID and name.');
  }
  let issueTypes: z.output<typeof statusesSchema>;
  try {
    issueTypes = statusesSchema.parse(await jiraGet(transport, `/rest/api/3/project/${projectKey}/statuses`));
  } catch (error) {
    throw jiraFailure(error, 'the project workflows');
  }
  const problems = mappingProblems(mapping.data, issueTypes);
  if (problems.length > 0) {
    throw new MeshError('INVALID_INPUT', problems.join(' '));
  }
  return mapping.data;
}

/**
 * Check and apply a workflow change to a saved Jira tracker. The tracker's
 * verification is kept: only what MALT does with the project changes.
 *
 * @param record - Saved connection whose tracker is Jira.
 * @param change - New filter and/or stage mapping.
 * @param context - The supervisor's environment and, for tests, a transport.
 * @param context.environment - Environment holding the token's variable.
 * @param context.fetch - Transport; defaults to the global `fetch`.
 * @returns The record to save and, for a new filter, what intake would file.
 * @throws {MeshError} INVALID_INPUT for an empty change, a tracker that is not Jira or a change Jira rejects.
 */
export async function applyJiraWorkflow(
  record: ConnectionV2,
  change: JiraWorkflowChange,
  context: { readonly environment: NodeJS.ProcessEnv; readonly fetch?: JiraFetch | undefined },
): Promise<{ record: ConnectionV2; preview: IntakePreview | null }> {
  if (change.jql === undefined && change.stages === undefined) {
    throw new MeshError('INVALID_INPUT', 'Change the intake filter, the stage mapping, or both.');
  }
  const { tracker } = record;
  const saved = savedJiraTracker(tracker);
  const transport = jiraTrackerTransport(tracker, context.environment, context.fetch);
  const workflow: { -readonly [Key in keyof JiraWorkflow]: JiraWorkflow[Key] } = { ...saved.workflow };
  let preview: IntakePreview | null = null;
  if (change.jql === null) {
    delete workflow.intake;
  } else if (change.jql !== undefined) {
    const jql = change.jql.trim();
    preview = await previewIntake(transport, jql);
    workflow.intake = { jql };
  }
  if (change.stages !== undefined) {
    workflow.stages = await checkStages(transport, saved.projectKey, change.stages);
  }
  const jira = tracker.jira ?? { site: saved.site, projectKey: saved.projectKey, email: saved.email };
  return {
    record: connectionV2Schema.parse({ ...record, tracker: { ...tracker, jira: { ...jira, workflow } } }),
    preview,
  };
}
