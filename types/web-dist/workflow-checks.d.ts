/**
 * Typed view of the compiled `workflow-checks` browser module for DOM-free tests.
 * `npm run check` builds web/dist after typecheck, so the file does not exist yet when types are checked.
 *
 * @file
 */

declare module '*/web/dist/workflow-checks.js' {
  import type { DraftOrigin, DraftWorkflow, Library, SectionName } from '*/web/dist/workflow-model.js';

  /** One problem and where to show it. */
  export interface Problem {
    /** Section, or null for workflow fields. */
    readonly section: SectionName | null;
    /** Offending step, or null. */
    readonly uid: string | null;
    /** Plain explanation. */
    readonly message: string;
  }

  /**
   * Browser-side problems in a draft.
   *
   * @param draft - Workflow being edited.
   * @param library - Whole library.
   * @param origin - Where the draft came from.
   * @returns Problems with locations.
   */
  export function draftProblems(draft: DraftWorkflow, library: Library, origin: DraftOrigin): Problem[];

  /**
   * Split a joined server error.
   *
   * @param message - Server text.
   * @returns One item per problem.
   */
  export function splitProblems(message: string): string[];

  /**
   * Whether a server error is a stale-revision refusal.
   *
   * @param message - Server text.
   * @returns True when stale.
   */
  export function isStaleRevision(message: string): boolean;
}
