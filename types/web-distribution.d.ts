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

declare module '*/web/dist/diff-model.js' {
  /** One rendered diff row. */
  interface DiffRow {
    /** Row kind. */
    readonly kind: 'add' | 'del' | 'ctx' | 'hunk';
    /** Old line number. */
    readonly old: string;
    /** New line number. */
    readonly new: string;
    /** Line text. */
    readonly text: string;
  }

  /** Change kind. */
  type DiffStatus = 'added' | 'deleted' | 'modified' | 'renamed' | 'copied' | 'type_changed';

  /** One changed file. */
  interface DiffFileView {
    /** Current path. */
    readonly path: string;
    /** Source path of a rename or copy. */
    readonly oldPath: string | null;
    /** Change kind. */
    readonly status: DiffStatus;
    /** Added lines. */
    readonly additions: number | null;
    /** Removed lines. */
    readonly deletions: number | null;
    /** Binary content. */
    readonly isBinary: boolean;
    /** Octal mode at the base. */
    readonly baseMode: string;
    /** Octal mode at the head. */
    readonly headMode: string;
    /** Similarity percent. */
    readonly similarity: number | null;
  }

  /** The changed files of a delivery head. */
  interface ReadySummary {
    /** Ready to show. */
    readonly state: 'ready';
    /** Base commit. */
    readonly base: string;
    /** Head commit. */
    readonly head: string;
    /** Listed files. */
    readonly files: readonly DiffFileView[];
    /** Totals. */
    readonly totals: { readonly files: number; readonly additions: number; readonly deletions: number };
    /** Hidden private changes. */
    readonly privateChanges: number;
    /** More files than listed. */
    readonly isTruncated: boolean;
  }

  /** Nothing to show. */
  interface Unavailable {
    /** Nothing to show. */
    readonly state: 'unavailable';
    /** Why. */
    readonly reason: string;
  }

  /** One file's parsed patch. */
  interface ReadyPatch {
    /** Ready to show. */
    readonly state: 'ready';
    /** File. */
    readonly path: string;
    /** Rows. */
    readonly rows: readonly DiffRow[];
    /** Header notes. */
    readonly notes: readonly string[];
    /** Cut short. */
    readonly isTruncated: boolean;
    /** Full patch bytes. */
    readonly bytes: number | null;
  }

  /** Changed lines above which a file starts collapsed. */
  export const LARGE_FILE_LINES: number;
  export function readDiffSummary(value: unknown): ReadySummary | Unavailable;
  export function readDiffPatch(value: unknown): ReadyPatch | Unavailable;
  export function diffRoute(project: string, taskId: string, path?: string): string;
  export function statusText(file: DiffFileView): string;
  export function countText(file: DiffFileView): string;
  export function fileNotes(file: DiffFileView): string[];
  export function totalsText(summary: ReadySummary): string;
  export function summaryNotes(summary: ReadySummary): string[];
  export function isLargeFile(file: DiffFileView): boolean;
  export function truncationText(patch: ReadyPatch): string | null;
}

declare module '*/web/dist/onboarding-model.js' {
  /** One onboarding step's progress. */
  type StepProgress = 'blocked' | 'current' | 'done' | 'todo';

  /** One rendered step. */
  interface OnboardingStep {
    /** Identity. */
    readonly id: 'connect' | 'factory' | 'objective' | 'outcome' | 'preflight' | 'start' | 'workflow';
    /** Heading. */
    readonly title: string;
    /** Progress. */
    readonly progress: StepProgress;
    /** What the operator sees under the heading. */
    readonly detail: string;
  }

  /** A broker-side preflight. */
  interface PreflightView {
    /** False when any check failed. */
    readonly ok: boolean;
    /** Checks in display order. */
    readonly checks: readonly {
      readonly id: string;
      readonly label: string;
      readonly status: 'fail' | 'fix-it' | 'pass';
      readonly detail: string;
      readonly fix: string | null;
    }[];
  }

  /**
   * Validate a preflight response.
   *
   * @param value - Untrusted route result.
   * @returns Report, or null when it is not one.
   */
  export function readPreflight(value: unknown): PreflightView | null;

  /**
   * Whether a project still needs the first-run flow.
   *
   * @param snapshot - Factory projection and GitHub connection.
   * @returns True before setup, connection or the first objective.
   */
  export function isOnboardingNeeded(snapshot: {
    readonly factory: Record<string, unknown>;
    readonly github: Record<string, unknown>;
  }): boolean;

  /**
   * What happened to the newest objective.
   *
   * @param factory - Factory projection.
   * @param now - Current time.
   * @returns Started, parked with its exact reason, or still waiting.
   */
  export function firstOutcome(
    factory: Record<string, unknown>,
    now: number,
  ): { readonly state: 'parked' | 'started' | 'waiting'; readonly text: string };

  /**
   * Every step, the first unfinished one marked current.
   *
   * @param snapshot - Factory projection and GitHub connection.
   * @param preflight - Broker-side checks, or null before they ran.
   * @param now - Current time.
   * @returns Steps in display order.
   */
  export function onboardingSteps(
    snapshot: { readonly factory: Record<string, unknown>; readonly github: Record<string, unknown> },
    preflight: PreflightView | null,
    now: number,
  ): OnboardingStep[];
}
