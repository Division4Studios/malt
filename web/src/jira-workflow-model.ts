/**
 * DOM-free model of the factory's Jira workflow in the Connections view: the
 * JQL filter whose matching issues become objectives, the Jira status each
 * MALT stage moves an issue to, and what the last intake read offered and
 * skipped. Statuses come from the saved, verified tracker, never from typed
 * guesses; saving goes through `jira_workflow_save`, which checks the filter
 * and the statuses against Jira before anything is saved.
 *
 * @file
 */
import { child, data, number, records, text } from './api.js';
import { t } from './i18n.js';

import type { Data } from './api.js';

/** MALT stages a human may map to a Jira status, in delivery order. */
export const MAPPED_STAGES = [
  'Ready',
  'Development',
  'QA / Review',
  'Merge Ready',
  'Final Verification',
  'Done',
  'Blocked',
] as const;
/** Longest intake filter the broker accepts. */
export const JQL_MAX = 2000;

/** One Jira status a stage may move an issue to. */
export interface JiraStatus {
  /** Status ID. */
  readonly id: string;
  /** Status name. */
  readonly name: string;
}

/** An issue intake skipped, with why. */
export interface SkippedIssue {
  /** Jira key. */
  readonly key: string;
  /** `done`, `resolved`, `reassigned` or `already_queued`. */
  readonly reason: string;
}

/** What the factory's last intake read found. */
export interface IntakeRead {
  /** When it read, as ISO text. */
  readonly checkedAt: string;
  /** Issues it offered as objectives. */
  readonly offered: readonly string[];
  /** Issues it skipped. */
  readonly skipped: readonly SkippedIssue[];
  /** Seconds Jira asked to wait, or zero. */
  readonly retryAfterSeconds: number;
  /** Why the read failed, or empty. */
  readonly error: string;
}

/** The saved workflow of a Jira tracker. */
export interface JiraWorkflowView {
  /** Intake filter, or empty while intake is off. */
  readonly jql: string;
  /** Status ID each mapped stage moves an issue to. */
  readonly stages: Readonly<Record<string, string>>;
  /** Statuses of the project's workflows, from verification. */
  readonly statuses: readonly JiraStatus[];
  /** The last intake read, or `null` before one. */
  readonly lastIntake: IntakeRead | null;
}

/** The operator's unsaved choices. */
export interface JiraWorkflowDraft {
  /** Intake filter; empty turns intake off. */
  readonly jql: string;
  /** Status ID per stage; empty leaves the stage unmapped. */
  readonly stages: Readonly<Record<string, string>>;
}

/** What intake would file under a just-saved filter. */
export interface IntakePreview {
  /** Issues that would become objectives. */
  readonly queue: readonly string[];
  /** Issues it would skip. */
  readonly skipped: readonly SkippedIssue[];
  /** Whether the filter matches more than the preview read. */
  readonly isTruncated: boolean;
}

/**
 * Strings of an untrusted list.
 *
 * @param value - Untrusted value.
 * @returns Its string entries.
 */
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : [];
}

/**
 * Skipped issues of an untrusted list.
 *
 * @param value - Untrusted value.
 * @returns Key and reason of each entry.
 */
function skippedIssues(value: unknown): SkippedIssue[] {
  return records(value).map((entry) => ({ key: text(entry, 'key'), reason: text(entry, 'reason') }));
}

/**
 * Read the last intake read.
 *
 * @param value - Untrusted `jiraIntake` record.
 * @returns The read, or `null` when there is none.
 */
function readIntake(value: unknown): IntakeRead | null {
  if (value === null || value === undefined) {
    return null;
  }
  const record = data(value);
  return {
    checkedAt: text(record, 'checkedAt'),
    offered: strings(record['offered']),
    skipped: skippedIssues(record['skipped']),
    retryAfterSeconds: number(record, 'retryAfterSeconds'),
    error: text(record, 'error'),
  };
}

/**
 * Read a saved Jira tracker's workflow from the connection status.
 *
 * @param github - Untrusted `github_status` snapshot.
 * @returns The workflow, or `null` when the tracker is not Jira.
 */
export function readJiraWorkflow(github: Data): JiraWorkflowView | null {
  const tracker = child(child(github, 'connectionV2'), 'tracker');
  if (text(tracker, 'provider') !== 'jira') {
    return null;
  }
  const workflow = child(child(tracker, 'jira'), 'workflow');
  const saved = child(workflow, 'stages');
  const stages: Record<string, string> = {};
  for (const stage of MAPPED_STAGES) {
    const statusId = text(child(saved, stage), 'statusId');
    if (statusId !== '') {
      stages[stage] = statusId;
    }
  }
  return {
    jql: text(child(workflow, 'intake'), 'jql'),
    stages,
    statuses: records(child(tracker, 'workflowField')['options']).map((option) => {
      return {
        id: text(option, 'id'),
        name: text(option, 'name'),
      };
    }),
    lastIntake: readIntake(github['jiraIntake']),
  };
}

/**
 * The draft a saved workflow starts from.
 *
 * @param view - Saved workflow.
 * @returns Unchanged draft.
 */
export function workflowDraft(view: JiraWorkflowView): JiraWorkflowDraft {
  return { jql: view.jql, stages: { ...view.stages } };
}

/**
 * Explain what is wrong with a draft before anything is sent.
 *
 * @param draft - Operator's choices.
 * @returns The first problem, or `null` when it may be saved.
 */
export function workflowProblem(draft: JiraWorkflowDraft): string | null {
  return draft.jql.trim().length > JQL_MAX ? t('Keep the intake filter under 2,000 characters.') : null;
}

/**
 * The save control for a draft.
 *
 * @param draft - Operator's choices.
 * @param statuses - The project's statuses, for their names.
 * @returns `jira_workflow_save` control; an empty filter turns intake off.
 */
export function workflowSaveInput(
  draft: JiraWorkflowDraft,
  statuses: readonly JiraStatus[],
): { readonly operation: 'jira_workflow_save'; readonly input: Data } {
  const stages: Record<string, { statusId: string; statusName: string }> = {};
  for (const stage of MAPPED_STAGES) {
    const status = statuses.find((candidate) => candidate.id === draft.stages[stage]);
    if (status !== undefined) {
      stages[stage] = { statusId: status.id, statusName: status.name };
    }
  }
  const jql = draft.jql.trim();
  return { operation: 'jira_workflow_save', input: { jql: jql === '' ? null : jql, stages } };
}

/**
 * Read the preview a save returned.
 *
 * @param value - Untrusted `jira_workflow_save` result.
 * @returns What intake would file, or `null` when no filter was saved.
 */
export function readIntakePreview(value: unknown): IntakePreview | null {
  const preview = data(value)['intakePreview'];
  if (preview === null || preview === undefined) {
    return null;
  }
  const record = data(preview);
  return {
    queue: strings(record['queue']),
    skipped: skippedIssues(record['skipped']),
    isTruncated: record['isTruncated'] === true,
  };
}

/**
 * Describe why intake skipped an issue.
 *
 * @param reason - `done`, `resolved`, `reassigned` or `already_queued`.
 * @returns Translated reason; an unknown reason is shown as it came.
 */
export function skipReasonLabel(reason: string): string {
  const labels: Readonly<Record<string, string>> = {
    done: t('done in Jira'),
    resolved: t('resolved in Jira'),
    reassigned: t('assigned to someone else'),
    already_queued: t('already an objective'),
  };
  return labels[reason] ?? reason;
}
