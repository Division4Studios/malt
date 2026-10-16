/**
 * Unified diff review for local pull requests. Every value is untrusted plain
 * text; nothing is parsed as HTML.
 *
 * @file
 */
import { element } from './worker-ui.js';

/** Leading fields of a hunk header: marker, old range, new range. */
const HUNK_FIELDS = 3;
/** Diff lines rendered per file before collapsing the rest behind a toggle. */
const FILE_LINE_LIMIT = 400;

/** One parsed file section of a unified diff. */
interface DiffFile {
  /** Display path. */
  readonly path: string;
  /** Added line count. */
  added: number;
  /** Removed line count. */
  removed: number;
  /** Rendered rows. */
  readonly rows: DiffRow[];
}
/** One rendered diff row. */
interface DiffRow {
  /** Row kind for styling. */
  readonly kind: 'add' | 'del' | 'ctx' | 'hunk';
  /** Old line number, empty for additions and hunks. */
  readonly old: string;
  /** New line number, empty for deletions and hunks. */
  readonly new: string;
  /** Line text without the diff marker. */
  readonly text: string;
}

/**
 * Create a native button.
 *
 * @param title - Accessible label.
 * @param action - Controller callback.
 * @param cssClass - Trusted style.
 * @returns Button element.
 */
function button(title: string, action: () => void, cssClass = 'small-button'): HTMLButtonElement {
  const node = element('button', cssClass, title);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}

/**
 * Parse a hunk header's starting line numbers.
 *
 * @param header - `@@ -a,b +c,d @@` line.
 * @returns Old and new starting lines.
 */
function hunkStart(header: string): { old: number; new: number } {
  const [, removed = '-0', added = '+0'] = header.split(' ', HUNK_FIELDS);
  return { old: rangeStart(removed), new: rangeStart(added) };
}

/**
 * Read the first line number of a hunk range such as `-12,5`.
 *
 * @param range - Signed range from a hunk header.
 * @returns Starting line, zero when unreadable.
 */
function rangeStart(range: string): number {
  const value = Number(range.slice(1).split(',', 1)[0]);
  return Number.isSafeInteger(value) ? value : 0;
}

/**
 * Split a unified Git diff into files and numbered rows.
 *
 * @param diff - Unified diff text.
 * @returns Parsed files.
 */
export function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  let line = { old: 0, new: 0 };
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      const [name = raw] = raw.slice('diff --git a/'.length).split(' b/', 1);
      current = { path: name, added: 0, removed: 0, rows: [] };
      files.push(current);
    } else if (current !== null && raw.startsWith('@@')) {
      line = hunkStart(raw);
      current.rows.push({ kind: 'hunk', old: '', new: '', text: raw });
    } else if (current !== null && current.rows.length > 0) {
      appendRow(current, raw, line);
    }
  }
  return files;
}

/**
 * Append one content row and advance line counters.
 *
 * @param file - File section receiving the row.
 * @param raw - Diff line.
 * @param line - Mutable line counters.
 */
function appendRow(file: DiffFile, raw: string, line: { old: number; new: number }): void {
  const counters = line;
  const target = file;
  if (raw.startsWith('+')) {
    target.added += 1;
    target.rows.push({ kind: 'add', old: '', new: String(counters.new), text: raw.slice(1) });
    counters.new += 1;
  } else if (raw.startsWith('-')) {
    target.removed += 1;
    target.rows.push({ kind: 'del', old: String(counters.old), new: '', text: raw.slice(1) });
    counters.old += 1;
  } else if (raw.startsWith(' ')) {
    target.rows.push({ kind: 'ctx', old: String(counters.old), new: String(counters.new), text: raw.slice(1) });
    counters.old += 1;
    counters.new += 1;
  }
}

/**
 * Render one diff row.
 *
 * @param row - Parsed row.
 * @returns Table row.
 */
function diffRow(row: DiffRow): HTMLTableRowElement {
  const node = element('tr', `diff-${row.kind}`);
  const marker = { add: '+', del: '−', ctx: '', hunk: '' }[row.kind];
  node.append(
    element('td', 'diff-number', row.old),
    element('td', 'diff-number', row.new),
    element('td', 'diff-marker', marker),
    element('td', 'diff-text', row.text),
  );
  return node;
}

/**
 * Render a parsed diff with per-file headers and bounded expansion.
 *
 * @param diff - Unified diff text.
 * @param isTruncated - Whether the server bounded the diff.
 * @returns Diff element.
 */
export function diffView(diff: string, isTruncated: boolean): HTMLElement {
  const container = element('div', 'diff');
  const files = parseDiff(diff);
  if (files.length === 0) {
    container.append(element('p', 'subtle', 'No changes to display.'));
    return container;
  }
  for (const file of files) {
    const details = element('details', 'diff-file');
    details.open = true;
    const summary = element('summary', 'diff-file-head');
    summary.append(
      element('span', 'diff-path', file.path),
      element('span', 'diff-added', `+${String(file.added)}`),
      element('span', 'diff-removed', `−${String(file.removed)}`),
    );
    const table = element('table', 'diff-table');
    table.setAttribute('aria-label', `Changes in ${file.path}`);
    const body = element('tbody');
    body.append(...file.rows.slice(0, FILE_LINE_LIMIT).map((row) => diffRow(row)));
    table.append(body);
    details.append(summary, table);
    if (file.rows.length > FILE_LINE_LIMIT) {
      const rest = file.rows.slice(FILE_LINE_LIMIT);
      const more = button(`Show ${String(rest.length)} more lines`, () => {
        body.append(...rest.map((row) => diffRow(row)));
        more.remove();
      });
      details.append(more);
    }
    container.append(details);
  }
  if (isTruncated) {
    container.append(
      element('p', 'error', 'This diff was truncated for display. Inspect the branch in Git for the rest.'),
    );
  }
  return container;
}
