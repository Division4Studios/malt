/**
 * Typed view of the compiled `navigation` browser module for DOM-free tests.
 * `npm run check` builds web/dist after typecheck, so the file does not exist yet when types are checked.
 *
 * @file
 */

declare module '*/web/dist/navigation.js' {
  /** Heading and description per view. */
  export const HEADINGS: Readonly<Record<string, readonly [string, string]>>;

  /**
   * Whether a value names a console view.
   *
   * @param value - Untrusted view name.
   * @returns True for a known view.
   */
  export function isView(value: string): boolean;

  /**
   * Where a view sits in the navigation, in the current language.
   *
   * @param view - Console view.
   * @returns `Group → Section`, or the group alone.
   */
  export function viewPath(view: string): string;
}
