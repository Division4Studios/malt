/**
 * Typed view of compiled browser modules imported by DOM-free tests.
 * `npm run check` builds web/dist after typecheck, so the files do not exist yet when types are checked.
 *
 * @file
 */

declare module '*/web/dist/brand-ui.js' {
  /**
   * Group every objective without truncation.
   *
   * @param objectives - Product objectives in original order.
   * @returns Complete labelled phase groups.
   */
  export function objectiveGroups(
    objectives: Record<string, unknown>[],
  ): { title: string; items: Record<string, unknown>[] }[];
}

declare module '*/web/dist/capacity-details.js' {
  /**
   * Remove every sample-derived field from factory state.
   *
   * @param factory - Factory snapshot.
   * @returns Factory state that is stable across sampling cycles.
   */
  export function stableFactory(factory: Record<string, unknown>): Record<string, unknown>;

  /**
   * Flatten owned process measurements into displayed cells.
   *
   * @param factory - Factory snapshot.
   * @returns Process rows and roles without a measured process.
   */
  export function processUsageRows(factory: Record<string, unknown>): { rows: string[][]; unavailable: string[] };
}

declare module '*/web/dist/telemetry-format.js' {
  /**
   * Format a USD amount, keeping unknown distinct from zero.
   *
   * @param usd - Amount, or null when unknown.
   * @returns Display text.
   */
  export function formatUsd(usd: number | null): string;

  /**
   * Format an attempt cost with its source.
   *
   * @param usd - Amount, or null when unpriced.
   * @param source - Reported, estimated or unpriced.
   * @returns Display text; estimates carry a tilde.
   */
  export function formatCost(usd: number | null, source: string): string;

  /**
   * Format a token count compactly.
   *
   * @param tokens - Count, or null when not reported.
   * @returns Display text.
   */
  export function formatTokens(tokens: number | null): string;

  /**
   * Format a duration.
   *
   * @param milliseconds - Elapsed time, or null when unknown.
   * @returns Display text.
   */
  export function formatDuration(milliseconds: number | null): string;

  /**
   * Group newest-first rows into calendar days.
   *
   * @param rows - Rows with a start time.
   * @param timeZone - IANA zone.
   * @returns Day groups in first-seen order.
   */
  export function groupByDay<Row extends { readonly startedAt: number }>(
    rows: readonly Row[],
    timeZone: string,
  ): { day: string; rows: Row[] }[];

  /**
   * Lay out stacked daily bars by role series.
   *
   * @param daily - Days with per-role USD.
   * @param height - Plot height.
   * @param gap - Gap between segments.
   * @returns Bars, present series and the scale maximum.
   */
  export function stackBars(
    daily: readonly { day: string; totalUsd: number; byRole: Readonly<Record<string, number>> }[],
    height: number,
    gap: number,
  ): {
    bars: { day: string; total: number; segments: { series: string; value: number; y: number; height: number }[] }[];
    series: string[];
    max: number;
  };
}

declare module '*/web/dist/price-editor.js' {
  /**
   * Validate edited price rows.
   *
   * @param rows - Raw model and price strings per row.
   * @returns Valid rows, or an error explaining the first problem.
   */
  export function validatePrices(rows: readonly Readonly<Record<string, string>>[]):
    | {
        prices: { model: string; input: number; cachedInput: number; cacheWrite: number; output: number }[];
      }
    | { error: string };
}
