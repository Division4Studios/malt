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
    /** Live attempt and its checkpoint liveness. */
    readonly running: {
      readonly jobId: string;
      readonly role: string;
      readonly step: string | null;
      readonly liveness: Liveness | null;
    } | null;
    /** Retry backoff of the latest failed step. */
    readonly retry: Retry | null;
    /** Current head. */
    readonly head: string | null;
    /** Pull request link. */
    readonly prUrl: string | null;
    /** Blocking dependency issues. */
    readonly waitingOn: readonly number[];
    /** Ledger phase. */
    readonly phase: string;
    /** Operator hold. */
    readonly held: { readonly at: number; readonly reason: string } | null;
    /** Kept on the board after finishing. */
    readonly isKept: boolean;
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
    /** Archived total and the latest restorable deliveries. */
    readonly archived: {
      readonly total: number;
      readonly recent: readonly { readonly taskId: string; readonly issue: number; readonly title: string }[];
    };
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

  /** A running attempt's liveness. */
  export interface Liveness {
    /** `progressing`, `idle`, `awaiting_input`, `stalled` or `ceiling`. */
    readonly state: string;
    /** Newest meaningful signal. */
    readonly lastSignal: string | null;
    /** When it last progressed. */
    readonly lastProgressAt: number;
    /** What it waits on. */
    readonly awaiting: string | null;
    /** Next checkpoint. */
    readonly nextCheckpointAt: number;
    /** Extensions granted. */
    readonly extensions: number;
  }

  /** A failed step's retry backoff. */
  export interface Retry {
    /** Failure class. */
    readonly failureClass: string;
    /** Consecutive failures. */
    readonly failures: number;
    /** When it may run again; null once exhausted. */
    readonly retryAt: number | null;
  }

  /**
   * Describe a running attempt's liveness.
   *
   * @param liveness - Latest record.
   * @param now - Current time.
   * @returns State, signal and next checkpoint.
   */
  export function livenessText(liveness: Liveness, now: number): string;

  /**
   * Describe a failed step's retry backoff.
   *
   * @param retry - Retry state.
   * @param now - Current time.
   * @returns Failures and when it retries, or that retries are exhausted.
   */
  export function retryText(retry: Retry, now: number): string;
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

  /**
   * The lifecycle control a delivery offers.
   *
   * @param delivery - Delivery on the board.
   * @returns Label, operation and request input.
   */
  export function lifecycleControl(delivery: {
    readonly taskId: string;
    readonly phase: string;
    readonly held: { readonly at: number; readonly reason: string } | null;
  }): { label: string; operation: string; input: Record<string, unknown> };

  /**
   * Deliveries a bulk action applies to among the cards shown.
   *
   * @param groups - Cards currently shown.
   * @returns Unfinished deliveries to hold and held ones to resume.
   */
  export function bulkTargets(groups: { columns: Record<string, readonly unknown[]>; hiddenDone: number }): {
    hold: string[];
    resume: string[];
  };
}

declare module '*/web/dist/approval-model.js' {
  /** Delivery fields an approval reads. */
  interface Delivery {
    /** Delivery id. */
    readonly taskId: string;
    /** Issue number. */
    readonly issue: number;
    /** Title. */
    readonly title: string;
    /** Current head. */
    readonly head: string | null;
  }
  /** Step fields an approval reads. */
  interface Step {
    /** Step id. */
    readonly id: string;
    /** Title. */
    readonly title: string;
  }
  /** Inbox item fields an approval reads. */
  interface InboxItem {
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

  /** What an approval decides. */
  export interface ApprovalTarget {
    /** Delivery step or objective plan. */
    readonly scope: 'delivery' | 'objective';
    /** Delivery or objective id. */
    readonly id: string;
    /** Step decided. */
    readonly stepId: string;
    /** Bound head. */
    readonly head: string | null;
    /** Step title. */
    readonly stepTitle: string;
    /** Subject. */
    readonly subject: string;
  }

