/**
 * Typed view of the compiled `goal-model` browser module for DOM-free tests.
 * `npm run check` builds web/dist after typecheck, so the file does not exist yet when types are checked.
 *
 * @file
 */

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

  /** Document event asking the console to open one objective. */
  export const OPEN_OBJECTIVE_EVENT: string;

  /**
   * Unfinished objectives that have a definition of done or wait on one.
   *
   * @param snapshot - Console snapshot.
   * @returns Progress rows; objectives waiting on their definition come first.
   */
  export function goalProgress(snapshot: unknown): {
    readonly featureId: string;
    readonly title: string;
    readonly progress: string;
    readonly awaitsDefinition: boolean;
  }[];
}
