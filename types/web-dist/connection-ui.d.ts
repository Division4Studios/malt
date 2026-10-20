/**
 * Typed view of the compiled `connection-ui` browser module for DOM-free tests.
 * `npm run check` builds web/dist after typecheck, so the file does not exist yet when types are checked.
 *
 * @file
 */

declare module '*/web/dist/connection-ui.js' {
  /**
   * Create the Connections view.
   *
   * @param hooks - Project selection, the operator control path and routing.
   * @returns Stable root and its snapshot update.
   */
  export function createConnectionView(hooks: {
    readonly project: () => string;
    readonly control: (operation: string, input: unknown, onResult?: (result: unknown) => void) => Promise<boolean>;
    readonly select: (view: string) => void;
  }): {
    readonly element: unknown;
    readonly update: (snapshot: unknown) => void;
  };
}
