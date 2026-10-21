/**
 * Typed view of the compiled delivery manager view and its controller for tests
 * that render into the text-only test DOM.
 * `npm run check` builds web/dist after typecheck, so the file does not exist yet when types are checked.
 *
 * @file
 */

declare module '*/web/dist/manager-controller.js' {
  /** Collaborators owned by the main app. */
  export interface ManagerDependencies {
    /** Current public project identifier. */
    readonly project: () => string;
    /** Single-flight operator control. */
    readonly control: (operation: string, input: unknown) => Promise<boolean>;
    /** Accessible notice. */
    readonly notice: (message: string, isSuccess?: boolean) => void;
    /** Re-render the current view. */
    readonly render: () => void;
  }

  /** Manager view controller. */
  export class ManagerController {
    /**
     * Build the persistent composer.
     *
     * @param dependencies - App collaborators.
     */
    public constructor(dependencies: ManagerDependencies);

    /**
     * Continue or let wait an attempt that stopped at a checkpoint.
     *
     * @param jobId - Stopped attempt.
     * @param head - Delivery head the decision is fenced to.
     * @param decision - Continue for some minutes, or wait.
     */
    public decideCheckpoint(
      jobId: string,
      head: string | null,
      decision: { readonly action: 'continue' | 'wait'; readonly minutes?: number },
    ): void;
  }
}

declare module '*/web/dist/manager-ui.js' {
  import type { ManagerController } from '*/web/dist/manager-controller.js';

  /**
   * Render the manager view.
   *
   * @param summary - Manager status and brief, null before configuration.
   * @param controller - Owns the transcript, composer and controls.
   * @returns Complete manager workspace.
   */
  export function managerView(
    summary: Readonly<Record<string, unknown>> | null,
    controller: ManagerController,
  ): unknown;
}
