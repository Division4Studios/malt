/**
 * Typed view of the compiled `step-override-model` browser module for DOM-free tests.
 * `npm run check` builds web/dist after typecheck, so the file does not exist yet when types are checked.
 *
 * @file
 */

declare module '*/web/dist/step-override-model.js' {
  /** One step override. */
  interface StepOverride {
    /** Step id. */
    readonly stepId: string;
    /** Skip an optional step. */
    readonly skip?: boolean;
    /** Seats instead of the workflow's. */
    readonly roles?: readonly string[];
    /** Profile instead of the step's. */
    readonly profile?: string | null;
    /** Provider instead of the step's. */
    readonly provider?: string | null;
  }
  /** One step the editor lists. */
  interface CustomStep {
    /** Step id. */
    readonly id: string;
    /** Title. */
    readonly title: string;
    /** Kind. */
    readonly kind: string;
    /** Whether it may be skipped. */
    readonly optional: boolean;
    /** Workflow seats. */
    readonly roles: readonly string[];
    /** Workflow profile. */
    readonly profile: string | null;
    /** Workflow provider. */
    readonly provider: string | null;
    /** Whether it started. */
    readonly started: boolean;
  }
  /** A delivery's editor state. */
  interface Customization {
    /** Version an edit presents. */
    readonly version: number;
    /** Frozen steps. */
    readonly steps: readonly CustomStep[];
    /** Overrides in effect. */
    readonly overrides: readonly StepOverride[];
  }
  /** One step's editor choice. */
  interface StepChoice {
    /** Step id. */
    readonly stepId: string;
    /** Whether it runs. */
    readonly include: boolean;
    /** Seat, or empty for the workflow's. */
    readonly role: string;
    /** Profile, empty for the workflow's, `-` for the seat type. */
    readonly profile: string;
    /** Provider, empty for the workflow's, `any` for normal routing. */
    readonly provider: string;
  }
  /** Profile choice meaning the seat's own type. */
  export const SEAT_PROFILE: string;
  /** Provider choice meaning normal routing. */
  export const ANY_PROVIDER: string;

  /**
   * Validate stored overrides.
   *
   * @param value - Untrusted list.
   * @returns Overrides with only known fields.
   */
  export function parseOverrides(value: unknown): StepOverride[];

  /**
   * Validate a delivery's editor state.
   *
   * @param value - Untrusted customization.
   * @returns Editor state or null.
   */
  export function parseCustomization(value: unknown): Customization | null;

  /**
   * Steps of a library workflow.
   *
   * @param factory - Factory snapshot.
   * @param workflowId - Library workflow chosen in the picker.
   * @returns Its planning and delivery steps.
   */
  export function libraryWorkflowSteps(factory: Record<string, unknown>, workflowId: string): CustomStep[];

  /**
   * Profile names the project defines.
   *
   * @param factory - Factory snapshot.
   * @returns Profile names, sorted.
   */
  export function profileNames(factory: Record<string, unknown>): string[];

  /**
   * Seats the organization defines.
   *
   * @param factory - Factory snapshot.
   * @returns Seats.
   */
  export function seatNames(factory: Record<string, unknown>): string[];

  /**
   * Starting choice for one step.
   *
   * @param step - Frozen step.
   * @param overrides - Overrides in effect.
   * @returns The choice the editor shows.
   */
  export function initialChoice(step: CustomStep, overrides: readonly StepOverride[]): StepChoice;

  /**
   * Smallest override list for choices.
   *
   * @param steps - Frozen steps.
   * @param choices - Choices by step id.
   * @param current - Overrides in effect.
   * @returns Smallest override list to save.
   */
  export function overridesFrom(
    steps: readonly CustomStep[],
    choices: ReadonlyMap<string, StepChoice>,
    current?: readonly StepOverride[],
  ): StepOverride[];

  /**
   * Plain summary of overrides.
   *
   * @param steps - Frozen steps.
   * @param overrides - Overrides to describe.
   * @returns Sentence.
   */
  export function overrideSummary(steps: readonly CustomStep[], overrides: readonly StepOverride[]): string;
}
