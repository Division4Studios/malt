/**
 * Typed view of the compiled `views` browser module for tests that render it on the test DOM.
 * `npm run check` builds web/dist after typecheck, so the file does not exist yet when types are checked.
 *
 * @file
 */

declare module '*/web/dist/views.js' {
  /**
   * Project setup cards for the selected project.
   *
   * @param state - Validated live snapshot.
   * @param actions - Operator controls the cards call.
   * @returns Setup cards.
   */
  export function setupView(state: Record<string, unknown>, actions: Record<string, unknown>): unknown;
}
