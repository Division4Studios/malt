/**
 * Typed view of the compiled `price-editor` browser module for DOM-free tests.
 * `npm run check` builds web/dist after typecheck, so the file does not exist yet when types are checked.
 *
 * @file
 */

declare module '*/web/dist/price-editor.js' {
  /**
   * Validate edited price rows.
   *
   * @param rows - Raw model and price strings per row.
   * @returns Valid rows, or an error explaining the first problem.
   */
  export function validatePrices(rows: readonly Readonly<Record<string, string>>[]):
    | {
        prices: { model: string; input: number; cachedInput: number; cacheWrite: number; output: number }[];
      }
    | { error: string };
}
