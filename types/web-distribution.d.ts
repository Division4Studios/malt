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

declare module '*/web/dist/selection-ui.js' {
  /**
   * Format only immutable recorded assignment fields for display.
   *
   * @param job - Validated public job data.
   * @returns Plain native definition-list rows.
   */
  export function selectionRows(job: Record<string, unknown>): [string, string][];

  /**
   * Build the request-evidence disclosure for one recorded assignment.
   *
   * @param job - Recorded assignment, or an empty record when none was claimed.
   * @param diagnostic - Current supervisor diagnostic, shown separately.
   * @returns The disclosure element (a test-DOM element under Node).
   */
  export function selectionDetails(job: Record<string, unknown>, diagnostic: string): unknown;
}

declare module '*/web/dist/admission-ui.js' {
  /**
   * Read-only dispatch evidence lines.
   *
   * @param factory - Selected project snapshot.
   * @returns Bounded plain evidence.
   */
  export function admissionLines(factory: Record<string, unknown>): string[];

  /**
   * Describe actual cached resource sample age.
   *
   * @param factory - Selected project snapshot.
   * @param now - Injectable observation clock.
   * @returns Measured counters with honest gaps.
   */
  export function admissionSample(factory: Record<string, unknown>, now?: number): string;

  /**
   * Mount the read-only admission explanation into a panel.
   *
   * @param target - Panel element (a test-DOM element under Node).
   * @param factory - Selected project's factory snapshot.
   */
  export function appendAdmission(target: unknown, factory: Record<string, unknown>): void;
}

declare module '*/web/dist/capacity-details.js' {
  /**
   * Format a verified percent, including zero, without inventing unknown values.
   *
   * @param value - Untrusted utilization.
   * @returns Accessible usage or unknown.
   */
  export function quotaUsage(value: unknown): string;

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

  /**
   * Refresh measured values in the mounted capacity panel without rebuilding it.
   *
   * @param factory - Latest project-scoped factory snapshot.
   */
  export function refreshCapacitySamples(factory: unknown): void;
}
