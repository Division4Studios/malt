/**
 * Typed view of the compiled `recommendations-model` browser module for DOM-free tests.
 * `npm run check` builds web/dist after typecheck, so the file does not exist yet when types are checked.
 *
 * @file
 */

declare module '*/web/dist/recommendations-model.js' {
  /** One display lane. */
  type RecommendationLane = 'pending' | 'approved' | 'applying' | 'completed' | 'rejected' | 'stale' | 'failed';

  /** One recommendation as a list row shows it. */
  interface RecommendationSummary {
    /** Stable identity. */
    readonly id: string;
    /** Exact content revision. */
    readonly revision: string;
    /** Backend lifecycle state. */
    readonly state: string;
    /** Display lane. */
    readonly lane: RecommendationLane;
    /** Not yet opened. */
    readonly isUnread: boolean;
    /** Visible proposal kind. */
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
  interface RecommendationCounts {
    /** Every recommendation. */
    readonly total: number;
    /** Not yet opened. */
    readonly unread: number;
    /** Not yet settled. */
    readonly pending: number;
    /** Waiting for a human decision. */
    readonly awaitingHuman: number;
  }

  /** One validated list page. */
  interface RecommendationPage {
    /** Rows on this page. */
    readonly items: readonly RecommendationSummary[];
    /** Project totals. */
    readonly counts: RecommendationCounts;
    /** Digest of identities, revisions and states. */
    readonly contentRevision: string;
  }

  /** Lanes in display order. */
  export const RECOMMENDATION_LANES: readonly RecommendationLane[];

  /**
   * Validate one list page.
   *
   * @param value - Untrusted response.
   * @returns Valid rows and counts, or null when malformed.
   */
  export function readPage(value: unknown): RecommendationPage | null;

  /**
   * A key that changes exactly when visible content changes.
   *
   * @param page - Current page.
   * @returns Content revision plus each row's unread state.
   */
  export function renderKey(page: RecommendationPage): string;

  /**
   * Rows grouped by lane.
   *
   * @param items - Page rows.
   * @returns Non-empty lanes in order.
   */
  export function laneGroups(
    items: readonly RecommendationSummary[],
  ): { lane: RecommendationLane; items: RecommendationSummary[] }[];

  /**
   * The accessible name of the counts.
   *
   * @param counts - Project totals.
   * @returns Readable counts.
   */
  export function countLabel(counts: RecommendationCounts): string;

  /**
   * Referenced tickets as text.
   *
   * @param tickets - Issue numbers.
   * @returns Readable list.
   */
  export function ticketText(tickets: readonly number[]): string;
}