  /**
   * Describe an Inbox approval.
   *
   * @param item - Decision waiting on the operator.
   * @returns What it decides, or null for non-approvals.
   */
  export function targetFromItem(item: InboxItem): ApprovalTarget | null;

  /**
   * Describe a delivery step approval.
   *
   * @param delivery - Card that owns the step.
   * @param step - Step waiting on the human.
   * @param open - Open Inbox items carrying the bound head.
   * @returns What the decision binds.
   */
  export function targetFromStep(delivery: Delivery, step: Step, open: readonly InboxItem[]): ApprovalTarget;

  /**
   * Whether a target is still open.
   *
   * @param target - Decision shown in an open dialog.
   * @param open - Current open Inbox items.
   * @returns Whether a matching approval still waits.
   */
  export function isPending(target: ApprovalTarget, open: readonly InboxItem[]): boolean;

  /**
   * Build the `factory_approve` input.
   *
   * @param target - What is decided.
   * @param decision - Choice, note and idempotency key.
   * @returns Input to send, or an explanation why it cannot be sent.
   */
  export function approvalInput(
    target: ApprovalTarget,
    decision: { requestId: string; approve: boolean; note: string },
  ): { input: Record<string, unknown> } | { error: string };
}

declare module '*/web/dist/workflow-model.js' {
  /** Planning or delivery. */
  export type SectionName = 'planning' | 'delivery';
  /** One editable step; `uid` is browser-only. */
  export interface DraftStep {
    /** Browser-only stable identity. */
    readonly uid: string;
    /** Step key. */
    readonly id: string;
    /** Step kind. */
    readonly kind: string;
    /** Public label. */
    readonly title: string;
    /** Seats that may take the step. */
    readonly roles: readonly string[];
    /** Profile key, or empty. */
    readonly profile: string;
    /** Earlier steps it waits for. */
    readonly after: readonly string[];
    /** Explicit readable outputs, or null for everything it runs after. */
    readonly inputs: readonly string[] | null;
    /** Blind review. */
    readonly blind: boolean;
    /** Human approval after success. */
    readonly gate: boolean;
    /** Skippable per delivery. */
    readonly optional: boolean;
    /** Preferred provider, or empty. */
    readonly provider: string;
    /** Extra guidance. */
    readonly instructions: string;
  }
  /** One editable workflow. */
  export interface DraftWorkflow {
    /** Workflow key. */
    readonly id: string;
    /** Display name. */
    readonly name: string;
    /** Plain description. */
    readonly description: string;
    /** Planning steps. */
    readonly planning: readonly DraftStep[];
    /** Delivery steps. */
    readonly delivery: readonly DraftStep[];
  }
  /** One decoded library entry. */
  export interface LibraryItem {
    /** Workflow key. */
    readonly id: string;
    /** Revision digest. */
    readonly revision: string;
    /** Origin of the definition. */
    readonly source: 'builtin' | 'project';
    /** Whether new objectives use it. */
    readonly isDefault: boolean;
    /** Last project save, or null. */
    readonly updatedAt: number | null;
    /** Definition at this revision. */
    readonly workflow: DraftWorkflow;
  }
  /** The decoded library. */
  export interface Library {
    /** Default workflow id. */
    readonly defaultId: string;
    /** Every usable workflow. */
    readonly items: readonly LibraryItem[];
  }
  /** Where a draft came from. */
  export interface DraftOrigin {
    /** Opened workflow id, or empty. */
    readonly id: string;
    /** Opened revision, or null. */
    readonly revision: string | null;
  }
  /** Planning kinds in menu order. */
  export const PLANNING_KINDS: readonly string[];
  /** Delivery kinds in menu order. */
  export const DELIVERY_KINDS: readonly string[];
  /** Every seat a step may name. */
  export const SEATS: readonly string[];
  /** Provider families. */
  export const PROVIDERS: readonly string[];
  /** Longest valid key. */
  export const KEY_MAX: number;

