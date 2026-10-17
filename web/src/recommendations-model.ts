/**
 * DOM-free reading of the broker's recommendation pages and details for the
 * Project → Recommendations pane: lanes by state, accessible pending and
 * unread counts, and a render key that changes only when what the pane shows
 * changes, so polling an unchanged page never redraws it.
 *
 * @file
 */
import { asData } from './console-model.js';
import { phrase, t, translated } from './i18n.js';

import type { Data } from './api.js';

/** Lanes in display order; every backend state belongs to exactly one. */
export const RECOMMENDATION_LANES = [
  'pending',
  'approved',
  'applying',
  'completed',
  'rejected',
  'stale',
  'failed',
] as const;
/** One display lane. */
export type RecommendationLane = (typeof RECOMMENDATION_LANES)[number];

/** Backend lifecycle state → lane. */
const LANE_OF: Readonly<Record<string, RecommendationLane>> = {
  proposed: 'pending',
  awaiting_human: 'pending',
  approved: 'approved',
  applying: 'applying',
  reconciling: 'applying',
  completed: 'completed',
  rejected: 'rejected',
  stale: 'stale',
  failed: 'failed',
};
/** Visible lane names. */
export const LANE_LABELS: Readonly<Record<RecommendationLane, string>> = translated({
  pending: phrase('Pending'),
  approved: phrase('Approved'),
  applying: phrase('Applying'),
  completed: phrase('Completed'),
  rejected: phrase('Rejected'),
  stale: phrase('Stale'),
  failed: phrase('Failed'),
});
/** Visible proposal kinds. */
const KIND_LABELS: Readonly<Record<string, string>> = translated({
  duplicate: phrase('Duplicate tickets'),
  related: phrase('Related tickets'),
  consolidate: phrase('Consolidate tickets'),
  scope_change: phrase('Scope change'),
  guidance_suggestion: phrase('Guidance suggestion'),
});

/** One recommendation as a list row shows it. */
export interface RecommendationSummary {
  /** Stable identity. */
  readonly id: string;
  /** Exact content revision. */
  readonly revision: string;
  /** Backend lifecycle state. */
  readonly state: string;
  /** Display lane. */
  readonly lane: RecommendationLane;
  /** Not yet opened by the operator. */
  readonly isUnread: boolean;
  /** Proposal kind as the broker names it; `kindLabel` translates it when shown. */
  readonly kind: string;
  /** Referenced issue numbers. */
  readonly tickets: readonly number[];
  /** Proposed action. */
  readonly action: string;
  /** Supporting evidence. */
  readonly evidence: readonly string[];
  /** Text before the change. */
  readonly before: string;
  /** Text after the change. */
  readonly after: string;
}

/** Project totals. */
export interface RecommendationCounts {
  /** Not yet opened. */
  readonly unread: number;
  /** Not yet settled. */
  readonly pending: number;
}

/** One validated list page. */
export interface RecommendationPage {
  /** Rows on this page. */
  readonly items: readonly RecommendationSummary[];
  /** Project totals. */
  readonly counts: RecommendationCounts;
  /** Digest of the page's identities, revisions and states. */
  readonly contentRevision: string;
  /** Cursor of the next page; the broker pages at most 20 rows. */
  readonly nextCursor: string | null;
}

/**
 * The members of an untrusted array that pass a type check.
 *
 * @param value - Untrusted collection.
 * @param isMember - Type check for one member.
 * @returns Matching members, or none when `value` is not an array.
 */
function members<Member>(value: unknown, isMember: (item: unknown) => item is Member): Member[] {
  return Array.isArray(value) ? (value as unknown[]).filter(isMember) : [];
}

/**
 * Whether a value is text.
 *
 * @param item - Untrusted member.
 * @returns True for strings.
 */
const isText = (item: unknown): item is string => typeof item === 'string';

/**
 * Whether a value is an issue number.
 *
 * @param item - Untrusted member.
 * @returns True for positive safe integers.
 */
const isIssue = (item: unknown): item is number => typeof item === 'number' && Number.isSafeInteger(item) && item > 0;

