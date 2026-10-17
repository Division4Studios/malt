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
   * The merge-gate toggle a delivery offers before it is merge ready.
   *
   * @param delivery - Delivery shown.
   * @returns Label and request input, or null once the gate can no longer change.
   */
  export function mergeGateControl(delivery: {
    readonly taskId: string;
    readonly phase: string;
    readonly steps: readonly { readonly id: string }[];
  }): { readonly label: string; readonly input: { readonly taskId: string; readonly merge: boolean } } | null;

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

declare module '*/web/dist/inbox-model.js' {
  /** Inbox item fields the Inbox rules read. */
  interface InboxItem {
    /** Item id. */
    readonly id: string;
    /** Decision kind. */
    readonly kind: string;
    /** Lane. */
    readonly lane: 'reply' | 'notice';
    /** Headline. */
    readonly title: string;
    /** Context. */
    readonly detail: string;
    /** Agent question. */
    readonly questionId: string | null;
    /** Offered answers. */
    readonly choices: readonly string[];
    /** Whether a written answer is accepted. */
    readonly allowText: boolean;
  }
  /** Longest written answer. */
  export const ANSWER_MAX: number;

  /**
   * Validate an answer before sending it.
   *
   * @param item - Open question.
   * @param requestId - Idempotency key.
   * @param choice - Selected option.
   * @param text - Written answer.
   * @returns Control input, or a message.
   */
  export function answerInput(
    item: InboxItem,
    requestId: string,
    choice: string | null,
    text: string,
  ):
    | {
        readonly ok: true;
        readonly input: { questionId: string; requestId: string; choice: string | null; text: string };
      }
    | { readonly ok: false; readonly error: string };

  /**
   * New reply items since the previous snapshot.
   *
   * @param previous - Ids open at the previous snapshot.
   * @param open - Items open now.
   * @returns New items and the ids to remember.
   */
  export function freshItems(
    previous: ReadonlySet<string> | null,
    open: readonly InboxItem[],
  ): { readonly fresh: readonly InboxItem[]; readonly seen: ReadonlySet<string> };

  /**
   * Notification text for one item.
   *
   * @param item - New open item.
   * @returns Title, body and tag.
   */
  export function notificationContent(item: InboxItem): { title: string; body: string; tag: string };
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

declare module '*/web/dist/goal-model.js' {
  /** Checklist state. */
  type DoneState = 'open' | 'proposed' | 'checked' | 'waived';

  /** One checklist item. */
  export interface DoneItem {
    /** Item id. */
    readonly id: string;
    /** What must be true. */
    readonly text: string;
    /** Where it stands. */
    readonly state: DoneState;
    /** `operator` or the role that set the state. */
    readonly by: string | null;
    /** When the state was set. */
    readonly at: number | null;
    /** Supporting evidence. */
    readonly evidence: string | null;
  }

  /** One objective with its definition of done. */
  export interface Goal {
    /** Objective id. */
    readonly featureId: string;
    /** First line. */
    readonly title: string;
    /** Full objective text. */
    readonly objective: string;
    /** Ledger phase. */
    readonly phase: string;
    /** Version the checklist save must present. */
    readonly updatedAt: number;
    /** Delivery progress. */
    readonly deliveries: { readonly total: number; readonly done: number };
    /** Checklist. */
    readonly items: readonly DoneItem[];
    /** Checked or waived items. */
    readonly met: number;
    /** Proposals awaiting the operator. */
    readonly proposed: number;
    /** Whether every delivery is done but the checklist is not met. */
    readonly awaitsDefinition: boolean;
  }

  /** One editor row as typed. */
  export interface ChecklistRow {
    /** Existing item id, or empty for a new item. */
    readonly id: string;
    /** Item text. */
    readonly text: string;
    /** Chosen state. */
    readonly state: string;
    /** Evidence text. */
    readonly evidence: string;
  }

  /**
   * Read every objective with its definition of done from a snapshot.
   *
   * @param snapshot - Console snapshot.
   * @returns Objectives, oldest first.
   */
  export function readGoals(snapshot: unknown): Goal[];

  /**
   * Summarize checklist progress.
   *
   * @param goal - Objective with its items and counts.
   * @returns Plain progress text.
   */
  export function definitionText(goal: Pick<Goal, 'items' | 'met' | 'proposed'>): string;

  /**
   * Validate editor rows into a `factory_objective_done` request.
   *
   * @param goal - Objective being edited.
   * @param rows - Rows as typed.
   * @returns Request input, or the first problem.
   */
  export function checklistInput(
    goal: Goal,
    rows: readonly ChecklistRow[],
  ): { input: Record<string, unknown> } | { error: string };

