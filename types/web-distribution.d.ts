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

declare module '*/web/dist/console-model.js' {
  /** Plain step state. */
  type StepState = 'done' | 'running' | 'ready' | 'needs_you' | 'waiting';
  /** Board column. */
  type Column = 'planning' | 'ready' | 'in_progress' | 'needs_you' | 'done';
  /** Validated pipeline step. */
  export interface Step {
    /** Step id. */
    readonly id: string;
    /** Human title. */
    readonly title: string;
    /** Execution layer. */
    readonly layer: number;
    /** Plain state. */
    readonly state: StepState;
    /** Seats that may perform it. */
    readonly roles: readonly string[];
    /** Latest result. */
    readonly result: {
      readonly outcome: string;
      readonly summary: string;
      readonly findings: readonly string[];
      readonly dispositions: readonly { id: string; decision: string; reason: string; evidence: string }[];
    } | null;
  }
  /** Validated delivery card. */
  export interface Delivery {
    /** Delivery id. */
    readonly taskId: string;
    /** Issue number. */
    readonly issue: number;
    /** Title. */
    readonly title: string;
    /** Board column. */
    readonly column: Column;
    /** Workflow identity. */
    readonly workflow: { readonly id: string; readonly name: string };
    /** Steps. */
    readonly steps: readonly Step[];
    /** Live attempt. */
    readonly running: { readonly jobId: string; readonly role: string; readonly step: string | null } | null;
    /** Current head. */
    readonly head: string | null;
    /** Pull request link. */
    readonly prUrl: string | null;
    /** Blocking dependency issues. */
    readonly waitingOn: readonly number[];
  }
  /** Validated open Inbox item. */
  export interface InboxItem {
    /** Item id. */
    readonly id: string;
    /** Decision kind. */
    readonly kind: string;
    /** Headline. */
    readonly title: string;
    /** Delivery concerned. */
    readonly taskId: string | null;
    /** Objective concerned. */
    readonly featureId: string | null;
    /** Step to decide. */
    readonly stepId: string | null;
    /** Bound head. */
    readonly head: string | null;
  }
  /** Validated console projection. */
  export interface ConsoleModel {
    /** Deliveries. */
    readonly deliveries: readonly Delivery[];
    /** Objectives. */
    readonly objectives: readonly {
      readonly featureId: string;
      readonly title: string;
      readonly column: Column;
      readonly steps: readonly Step[];
    }[];
    /** Open decisions. */
    readonly open: readonly InboxItem[];
    /** Answered decisions. */
    readonly answered: readonly {
      readonly id: string;
      readonly title: string;
      readonly note: string;
      readonly at: number;
    }[];
  }

  /**
   * Read the console projection from a snapshot.
   *
   * @param snapshot - Untrusted snapshot.
   * @returns Validated projection.
   */
  export function readConsole(snapshot: unknown): ConsoleModel;

  /**
   * Count decisions waiting on the human.
   *
   * @param snapshot - Untrusted snapshot.
   * @returns Open Inbox items.
   */
  export function inboxCount(snapshot: unknown): number;

  /**
   * Describe how long ago something happened.
   *
   * @param since - Event time.
   * @param now - Current time.
   * @returns Relative age text.
   */
  export function relativeAge(since: number, now: number): string;

  /**
   * Shorten a commit id.
   *
   * @param sha - Commit id.
   * @returns Short form.
   */
  export function shortSha(sha: string | null): string;

  /**
   * Bound an error to its leading lines.
   *
   * @param message - Full text.
   * @param lines - Lines kept.
   * @returns Leading lines.
   */
  export function excerpt(message: string, lines?: number): string;

  /**
   * Split a severity tag from a finding.
   *
   * @param finding - Finding text.
   * @returns Severity and remaining text.
   */
  export function findingSeverity(finding: string): { severity: string | null; text: string };

  /**
   * Group steps by execution layer.
   *
   * @param steps - Steps in workflow order.
   * @returns Ascending layers.
   */
  export function layerGroups(steps: readonly Step[]): { layer: number; steps: Step[] }[];

  /**
   * Turn steps into strip segments.
   *
   * @param steps - Steps in workflow order.
   * @returns Segments and caption.
   */
  export function stepStrip(steps: readonly Step[]): {
    segments: { id: string; state: StepState; label: string }[];
    caption: string;
  };

  /**
   * Describe the running step.
   *
   * @param delivery - Card whose live attempt is described.
   * @returns Role and step title, or null.
   */
  export function runningText(delivery: Delivery): string | null;
}

declare module '*/web/dist/board-model.js' {
  /** Validated console projection, as returned by `readConsole`. */
  interface ConsoleModel {
    /** Deliveries. */
    readonly deliveries: readonly unknown[];
    /** Objectives. */
    readonly objectives: readonly unknown[];
  }

  /** Board filters plus the selected narrow-screen tab. */
  interface Prefs {
    /** Text filter. */
    readonly query: string;
    /** Workflow filter. */
    readonly workflow: string;
    /** Show finished cards. */
    readonly showDone: boolean;
    /** Selected tab. */
    readonly tab: string;
  }

  /**
   * Group cards into columns.
   *
   * @param model - Console projection.
   * @param filter - Filters.
   * @returns Cards per column and hidden finished count.
   */
  export function groupBoard(
    model: ConsoleModel,
    filter: Omit<Prefs, 'tab'>,
  ): { columns: Record<string, { type: string; key: string }[]>; hiddenDone: number };

  /**
   * List workflows on the board.
   *
   * @param model - Console projection.
   * @returns Unique workflows by name.
   */
  export function workflowChoices(model: ConsoleModel): { id: string; name: string }[];

  /**
   * Restore saved preferences.
   *
   * @param raw - Stored text.
   * @returns Valid preferences.
   */
  export function parsePrefs(raw: string | null): Prefs;

  /**
   * Move between tabs.
   *
   * @param current - Index of the focused tab.
   * @param key - `KeyboardEvent.key` value.
   * @param count - Number of tabs in the list.
   * @returns Index to select, or null when the key does not navigate.
   */
  export function tabTarget(current: number, key: string, count: number): number | null;
}