  /**
   * Whether a value is a valid key.
   *
   * @param value - Candidate key.
   * @returns True when the server accepts it.
   */
  export function isKey(value: string): boolean;

  /**
   * First free key with numeric suffixes.
   *
   * @param base - Preferred key.
   * @param taken - Keys in use.
   * @returns Unused key.
   */
  export function uniqueKey(base: string, taken: ReadonlySet<string>): string;

  /**
   * Derive a unique key from a title.
   *
   * @param title - Free text.
   * @param taken - Keys in use.
   * @param fallback - Key used when the title has no letters or digits.
   * @returns Unused valid key.
   */
  export function deriveKey(title: string, taken: ReadonlySet<string>, fallback?: string): string;

  /**
   * Decode a workflow definition.
   *
   * @param value - Untrusted record.
   * @returns Editable draft.
   */
  export function decodeWorkflow(value: Record<string, unknown>): DraftWorkflow;

  /**
   * Decode the library from a snapshot.
   *
   * @param snapshot - Untrusted snapshot.
   * @returns Library, empty when unavailable.
   */
  export function parseLibrary(snapshot: unknown): Library;

  /**
   * Execution layer per step id.
   *
   * @param steps - One section in order.
   * @returns One-based layers.
   */
  export function stepLayers(steps: readonly { id: string; after: readonly string[] }[]): Map<string, number>;

  /**
   * Steps grouped by layer.
   *
   * @param steps - One section in order.
   * @returns Layers in order.
   */
  export function layerGroups<T extends { id: string; after: readonly string[] }>(steps: readonly T[]): T[][];

  /**
   * Change a step's kind and clear unsupported settings.
   *
   * @param step - Current step.
   * @param kind - New kind.
   * @returns Normalized step.
   */
  export function withKind(step: DraftStep, kind: string): DraftStep;

  /**
   * Rename a step and its references.
   *
   * @param draft - Workflow being edited.
   * @param section - Where the step lives.
   * @param uid - Step identity.
   * @param id - New id.
   * @returns Updated draft.
   */
  export function renameStep(draft: DraftWorkflow, section: SectionName, uid: string, id: string): DraftWorkflow;

  /**
   * Insert a step with defaults.
   *
   * @param draft - Workflow being edited.
   * @param section - Where to add it.
   * @param kind - Kind to add.
   * @returns Updated draft and the new uid.
   */
  export function addStep(
    draft: DraftWorkflow,
    section: SectionName,
    kind: string,
  ): { draft: DraftWorkflow; uid: string };

  /**
   * Remove a step and reconnect its successors.
   *
   * @param draft - Workflow being edited.
   * @param section - Where the step lives.
   * @param uid - Step identity.
   * @returns Updated draft.
   */
  export function removeStep(draft: DraftWorkflow, section: SectionName, uid: string): DraftWorkflow;

  /**
   * Move a step by one place.
   *
   * @param draft - Workflow being edited.
   * @param section - Where the step lives.
   * @param uid - Step identity.
   * @param offset - Direction.
   * @returns Updated draft.
   */
  export function moveStep(draft: DraftWorkflow, section: SectionName, uid: string, offset: -1 | 1): DraftWorkflow;

  /**
   * Open a library entry as a draft.
   *
   * @param item - Library entry.
   * @param library - Whole library.
   * @returns Draft and origin.
   */
  export function draftFrom(item: LibraryItem, library: Library): { draft: DraftWorkflow; origin: DraftOrigin };

  /**
   * Unique copy id and name.
   *
   * @param workflow - Workflow being copied.
   * @param library - Whole library.
   * @returns Unused id and name.
   */
  export function copyNames(
    workflow: { readonly id: string; readonly name: string },
    library: Library,
  ): { id: string; name: string };

  /**
   * Minimal valid new workflow.
   *
   * @param library - Whole library.
   * @returns Draft and origin.
   */
  export function blankDraft(library: Library): { draft: DraftWorkflow; origin: DraftOrigin };

