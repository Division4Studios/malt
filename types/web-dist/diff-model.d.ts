/**
 * Typed view of the compiled `diff-model` browser module for DOM-free tests.
 * `npm run check` builds web/dist after typecheck, so the file does not exist yet when types are checked.
 *
 * @file
 */

declare module '*/web/dist/diff-model.js' {
  /** One rendered diff row. */
  interface DiffRow {
    /** Row kind. */
    readonly kind: 'add' | 'del' | 'ctx' | 'hunk';
    /** Old line number. */
    readonly old: string;
    /** New line number. */
    readonly new: string;
    /** Line text. */
    readonly text: string;
  }

  /** Change kind. */
  type DiffStatus = 'added' | 'deleted' | 'modified' | 'renamed' | 'copied' | 'type_changed';

  /** One changed file. */
  interface DiffFileView {
    /** Current path. */
    readonly path: string;
    /** Source path of a rename or copy. */
    readonly oldPath: string | null;
    /** Change kind. */
    readonly status: DiffStatus;
    /** Added lines. */
    readonly additions: number | null;
    /** Removed lines. */
    readonly deletions: number | null;
    /** Binary content. */
    readonly isBinary: boolean;
    /** Octal mode at the base. */
    readonly baseMode: string;
    /** Octal mode at the head. */
    readonly headMode: string;
    /** Similarity percent. */
    readonly similarity: number | null;
  }

  /** The changed files of a delivery head. */
  interface ReadySummary {
    /** Ready to show. */
    readonly state: 'ready';
    /** Base commit. */
    readonly base: string;
    /** Head commit. */
    readonly head: string;
    /** Listed files. */
    readonly files: readonly DiffFileView[];
    /** Totals. */
    readonly totals: { readonly files: number; readonly additions: number; readonly deletions: number };
    /** Hidden private changes. */
    readonly privateChanges: number;
    /** More files than listed. */
    readonly isTruncated: boolean;
  }

  /** Nothing to show. */
  interface Unavailable {
    /** Nothing to show. */
    readonly state: 'unavailable';
    /** Why. */
    readonly reason: string;
  }

  /** One file's parsed patch. */
  interface ReadyPatch {
    /** Ready to show. */
    readonly state: 'ready';
    /** File. */
    readonly path: string;
    /** Rows. */
    readonly rows: readonly DiffRow[];
    /** Header notes. */
    readonly notes: readonly string[];
    /** Cut short. */
    readonly isTruncated: boolean;
    /** Full patch bytes. */
    readonly bytes: number | null;
  }

  /** Changed lines above which a file starts collapsed. */
  export const LARGE_FILE_LINES: number;
  export function readDiffSummary(value: unknown): ReadySummary | Unavailable;
  export function readDiffPatch(value: unknown): ReadyPatch | Unavailable;
  export function diffRoute(project: string, taskId: string, path?: string): string;
  export function statusText(file: DiffFileView): string;
  export function countText(file: DiffFileView): string;
  export function fileNotes(file: DiffFileView): string[];
  export function totalsText(summary: ReadySummary): string;
  export function summaryNotes(summary: ReadySummary): string[];
  export function isLargeFile(file: DiffFileView): boolean;
  export function truncationText(patch: ReadyPatch): string | null;
}
