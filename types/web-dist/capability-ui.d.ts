/**
 * Typed view of the compiled `capability-ui` browser module for DOM-free tests.
 * `npm run check` builds web/dist after typecheck, so the file does not exist yet when types are checked.
 *
 * @file
 */

declare module '*/web/dist/capability-ui.js' {
  /**
   * Create the Capabilities view.
   *
   * @param hooks - Project selection and the operator control path.
   * @returns Stable root and its refresh.
   */
  export function createCapabilityView(hooks: {
    readonly project: () => string;
    readonly control: (operation: string, input: unknown) => Promise<boolean>;
  }): {
    readonly element: unknown;
    readonly refresh: () => Promise<void>;
  };
}
