/**
 * Typed view of compiled browser modules imported by DOM-free tests.
 * `npm run check` builds web/dist after typecheck, so the files do not exist yet when types are checked.
 *
 * @file
 */

declare module '*/web/dist/brand-ui.js' {
  /**
   * Select pending objectives (bounded) followed by the most recent completed ones.
   *
   * @param objectives - Product objectives in original order.
   * @param completedLimit - Completed objectives to keep.
   * @returns Selected objectives.
   */
  export function objectivePreview(
    objectives: Record<string, unknown>[],
    completedLimit: number,
  ): Record<string, unknown>[];
}
