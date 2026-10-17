/**
 * Unified diff review for local pull requests. Every value is untrusted plain
 * text; nothing is parsed as HTML.
 *
 * @file
 */
import { parseDiff } from './diff-parse.js';
import { element } from './worker-ui.js';

import type { DiffRow } from './diff-parse.js';

/** Diff lines rendered per file before collapsing the rest behind a toggle. */
const FILE_LINE_LIMIT = 400;

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
 * Append many rows in one DOM operation without spreading them as call arguments.
 *
 * @param body - Table body.
 * @param rows - Parsed rows.
 */
function appendRows(body: HTMLTableSectionElement, rows: readonly DiffRow[]): void {
  const fragment = document.createDocumentFragment();
  for (const row of rows) {
    fragment.append(diffRow(row));
  }
  body.append(fragment);
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
    appendRows(body, file.rows.slice(0, FILE_LINE_LIMIT));
    table.append(body);
    details.append(summary);
    // Binary, mode-only and rename-only changes have no hunk; their headers are the change.
    for (const note of file.notes) {
      details.append(element('p', 'diff-meta', note));
    }
    if (file.rows.length > 0) {
      details.append(table);
    }
    if (file.rows.length > FILE_LINE_LIMIT) {
      const rest = file.rows.slice(FILE_LINE_LIMIT);
      const more = button(`Show ${String(rest.length)} more lines`, () => {
        appendRows(body, rest);
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