  /**
   * Wire form of a draft.
   *
   * @param draft - Workflow being edited.
   * @returns Plain definition.
   */
  export function wireWorkflow(draft: DraftWorkflow): Record<string, unknown>;

  /**
   * Save request body.
   *
   * @param draft - Workflow being edited.
   * @param origin - Where it came from.
   * @returns Request input.
   */
  export function saveRequest(
    draft: DraftWorkflow,
    origin: DraftOrigin,
  ): { workflow: Record<string, unknown>; expectedRevision: string | null };

  /**
   * Default request body.
   *
   * @param workflowId - Workflow to make the default.
   * @returns Request input.
   */
  export function defaultRequest(workflowId: string): { workflowId: string };

  /**
   * Whether two drafts define the same workflow.
   *
   * @param left - First draft.
   * @param right - Second draft.
   * @returns True when equal on the wire.
   */
  export function isSameDefinition(left: DraftWorkflow, right: DraftWorkflow): boolean;
}

declare module '*/web/dist/workflow-checks.js' {
  import type { DraftOrigin, DraftWorkflow, Library, SectionName } from '*/web/dist/workflow-model.js';

  /** One problem and where to show it. */
  export interface Problem {
    /** Section, or null for workflow fields. */
    readonly section: SectionName | null;
    /** Offending step, or null. */
    readonly uid: string | null;
    /** Plain explanation. */
    readonly message: string;
  }

  /**
   * Browser-side problems in a draft.
   *
   * @param draft - Workflow being edited.
   * @param library - Whole library.
   * @param origin - Where the draft came from.
   * @returns Problems with locations.
   */
  export function draftProblems(draft: DraftWorkflow, library: Library, origin: DraftOrigin): Problem[];

  /**
   * Split a joined server error.
   *
   * @param message - Server text.
   * @returns One item per problem.
   */
  export function splitProblems(message: string): string[];

  /**
   * Whether a server error is a stale-revision refusal.
   *
   * @param message - Server text.
   * @returns True when stale.
   */
  export function isStaleRevision(message: string): boolean;
}

declare module '*/web/dist/automations-model.js' {
  /** One recorded fire. */
  interface FireView {
    /** Fire id. */
    readonly id: string;
    /** Cause. */
    readonly kind: 'schedule' | 'trigger' | 'manual';
    /** Fire time. */
    readonly at: number;
    /** Objective filed, if any. */
    readonly featureId: string | null;
    /** Why nothing was filed. */
    readonly error: string | null;
  }

  /** Fields both kinds share. */
  interface AutomationBase {
    /** Automation id. */
    readonly id: string;
    /** Display name. */
    readonly name: string;
    /** Objective text. */
    readonly objective: string;
    /** Workflow, or null for the default. */
    readonly workflowId: string | null;
    /** Whether it may fire. */
    readonly isEnabled: boolean;
    /** Revision an edit names. */
    readonly revision: number;
    /** Last fire time. */
    readonly lastFiredAt: number | null;
    /** Recent fires. */
    readonly fires: readonly FireView[];
  }

  /** A cron schedule. */
  interface ScheduleView extends AutomationBase {
    /** Kind. */
    readonly kind: 'schedule';
    /** Expression. */
    readonly cron: string;
    /** Zone. */
    readonly timeZone: string;
    /** Next fire. */
    readonly nextAt: number | null;
    /** Upcoming fires. */
    readonly upcoming: readonly number[];
  }

  /** A webhook trigger. */
  interface TriggerView extends AutomationBase {
    /** Kind. */
    readonly kind: 'trigger';
    /** Broker path. */
    readonly path: string;
  }

  /** Broker address for examples. */
  interface TriggerEndpoint {
    /** Base URL. */
    readonly url: string;
    /** Team header, or null. */
    readonly team: string | null;
  }

