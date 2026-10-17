/**
 * Typed view of the compiled `board-model` browser module for DOM-free tests.
 * `npm run check` builds web/dist after typecheck, so the file does not exist yet when types are checked.
 *
 * @file
 */

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
