/**
 * Typed view of the compiled `liveness-text` browser module for DOM-free tests.
 * `npm run check` builds web/dist after typecheck, so the file does not exist yet when types are checked.
 *
 * @file
 */

declare module '*/web/dist/liveness-text.js' {
  /** The quota reading the extension gate trusts. */
  interface Quota {
    /** `current`, `stale` or `unknown`. */
    readonly freshness: 'current' | 'stale' | 'unknown';
    /** Headroom, only for a current reading. */
    readonly headroomPercent: number | null;
    /** Oldest observation. */
    readonly observedAt: number | null;
  }
  /** Why the latest attempt stopped at a checkpoint. */
  interface Stop {
    /** Stopped attempt. */
    readonly jobId: string;
    /** Recorded reason. */
    readonly reason: string;
    /** Stop time. */
    readonly at: number;
    /** Whether the operator's decision is pending. */
    readonly isAwaitingDecision: boolean;
  }

  /**
   * The quota reading an extension would rest on, or why there is none.
   *
   * @param quota - Quota evidence.
   * @param now - Current time.
   * @returns Headroom and age, or that it is stale or unknown.
   */
  export function quotaText(quota: Quota | null, now: number): string;

  /**
   * Time an attempt has run.
   *
   * @param startedAt - Start time.
   * @param now - Current time.
   * @returns Duration, or `—`.
   */
  export function elapsedText(startedAt: number, now: number): string;

  /**
   * Why a delivery's latest attempt stopped.
   *
   * @param stop - Recorded stop.
   * @returns Stop reason, marked while a decision is pending.
   */
  export function stopText(stop: Stop): string;

  /**
   * What became of an attempt.
   *
   * @param row - Attempt listing row.
   * @returns Recorded stop reason, or its state.
   */
  export function attemptOutcome(row: Readonly<Record<string, unknown>>): string;

  /**
   * Progress evidence for one running assignment in the mission brief.
   *
   * @param job - Running assignment from the brief.
   * @param now - Current time.
   * @returns Liveness or checkpoint and output times, then quota.
   */
  export function briefProgress(job: Readonly<Record<string, unknown>>, now: number): string;
}