/**
 * A string field, or empty.
 *
 * @param value - Object holding it.
 * @param key - Field to read.
 * @returns The string, or `''`.
 */
function field(value: Data, key: string): string {
  const read = value[key];
  return typeof read === 'string' ? read : '';
}

/**
 * Read one summary or detail record.
 *
 * @param value - Untrusted record.
 * @returns Summary, or `null` when its identity or state is unusable.
 */
function readSummary(value: unknown): RecommendationSummary | null {
  const record = asData(value);
  const lane = record === null ? undefined : LANE_OF[field(record, 'state')];
  if (record === null || lane === undefined || field(record, 'id') === '' || field(record, 'revision') === '') {
    return null;
  }
  const body = asData(record['body']) ?? {};
  const preview = asData(body['preview']) ?? {};
  return {
    id: field(record, 'id'),
    revision: field(record, 'revision'),
    state: field(record, 'state'),
    lane,
    isUnread: record['unread'] === true,
    kind: field(body, 'kind'),
    tickets: members(body['tickets'], isIssue),
    action: field(body, 'action'),
    evidence: members(body['evidence'], isText),
    before: field(preview, 'before'),
    after: field(preview, 'after'),
  };
}

/**
 * A non-negative count, or zero.
 *
 * @param value - Counts object.
 * @param key - Count to read.
 * @returns The count, or zero when missing or invalid.
 */
function count(value: Data, key: string): number {
  const read = value[key];
  return typeof read === 'number' && Number.isSafeInteger(read) && read >= 0 ? read : 0;
}

/**
 * Validate one list page from `/api/recommendations`.
 *
 * @param value - Untrusted response.
 * @returns Page, or `null` for a malformed response.
 */
export function readPage(value: unknown): RecommendationPage | null {
  const page = asData(value);
  if (page === null || !Array.isArray(page['items']) || typeof page['contentRevision'] !== 'string') {
    return null;
  }
  const counts = asData(page['counts']) ?? {};
  const cursor = page['nextCursor'];
  return {
    items: page['items'].map((item: unknown) => readSummary(item)).filter((item) => item !== null),
    counts: {
      unread: count(counts, 'unread'),
      pending: count(counts, 'pending'),
    },
    contentRevision: page['contentRevision'],
    nextCursor: typeof cursor === 'string' && cursor !== '' ? cursor : null,
  };
}

/**
 * A key that changes exactly when the pane's visible content changes.
 *
 * @param page - Current page.
 * @returns Content revision plus each row's unread state.
 */
export function renderKey(page: RecommendationPage): string {
  return JSON.stringify([page.contentRevision, page.items.map((item) => [item.id, item.isUnread]), page.counts]);
}

/**
 * Rows grouped by lane, in lane order, without empty lanes.
 *
 * @param items - Page rows.
 * @returns Non-empty lanes.
 */
export function laneGroups(
  items: readonly RecommendationSummary[],
): { lane: RecommendationLane; items: RecommendationSummary[] }[] {
  return RECOMMENDATION_LANES.map((lane) => ({ lane, items: items.filter((item) => item.lane === lane) })).filter(
    (group) => group.items.length > 0,
  );
}

/**
 * A proposal kind in the current language, read at render time.
 *
 * @param kind - Kind as the broker names it.
 * @returns Visible label; an unknown kind is shown as sent.
 */
export function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

/**
 * The accessible name of the Project section's counts.
 *
 * @param counts - Project totals.
 * @returns Readable pending and unread counts.
 */
export function countLabel(counts: RecommendationCounts): string {
  return t('{pending} pending and {unread} unread recommendations', { pending: counts.pending, unread: counts.unread });
}

/**
 * Referenced tickets as text.
 *
 * @param tickets - Issue numbers.
 * @returns `#1, #2`, or a plain note when none.
 */
export function ticketText(tickets: readonly number[]): string {
  return tickets.length === 0 ? t('No tickets') : tickets.map((ticket) => `#${String(ticket)}`).join(', ');
}
