/**
 * Typed view of the compiled `onboarding-model` browser module for DOM-free tests.
 * `npm run check` builds web/dist after typecheck, so the file does not exist yet when types are checked.
 *
 * @file
 */

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
