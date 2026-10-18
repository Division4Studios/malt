/**
 * DOM-free model of a delivery's source diff: it validates the broker's
 * changed-file summary and per-file patch record by record, labels each change,
 * and turns a patch into numbered rows with the shared unified diff parser.
 * The broker stays the authority on which paths and how many bytes are shown.
 *
 * @file
 */
import { asData } from './console-model.js';
import { parseDiff } from './diff-parse.js';
import { phrase, t, translated } from './i18n.js';

import type { Data } from './api.js';
import type { DiffRow } from './diff-parse.js';

/** Changed lines above which a file's patch starts collapsed. */
export const LARGE_FILE_LINES = 400;
/** Change kinds the broker reports. */
const STATUSES = ['added', 'deleted', 'modified', 'renamed', 'copied', 'type_changed'] as const;
/** Bytes in one KiB. */
const KIB = 1024;
/** Mode of a side that does not exist. */
const NO_MODE = '000000';
/** Visible label per change kind. */
const STATUS_LABELS: Readonly<Record<DiffStatus, string>> = translated({
  added: phrase('Added'),
  deleted: phrase('Deleted'),
  modified: phrase('Modified'),
  renamed: phrase('Renamed'),
  copied: phrase('Copied'),
  type_changed: phrase('Type changed'),
});

/** One change kind. */
export type DiffStatus = (typeof STATUSES)[number];

/** One changed file. */
export interface DiffFileView {
  /** Current path. */
  readonly path: string;
  /** Source path of a rename or copy. */
  readonly oldPath: string | null;
  /** Change kind. */
  readonly status: DiffStatus;
  /** Added lines, `null` for binary content. */
  readonly additions: number | null;
  /** Removed lines, `null` for binary content. */
  readonly deletions: number | null;
  /** Whether Git treats the content as binary. */
  readonly isBinary: boolean;
  /** Octal mode at the base. */
  readonly baseMode: string;
  /** Octal mode at the head. */
  readonly headMode: string;
  /** Rename or copy similarity percent. */
  readonly similarity: number | null;
}

/** A delivery's changed files, or why there are none to show. */
export type DiffSummaryView =
  | {
      readonly state: 'ready';
      readonly base: string;
      readonly head: string;
      readonly files: readonly DiffFileView[];
      readonly totals: { readonly files: number; readonly additions: number; readonly deletions: number };
      readonly privateChanges: number;
      readonly isTruncated: boolean;
    }
  | { readonly state: 'unavailable'; readonly reason: string };

/** One file's patch, as numbered rows. */
export type DiffPatchView =
  | {
      readonly state: 'ready';
      /** Source pair the server generated the patch from. */
      readonly base: string;
      readonly head: string;
      readonly path: string;
      readonly rows: readonly DiffRow[];
      readonly notes: readonly string[];
      readonly isTruncated: boolean;
      readonly bytes: number | null;
    }
  | { readonly state: 'unavailable'; readonly reason: string };

/**
 * Read a string field.
 *
 * @param source - Untrusted record.
 * @param key - Field name.
 * @returns The string, or empty.
 */
function textOf(source: Data, key: string): string {
  const value = source[key];
  return typeof value === 'string' ? value : '';
}

/**
 * Read a non-negative integer field.
 *
 * @param source - Untrusted record.
 * @param key - Field name.
 * @returns The count, or `null` when absent or invalid.
 */
