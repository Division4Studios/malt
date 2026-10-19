/**
 * Typed view of the compiled `automations-model` browser module for DOM-free tests.
 * `npm run check` builds web/dist after typecheck, so the file does not exist yet when types are checked.
 *
 * @file
 */

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