  /**
   * Validate one progress log page.
   *
   * @param value - Untrusted route result.
   * @returns Page with valid entries.
   */
  export function readLogPage(value: unknown): {
    readonly entries: readonly { seq: number; at: number; kind: string; actor: string; body: string }[];
    readonly total: number;
    readonly next: number | null;
  };
}

declare module '*/web/dist/spend-model.js' {
  /** Saved caps. */
  export interface SpendCaps {
    /** Project cap over the window. */
    readonly project: number | null;
    /** Project window in days. */
    readonly windowDays: number;
    /** Default objective cap. */
    readonly objectiveDefault: number | null;
    /** Default delivery cap. */
    readonly deliveryDefault: number | null;
    /** Objective overrides. */
    readonly objectives: Readonly<Record<string, number | null>>;
    /** Delivery overrides. */
    readonly deliveries: Readonly<Record<string, number | null>>;
    /** Unpriced attempt policy. */
    readonly unpriced: 'ignore' | 'block';
  }

  /** Spend against one capped scope. */
  export interface SpendUsage {
    /** Scope kind. */
    readonly scope: 'project' | 'objective' | 'delivery';
    /** Objective or delivery id. */
    readonly id: string;
    /** Visible name. */
    readonly label: string;
    /** Known spend. */
    readonly usd: number;
    /** Attempts without a known cost. */
    readonly unpricedAttempts: number;
    /** Cap, or `null`. */
    readonly cap: number | null;
    /** Why new attempts are stopped. */
    readonly blocked: 'cap' | 'unpriced' | null;
  }

  /** Caps, revision and spend. */
  export interface SpendStatus {
    /** Caps revision. */
    readonly revision: number;
    /** Saved caps. */
    readonly caps: SpendCaps;
    /** Spend rows, project first. */
    readonly usage: readonly SpendUsage[];
  }

  /** The editor's fields as typed. */
  export interface CapsForm {
    /** Project cap. */
    readonly project: string;
    /** Project window in days. */
    readonly windowDays: string;
    /** Default objective cap. */
    readonly objectiveDefault: string;
    /** Default delivery cap. */
    readonly deliveryDefault: string;
    /** Unpriced policy. */
    readonly unpriced: string;
    /** Per-scope overrides. */
    readonly overrides: readonly { readonly scope: string; readonly id: string; readonly value: string }[];
  }

  /** Override text that lifts the default cap for one scope. */
  export const NO_CAP: string;

  /**
   * Read caps and spend from a cost summary.
   *
   * @param summary - Cost summary.
   * @returns Spend status.
   */
  export function readSpend(summary: Record<string, unknown>): SpendStatus;

  /**
   * Describe one scope's spend against its cap.
   *
   * @param row - Spend, cap and block state of one scope.
   * @returns Progress share, text and state.
   */
  export function capProgress(row: SpendUsage): {
    readonly percent: number | null;
    readonly text: string;
    readonly state: 'uncapped' | 'ok' | 'near' | 'reached' | 'unpriced';
  };

  /**
   * Validate the typed caps into a `factory_spend_caps` request.
   *
   * @param status - Loaded caps.
   * @param form - Typed fields.
   * @returns Request input, or the first problem.
   */
  export function capsInput(
    status: SpendStatus,
    form: CapsForm,
  ): { input: Record<string, unknown> } | { error: string };

  /**
   * The typed override shown for one scope.
   *
   * @param caps - Saved caps.
   * @param row - Spend, cap and block state of one scope.
   * @returns Empty for the default, `none` when lifted, or the amount.
   */
  export function overrideText(caps: SpendCaps, row: SpendUsage): string;
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

declare module '*/web/dist/settings-model.js' {
  /** One provider's health. */
  interface ProviderHealth {
    /** Provider family. */
    readonly provider: 'claude' | 'codex';
    /** Display name. */
    readonly name: string;
    /** Whether the saved policy enables it; null before setup. */
    readonly isEnabled: boolean | null;
    /** Configured executable. */
    readonly executable: string;
    /** Presence, version and login. */
    readonly cli: {
      readonly status: 'fail' | 'fix-it' | 'pass' | 'unchecked';
      readonly detail: string;
      readonly fix: string | null;
    };
    /** Subscription window lines. */
    readonly quota: readonly string[];
    /** Cooldown end, when one is in force. */
    readonly cooldownUntil: number | null;
    /** Admission gate dispatch reports for it, if any. */
    readonly gate: string | null;
    /** Latest failed attempt, if any. */
    readonly lastFailure: { readonly at: number; readonly summary: string } | null;
  }

  /**
   * Health of every provider.
   *
   * @param factory - Factory projection.
   * @param preflight - Broker-side checks, or null before they ran.
   * @param now - Current time.
   * @returns One row per provider family.
   */
  export function providerHealth(
    factory: Record<string, unknown>,
    preflight: { readonly ok: boolean; readonly checks: readonly unknown[] } | null,
    now: number,
  ): ProviderHealth[];

  /**
   * Build and version rows.
   *
   * @param versions - Version route result, or null before it loaded.
   * @param cacheKeys - Cache Storage keys visible to the page.
   * @returns Label and value pairs.
   */
  export function buildRows(versions: unknown, cacheKeys: readonly string[]): [string, string][];
}