function countOf(source: Data, key: string): number | null {
  const value = source[key];
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * Read an octal mode field.
 *
 * @param source - Untrusted record.
 * @param key - Field name.
 * @returns The mode, or the absent-side mode.
 */
function modeOf(source: Data, key: string): string {
  const mode = textOf(source, key);
  return mode === '' ? NO_MODE : mode;
}

/**
 * Whether a value is a known change kind.
 *
 * @param value - Candidate.
 * @returns True for a broker change kind.
 */
function isStatus(value: string): value is DiffStatus {
  return (STATUSES as readonly string[]).includes(value);
}

/**
 * The reason an unavailable result gives.
 *
 * @param source - Untrusted result.
 * @returns Unavailable view.
 */
function unavailable(source: Data | null): { readonly state: 'unavailable'; readonly reason: string } {
  const reason = source === null ? '' : textOf(source, 'reason');
  return { state: 'unavailable', reason: reason === '' ? t('The diff could not be read.') : reason };
}

/**
 * Validate one changed file.
 *
 * @param source - Untrusted file record.
 * @returns The file, or `null` when malformed.
 */
function parseFile(source: Data): DiffFileView | null {
  const path = textOf(source, 'path');
  const status = textOf(source, 'status');
  if (path === '' || !isStatus(status)) {
    return null;
  }
  const oldPath = textOf(source, 'oldPath');
  const similarity = countOf(source, 'similarity');
  return {
    path,
    oldPath: oldPath === '' ? null : oldPath,
    status,
    additions: countOf(source, 'additions'),
    deletions: countOf(source, 'deletions'),
    isBinary: source['isBinary'] === true,
    baseMode: modeOf(source, 'baseMode'),
    headMode: modeOf(source, 'headMode'),
    similarity,
  };
}

/**
 * Validate a delivery diff summary.
 *
 * @param value - Untrusted `/api/delivery-diff` result.
 * @returns Ready summary, or why none is available.
 */
export function readDiffSummary(value: unknown): DiffSummaryView {
  const source = asData(value);
  if (source?.['state'] !== 'ready') {
    return unavailable(source);
  }
  const files = (Array.isArray(source['files']) ? source['files'] : [])
    .map((item) => asData(item))
    .filter((item) => item !== null)
    .map((item) => parseFile(item))
    .filter((item) => item !== null);
  const totals = asData(source['totals']) ?? {};
  return {
    state: 'ready',
    base: textOf(source, 'base'),
    head: textOf(source, 'head'),
    files,
    totals: {
      files: countOf(totals, 'files') ?? files.length,
      additions: countOf(totals, 'additions') ?? 0,
      deletions: countOf(totals, 'deletions') ?? 0,
    },
    privateChanges: countOf(source, 'privateChanges') ?? 0,
    isTruncated: source['isTruncated'] === true,
  };
}

/**
 * Validate one file's patch and parse it into rows.
 *
 * @param value - Untrusted `/api/delivery-diff?path=` result.
 * @returns Rows and header notes, or why none is available.
 */
export function readDiffPatch(value: unknown): DiffPatchView {
  const source = asData(value);
  if (source?.['state'] !== 'ready') {
    return unavailable(source);
  }
  // A file-type change (symlink to file) is two sections for one path: keep both.
  const sections = parseDiff(textOf(source, 'patch'));
  return {
    state: 'ready',
    base: textOf(source, 'base'),
    head: textOf(source, 'head'),
    path: textOf(source, 'path'),
    rows: sections.flatMap((section) => section.rows),
    notes: sections.flatMap((section) => section.notes),
    isTruncated: source['isTruncated'] === true,
    bytes: countOf(source, 'bytes'),
  };
}

/**
 * The route that reads a delivery's summary, or one file's patch.
 *
 * @param project - Selected project id.
 * @param taskId - Delivery id.
 * @param path - Listed path, for its patch.
 * @returns Same-origin API path.
 */
export function diffRoute(project: string, taskId: string, path?: string): string {
  const query = new URLSearchParams({ project, taskId });
  if (path !== undefined) {
    query.set('path', path);
  }
  return `/api/delivery-diff?${query.toString()}`;
}

/**
 * A change's kind, with its source path and similarity for renames and copies.
 *
 * @param file - Changed file.
 * @returns Plain label.
 */
export function statusText(file: DiffFileView): string {
  const label = STATUS_LABELS[file.status];
  if (file.oldPath === null) {
    return label;
  }
  const similarity = file.similarity === null ? '' : t(' ({similarity}% similar)', { similarity: file.similarity });
  return `${label} from ${file.oldPath}${similarity}`;
}

/**
 * A file's line counts, or that it is binary.
 *
 * @param file - Changed file.
 * @returns `+12 −3`, or `Binary`.
 */
export function countText(file: DiffFileView): string {
  return file.isBinary ? t('Binary') : `+${String(file.additions ?? 0)} −${String(file.deletions ?? 0)}`;
}

/**
 * Notes a file's line counts cannot show: mode changes and binary content.
 *
 * @param file - Changed file.
 * @returns Plain notes.
 */
export function fileNotes(file: DiffFileView): string[] {
  const notes: string[] = [];
  if (file.baseMode !== file.headMode && file.baseMode !== NO_MODE && file.headMode !== NO_MODE) {
    notes.push(t('Mode {baseMode} → {headMode}', { baseMode: file.baseMode, headMode: file.headMode }));
  }
  if (file.isBinary) {
    notes.push(t('Binary content; no line diff.'));
  }
  return notes;
}

/**
 * The whole change in one line.
 *
 * @param summary - Ready summary.
 * @returns For example `3 files changed · +12 −3`.
 */
export function totalsText(summary: Extract<DiffSummaryView, { state: 'ready' }>): string {
  const { files, additions, deletions } = summary.totals;
  return t('{files, plural, one {# file} other {# files}} changed · +{additions} −{deletions}', {
    files,
    additions,
    deletions,
  });
}

/**
 * Notes about what the summary leaves out.
 *
 * @param summary - Ready summary.
 * @returns Plain notes for truncation and hidden private paths.
 */
export function summaryNotes(summary: Extract<DiffSummaryView, { state: 'ready' }>): string[] {
  const notes: string[] = [];
  if (summary.isTruncated) {
    notes.push(
      t('Showing the first {length} of {files} changed files.', {
        length: summary.files.length,
        files: summary.totals.files,
      }),
    );
  }
  if (summary.privateChanges > 0) {
    notes.push(
      t(
        '{privateChanges, plural, one {# private runtime or credential path} other {# private runtime or credential paths}} changed and are not shown.',
        { privateChanges: summary.privateChanges },
      ),
    );
  }
  return notes;
}

/**
 * Whether a file's patch should start collapsed.
 *
 * @param file - Changed file.
 * @returns True when it changes many lines.
 */
export function isLargeFile(file: DiffFileView): boolean {
  return (file.additions ?? 0) + (file.deletions ?? 0) > LARGE_FILE_LINES;
}

/**
 * Why a patch stops short.
 *
 * @param patch - Ready patch.
 * @returns Plain note, or `null` when the patch is complete.
 */
export function truncationText(patch: Extract<DiffPatchView, { state: 'ready' }>): string | null {
  if (!patch.isTruncated) {
    return null;
  }
  return patch.bytes === null
    ? t('This file changes too much to show here. Open it in your editor or on GitHub.')
    : t('Showing the first part of a {kib} KiB patch.', { kib: Math.ceil(patch.bytes / KIB) });
}
