/**
 * Typed view of the compiled `spend-model` browser module for DOM-free tests.
 * `npm run check` builds web/dist after typecheck, so the file does not exist yet when types are checked.
 *
 * @file
 */

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
