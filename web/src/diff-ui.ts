/**
 * The delivery detail's Changes section: a summary of the files the delivery's
 * exact head changes against its base, loaded when the operator asks, and each
 * file's patch loaded when its row is opened. The section element is stable,
 * so loaded files, open rows and focus survive every snapshot push; a new head
 * clears them. Every value is untrusted plain text; nothing is parsed as HTML.
 *
 * @file
 */
import { request } from './api.js';
import { button } from './console-dom.js';
import { shortSha } from './console-model.js';
import {
  countText,
  diffRoute,
  fileNotes,
  isLargeFile,
  readDiffPatch,
  readDiffSummary,
  statusText,
  summaryNotes,
  totalsText,
  truncationText,
} from './diff-model.js';
import { phrase, t, translated } from './i18n.js';
import { element } from './worker-ui.js';

import type { DiffFileView, DiffPatchView, DiffSummaryView } from './diff-model.js';
import type { DiffRow } from './diff-parse.js';

/** Files that open by themselves when a summary lists no more than this many. */
const AUTO_OPEN_FILES = 8;
/** Visible marker per row kind. */
const MARKERS: Readonly<Record<DiffRow['kind'], string>> = { add: '+', del: '−', ctx: '', hunk: '' };
/** Accessible name per row kind, for screen readers that skip the marker column. */
const ROW_LABELS: Readonly<Record<DiffRow['kind'], string>> = translated({
  add: phrase('Added line'),
  del: phrase('Removed line'),
  ctx: phrase('Unchanged line'),
  hunk: phrase('Hunk'),
});

/**
 * The message of a failed read.
 *
 * @param error - Thrown value.
 * @param fallback - Text when it carries no message.
 * @returns Plain message.
 */
