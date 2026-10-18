/**
 * Provider-typed work keys. A delivery or objective is identified by its
 * tracker and that tracker's own key, `#123` on GitHub or `PROJ-123` in Jira,
 * so no consumer has to assume a numeric issue ID. GitHub keys still map back
 * to their issue number for the GitHub adapter; Jira keys never become numbers.
 *
 * @file
 */
import { z } from 'zod/v3';

import { selectOne } from '../database.ts';
import { jiraIssueKeySchema } from '../jira/client.ts';

import type { Store } from '../store.ts';

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

/** One `factory_task_keys` row. */
const keyRowSchema = z.object({ tracker_provider: z.string(), external_key: z.string() });

/**
 * A delivery's typed key from the additive side table the ledger already keeps.
 *
 * @param store - Selected project's SQLite owner.
 * @param taskId - Delivery identifier.
 * @returns Typed key, or `null` for an unknown delivery or an unrecognised row.
 */
export function taskTrackerKey(store: Store, taskId: string): TrackerKey | null {
  const row = selectOne(
    store.db,
    keyRowSchema,
    'SELECT tracker_provider, external_key FROM factory_task_keys WHERE task_id=?',
    taskId,
  );
  return row === undefined ? null : parseTrackerKey(row.tracker_provider, row.external_key);
}