  /** Editor fields. */
  interface AutomationDraft {
    /** Name. */
    readonly name: string;
    /** Objective. */
    readonly objective: string;
    /** Workflow key or empty. */
    readonly workflowId: string;
    /** Enabled. */
    readonly isEnabled: boolean;
    /** Cron expression. */
    readonly cron: string;
    /** Zone. */
    readonly timeZone: string;
  }

  /** Placeholder for a secret in examples. */
  export const SECRET_PLACEHOLDER: string;

  /**
   * Read automations from a snapshot.
   *
   * @param snapshot - Untrusted snapshot.
   * @returns Validated schedules, triggers and endpoint.
   */
  export function readAutomations(snapshot: unknown): {
    readonly schedules: readonly ScheduleView[];
    readonly triggers: readonly TriggerView[];
    readonly endpoint: TriggerEndpoint | null;
  };

  /**
   * Describe a cron expression.
   *
   * @param expression - Five fields or a shorthand such as `@daily`.
   * @returns Plain-language description, or why the expression is invalid.
   */
  export function describeCron(expression: string): { readonly text: string; readonly isValid: boolean };

  /**
   * Format a time in a zone.
   *
   * @param at - Epoch milliseconds.
   * @param timeZone - IANA zone the schedule is written in.
   * @returns Weekday, date and 24-hour clock in that zone.
   */
  export function zonedTime(at: number, timeZone: string): string;

  /**
   * Describe a fire.
   *
   * @param fire - Recorded fire.
   * @returns Its cause and whether an objective was filed.
   */
  export function fireText(fire: FireView): string;

  /**
   * The draft an editor starts from.
   *
   * @param automation - Automation being edited, or null for a new one.
   * @returns Editor fields with defaults for a new automation.
   */
  export function draftOf(automation: ScheduleView | TriggerView | null): AutomationDraft;

  /**
   * Check a draft.
   *
   * @param kind - Schedule or trigger.
   * @param draft - Editor fields.
   * @returns The first problem, or null when the draft may be sent.
   */
  export function draftProblem(kind: 'schedule' | 'trigger', draft: AutomationDraft): string | null;

  /**
   * Build a save control.
   *
   * @param kind - Schedule or trigger.
   * @param draft - Editor fields.
   * @param editing - Automation being edited, or null to create one.
   * @param shouldRotate - Issue a new trigger secret.
   * @returns Broker operation and its input.
   */
  export function saveInput(
    kind: 'schedule' | 'trigger',
    draft: AutomationDraft,
    editing: ScheduleView | TriggerView | null,
    shouldRotate?: boolean,
  ): { readonly operation: string; readonly input: Record<string, unknown> };

  /**
   * Build an enable/disable control.
   *
   * @param automation - Automation to switch on or off.
   * @returns Save operation with the enabled flag inverted.
   */
  export function toggleInput(automation: ScheduleView | TriggerView): {
    readonly operation: string;
    readonly input: Record<string, unknown>;
  };

  /**
   * Read an issued secret.
   *
   * @param result - Untrusted control result.
   * @returns Secret with the trigger's name and path, or null when none was issued.
   */
  export function issuedSecret(
    result: unknown,
  ): { readonly secret: string; readonly trigger: { readonly name: string; readonly path: string } } | null;

  /**
   * The full trigger URL.
   *
   * @param endpoint - Broker address, or null when unknown.
   * @param path - Trigger path, such as `/triggers/<id>`.
   * @returns Absolute URL, with a placeholder port when unknown.
   */
  export function triggerUrl(endpoint: TriggerEndpoint | null, path: string): string;

  /**
   * Example commands that fire a trigger.
   *
   * @param endpoint - Broker address, or null when unknown.
   * @param path - Trigger path, such as `/triggers/<id>`.
   * @param secret - Secret to show, or the placeholder.
   * @returns A curl command and a PowerShell command.
   */
  export function triggerExamples(
    endpoint: TriggerEndpoint | null,
    path: string,
    secret?: string,
  ): { readonly curl: string; readonly powershell: string };
}
