/**
 * Typed view of the compiled `recommendations-ui` browser module for DOM-free tests.
 * `npm run check` builds web/dist after typecheck, so the file does not exist yet when types are checked.
 *
 * @file
 */

declare module '*/web/dist/recommendations-ui.js' {
  /**
   * Create the Recommendations pane.
   *
   * @param hooks - Routes the pane uses: the page, read receipts, one detail, one decision and an optional retry.
   * @returns The pane's stable root, its refresh and its project reset.
   */
  export function createRecommendationsView(hooks: {
    readonly list: (after: string | null) => Promise<unknown>;
    readonly markRead: (id: string, revision: string) => Promise<unknown>;
    readonly detail: (id: string) => Promise<unknown>;
    readonly decide: (input: Record<string, unknown>) => Promise<unknown>;
    readonly retry?: (input: { id: string; revision: string }) => Promise<unknown>;
    readonly identity?: () => string;
  }): {
    readonly element: unknown;
    readonly refresh: () => Promise<void>;
    readonly reset: () => void;
    readonly relabel: () => void;
  };
}
