/**
 * Typed view of the compiled `capacity-view` browser module for DOM-free tests.
 * `npm run check` builds web/dist after typecheck, so the file does not exist yet when types are checked.
 *
 * @file
 */

declare module '*/web/dist/capacity-view.js' {
  /**
   * Build the Provider & local capacity panel for one snapshot.
   *
   * @param state - Console snapshot.
   * @returns The panel element (a test-DOM element under Node).
   */
  export function capacityView(state: Record<string, unknown>): unknown;
}
