/**
 * Provider-typed work keys. A delivery or objective is identified by its
 * tracker and that tracker's own key, `#123` on GitHub or `PROJ-123` in Jira,
 * so no consumer has to assume a numeric issue ID. GitHub keys still map back
 * to their issue number for the GitHub adapter; Jira keys never become numbers.
 *
 * @file
 */
import { z } from 'zod/v3';

import { jiraIssueKeySchema } from '../jira/client.ts';

/** Trackers that can hold a work item. */
export const TRACKER_KEY_PROVIDERS = ['github', 'jira'] as const;
/** A tracker provider. */
export type TrackerKeyProvider = (typeof TRACKER_KEY_PROVIDERS)[number];

/** A GitHub issue number written as text, as the typed-key side tables store it. */
const githubKeySchema = z.string().regex(/^[1-9]\d{0,17}$/v);

/** A provider-typed work key. */
export const trackerKeySchema = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('github'), key: githubKeySchema }).strict(),
  z.object({ provider: z.literal('jira'), key: jiraIssueKeySchema }).strict(),
]);
/** A provider-typed work key. */
export type TrackerKey = z.output<typeof trackerKeySchema>;

/**
 * An issue as an operator or model names it in a tool call: a GitHub or local
 * issue number (`12` or `"#12"`) or a Jira key (`"PROJ-12"`).
 */
export const issueReferenceSchema = z.union([
  z.number().int().positive(),
  z
    .string()
    .trim()
    .regex(/^(?:#?[1-9]\d{0,17}|[A-Z][\dA-Z_]{1,99}-[1-9]\d{0,17})$/v),
]);
/** An issue as a tool call names it. */
export type IssueReference = z.output<typeof issueReferenceSchema>;

/**
 * The display key an issue reference names, comparable with {@link issueLabel}.
 *
 * @param reference - Number, `#12` or `PROJ-12`.
 * @returns `#12` or `PROJ-12`.
 */
export function referenceLabel(reference: IssueReference): string {
  if (typeof reference === 'number') {
    return `#${String(reference)}`;
  }
  return /^\d/v.test(reference) ? `#${reference}` : reference;
}

/**
 * The key of a GitHub issue.
 *
 * @param issue - GitHub issue number.
 * @returns Typed key.
 */
export function githubKey(issue: number): TrackerKey {
  return trackerKeySchema.parse({ provider: 'github', key: String(issue) });
}

/**
 * Parse a stored or user-supplied key for one provider.
 *
 * @param provider - Tracker the key belongs to.
 * @param raw - Key text: `123` or `#123` for GitHub, `PROJ-123` for Jira.
 * @returns Typed key, or `null` when the text is not a key of that tracker.
 */
export function parseTrackerKey(provider: string, raw: string): TrackerKey | null {
  const text = raw.trim();
  const key = provider === 'github' && text.startsWith('#') ? text.slice(1) : text;
  const parsed = trackerKeySchema.safeParse({ provider, key });
  return parsed.success ? parsed.data : null;
}

/**
 * How a key is shown to people: `#123` on GitHub, `PROJ-123` in Jira.
 *
 * @param key - Typed key.
 * @returns Display text.
 */
export function formatTrackerKey(key: TrackerKey): string {
  return key.provider === 'github' ? `#${key.key}` : key.key;
}

/**
 * The GitHub issue number of a key, for the GitHub adapter only.
 *
 * @param key - Typed key.
 * @returns Issue number, or `null` for any other tracker.
 */
export function githubIssueNumber(key: TrackerKey): number | null {
  return key.provider === 'github' ? Number(key.key) : null;
}

/**
 * The key's part of a branch name. Jira's development panel links branches
 * whose names contain the issue key exactly, so Jira keys keep their case.
 *
 * @param key - Typed key.
 * @returns `issue-123` for GitHub, `PROJ-123` for Jira.
 */
export function branchKey(key: TrackerKey): string {
  return key.provider === 'github' ? `issue-${key.key}` : key.key;
}

/**
 * Split a key into the parts it sorts by.
 *
 * @param key - Typed key.
 * @returns Provider, project prefix (empty for GitHub) and sequence number.
 */
function sortParts(key: TrackerKey): readonly [string, string, number] {
  if (key.provider === 'github') {
    return [key.provider, '', Number(key.key)];
  }
  const dash = key.key.lastIndexOf('-');
  return [key.provider, key.key.slice(0, dash), Number(key.key.slice(dash + 1))];
}

/**
 * Stable order: by tracker, then project, then sequence number (so `PROJ-9` precedes `PROJ-10`).
 *
 * @param left - First key.
 * @param right - Second key.
 * @returns Negative, zero or positive, as `Array#sort` expects.
 */
export function compareTrackerKeys(left: TrackerKey, right: TrackerKey): number {
  const [leftProvider, leftProject, leftNumber] = sortParts(left);
  const [rightProvider, rightProject, rightNumber] = sortParts(right);
  const byProvider = leftProvider.localeCompare(rightProvider);
  if (byProvider !== 0) {
    return byProvider;
  }
  const byProject = leftProject.localeCompare(rightProject);
  return byProject === 0 ? leftNumber - rightNumber : byProject;
}

/** A ledger record's issue: the numeric handle every ledger row keeps, and the typed key a non-GitHub tracker wrote. */
export interface KeyedIssue {
  /** Numeric ledger handle: the GitHub or local issue number, or a Jira issue's stable numeric ID. */
  readonly issue: number;
  /** Typed key; absent on GitHub and local records, whose key is their issue number. */
  readonly trackerKey?: TrackerKey | undefined;
}
/** A ledger record's parent issue, keyed the same way. */
export interface KeyedParent {
  /** Numeric ledger handle of the parent issue. */
  readonly parentIssue: number;
  /** Typed parent key; absent on GitHub and local records. */
  readonly parentKey?: TrackerKey | undefined;
}

/**
 * The typed key of a delivery or imported issue. Records saved before typed
 * keys, and every GitHub or local record, derive it from their issue number.
 *
 * @param record - Delivery, Ready issue or provisioned mapping.
 * @returns Typed key.
 */
export function issueKey(record: KeyedIssue): TrackerKey {
  return record.trackerKey ?? githubKey(record.issue);
}

/**
 * The typed key of a record's parent issue.
 *
 * @param record - Delivery, Ready issue or provisioned mapping.
 * @returns Typed parent key.
 */
export function parentKey(record: KeyedParent): TrackerKey {
  return record.parentKey ?? githubKey(record.parentIssue);
}

/**
 * How a record's issue is shown to people: `#123` or `PROJ-123`.
 *
 * @param record - Delivery, Ready issue or provisioned mapping.
 * @returns Display text.
 */
export function issueLabel(record: KeyedIssue): string {
  return formatTrackerKey(issueKey(record));
}

/**
 * How a record's parent issue is shown to people.
 *
 * @param record - Delivery, Ready issue or provisioned mapping.
 * @returns Display text.
 */
export function parentLabel(record: KeyedParent): string {
  return formatTrackerKey(parentKey(record));
}

/**
 * The typed key of an objective's parent issue.
 *
 * @param feature - Objective, possibly not yet provisioned.
 * @param feature.parentIssue - Parent handle, null before provisioning.
 * @param feature.parentKey - Typed parent key, absent for GitHub and local parents.
 * @returns Typed parent key, or `null` before the parent exists.
 */
export function objectiveParentKey(feature: {
  readonly parentIssue: number | null;
  readonly parentKey?: TrackerKey | undefined;
}): TrackerKey | null {
  return feature.parentIssue === null ? null : (feature.parentKey ?? githubKey(feature.parentIssue));
}