function failureText(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/**
 * Render one diff row.
 *
 * @param row - Parsed row.
 * @returns Table row.
 */
function diffRow(row: DiffRow): HTMLTableRowElement {
  const node = element('tr', `diff-${row.kind}`);
  node.setAttribute('aria-label', ROW_LABELS[row.kind]);
  node.append(
    element('td', 'diff-number', row.old),
    element('td', 'diff-number', row.new),
    element('td', 'diff-marker', MARKERS[row.kind]),
    element('td', 'diff-text', row.text),
  );
  return node;
}

/**
 * Render a patch as a numbered table built in one DOM operation.
 *
 * @param path - File the patch belongs to.
 * @param patch - Loaded patch.
 * @returns Rows, header notes and any truncation note.
 */
function patchBody(path: string, patch: DiffPatchView): HTMLElement {
  const body = element('div', 'delivery-diff-patch');
  if (patch.state === 'unavailable') {
    body.append(element('p', 'subtle', patch.reason));
    return body;
  }
  // Binary, mode-only and rename-only changes have no hunk; Git's header lines are the change.
  for (const note of patch.notes) {
    body.append(element('p', 'diff-meta', note));
  }
  if (patch.rows.length > 0) {
    const scroller = element('div', 'delivery-diff-scroll');
    const table = element('table', 'diff-table');
    table.setAttribute('aria-label', t('Changes in {path}', { path }));
    const rows = element('tbody');
    const fragment = document.createDocumentFragment();
    for (const row of patch.rows) {
      fragment.append(diffRow(row));
    }
    rows.append(fragment);
    table.append(rows);
    scroller.append(table);
    body.append(scroller);
  } else if (patch.notes.length === 0 && !patch.isTruncated) {
    body.append(element('p', 'subtle', t('No line changes.')));
  }
  const truncated = truncationText(patch);
  if (truncated !== null) {
    body.append(element('p', 'diff-meta', truncated));
  }
  return body;
}

/** The Changes section of one delivery. */
export class DeliveryDiff {
  /** Stable section element. */
  public readonly element = element('section', 'delivery-diff');
  /** Selected project. */
  private readonly project: () => string;
  /** Section body below the heading. */
  private readonly body = element('div', 'delivery-diff-body');
  /** Delivery and head the loaded state belongs to. */
  private key = '';
  /** Delivery shown. */
  private taskId = '';
  /** Its current head, if published. */
  private head: string | null = null;
  /** Loaded summary, or null before loading. */
  private summary: DiffSummaryView | null = null;
  /** Loaded patches by path. */
  private readonly patches = new Map<string, DiffPatchView>();
  /** Paths whose patch read is in flight. */
  private readonly pending = new Set<string>();
  /** Paths the operator opened or closed, overriding the default. */
  private readonly opened = new Map<string, boolean>();
  /** Whether a summary read is in flight. */
  private isLoading = false;

  /**
   * Build the section once.
   *
   * @param project - Selected project id.
   */
  public constructor(project: () => string) {
    this.project = project;
    const heading = element('h3', 'delivery-section-title', t('Changes'));
    this.element.setAttribute('aria-live', 'polite');
    this.element.append(heading, this.body);
  }

  /**
   * Show a delivery's head; a different delivery or head clears what was loaded.
   *
   * @param taskId - Delivery shown.
   * @param head - Its current head, if published.
   * @param base - Its current base, if recorded.
   */
  public show(taskId: string, head: string | null, base: string | null): void {
    const key = JSON.stringify([taskId, head, base]);
    if (key === this.key) {
      return;
    }
    this.key = key;
    this.taskId = taskId;
    this.head = head;
    this.summary = null;
    this.patches.clear();
    this.pending.clear();
    this.opened.clear();
    this.render();
  }

  /** Render the current state. */
  private render(): void {
    const { head } = this;
    if (this.summary === null) {
      const load = button(t(this.isLoading ? 'Loading changes…' : 'Show changes'), {
        cssClass: 'button secondary',
        key: 'diff-load',
        action: () => {
          void this.load();
        },
      });
      load.disabled = this.isLoading || head === null;
      const hint =
        head === null
          ? t('Changes appear once the delivery publishes source.')
          : t('Compare head {value} with its base.', { value: shortSha(head) });
      this.body.replaceChildren(element('p', 'subtle', hint), load);
      return;
    }
    if (this.summary.state === 'unavailable') {
      this.body.replaceChildren(element('p', 'subtle', this.summary.reason));
      return;
    }
    const { summary } = this;
    const overview = element('p', 'delivery-diff-totals', totalsText(summary));
    overview.tabIndex = -1;
    const notes = summaryNotes(summary).map((note) => element('p', 'diff-meta', note));
    const list = element('div', 'delivery-diff-files');
    const shouldOpen = summary.files.length <= AUTO_OPEN_FILES;
    for (const file of summary.files) {
      list.append(this.fileNode(file, shouldOpen && !isLargeFile(file)));
    }
    if (summary.files.length === 0) {
      list.append(element('p', 'subtle', t('No public file changes.')));
    }
    this.body.replaceChildren(overview, ...notes, list);
  }

  /**
   * Build one file row whose patch loads when it opens.
   *
   * @param file - Changed file.
   * @param isOpenByDefault - Whether it starts open.
   * @returns Details element.
   */
  private fileNode(file: DiffFileView, isOpenByDefault: boolean): HTMLDetailsElement {
    const details = element('details', 'delivery-diff-file');
    const head = element('summary', 'delivery-diff-file-head');
    head.dataset['focusKey'] = `diff:${file.path}`;
    head.append(
      element('span', 'diff-path', file.path),
      element('span', `delivery-diff-status status-${file.status}`, statusText(file)),
      element('span', 'delivery-diff-count', countText(file)),
    );
    details.append(head);
    for (const note of fileNotes(file)) {
      details.append(element('p', 'diff-meta', note));
    }
    const loaded = this.patches.get(file.path);
    if (loaded !== undefined) {
      details.append(patchBody(file.path, loaded));
    }
    details.open = this.opened.get(file.path) ?? isOpenByDefault;
    details.addEventListener('toggle', () => {
      this.opened.set(file.path, details.open);
      if (details.open && !this.patches.has(file.path) && !this.pending.has(file.path)) {
        void this.loadPatch(file.path, details);
      }
    });
    return details;
  }

  /** Read the summary once; the next render shows it. */
  private async load(): Promise<void> {
    if (this.isLoading) {
      return;
    }
    const { key, taskId } = this;
    this.isLoading = true;
    this.render();
    let summary: DiffSummaryView;
    try {
      const route = diffRoute(this.project(), taskId);
      summary = readDiffSummary(await request(route));
    } catch (error) {
      summary = { state: 'unavailable', reason: failureText(error, t('The diff could not be read.')) };
    } finally {
      this.isLoading = false;
    }
    if (key !== this.key) {
      return;
    }
    this.summary = summary;
    this.render();
    this.element.querySelector<HTMLElement>('.delivery-diff-totals')?.focus({ preventScroll: true });
  }

  /**
   * Read one file's patch into its open row.
   *
   * @param path - Listed path.
   * @param details - Row to fill.
   */
  private async loadPatch(path: string, details: HTMLDetailsElement): Promise<void> {
    const { key, taskId } = this;
    this.pending.add(path);
    const placeholder = element('p', 'subtle delivery-diff-loading', t('Loading patch…'));
    details.append(placeholder);
    let patch: DiffPatchView;
    try {
      const route = diffRoute(this.project(), taskId, path);
      patch = readDiffPatch(await request(route));
    } catch (error) {
      patch = { state: 'unavailable', reason: failureText(error, t('The patch could not be read.')) };
    }
    placeholder.remove();
    if (key !== this.key) {
      return;
    }
    this.pending.delete(path);
    this.patches.set(path, patch);
    details.append(patchBody(path, patch));
  }
}
