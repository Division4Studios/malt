/**
 * Typed view of the compiled `api` browser module for DOM-free tests.
 * `npm run check` builds web/dist after typecheck, so the file does not exist yet when types are checked.
 *
 * @file
 */

declare module '*/web/dist/api.js' {
  /**
   * The tracker key a delivery record shows: `#12` on GitHub, `PROJ-12` in Jira.
   *
   * @param value - Delivery view or ledger task.
   * @param field - `issue` for the delivery itself, `parentIssue` for its parent.
   * @returns Display key.
   */
  export function issueLabel(value: Readonly<Record<string, unknown>>, field?: 'issue' | 'parentIssue'): string;
}
