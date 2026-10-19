/**
 * Typed view of the compiled `catalog-zh` browser module for DOM-free tests.
 * `npm run check` builds web/dist after typecheck, so the file does not exist yet when types are checked.
 *
 * @file
 */

declare module '*/web/dist/catalog-zh.js' {
  /** Catalog parts by area. */
  export const ZH_PARTS: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Every Simplified Chinese message, keyed by English source text. */
  export const ZH_CN: Readonly<Record<string, string>>;
}
