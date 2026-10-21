/**
 * Typed view of the compiled `console-dom` browser module for tests that render it on the test DOM.
 * `npm run check` builds web/dist after typecheck, so the file does not exist yet when types are checked.
 *
 * @file
 */

declare module '*/web/dist/console-dom.js' {
  /**
   * Link a delivery's pull request: a local hub pull request opens in the console, anything else externally.
   *
   * @param url - Recorded pull-request address.
   * @param label - Visible text.
   * @param openPull - Opens one local pull request, when the view can navigate.
   * @returns In-console button, external link, or plain text.
   */
  export function pullRequestLink(url: string, label: string, openPull?: (pull: number) => void): unknown;
}
