/**
 * Transcript viewer for one managed attempt: ordered nodes with collapsible
 * tool calls and thinking, touched files, explicit truncation notices and a
 * "N new" control while a live attempt grows and the reader has scrolled up.
 * All untrusted text is assigned with textContent, never parsed as HTML.
 *
 * @file
 */
import { child, data, hasFlag, number, records, scoped, text } from './api.js';
import { phrase, t } from './i18n.js';
import { formatCost, formatDuration, formatTokens } from './telemetry-format.js';
import { element } from './worker-ui.js';

import type { Data } from './api.js';

/** Nodes requested per transcript page. */
const PAGE_SIZE = 500;
/** Distance from the bottom, in pixels, still treated as "at the bottom". */
const BOTTOM_SLACK = 24;
/** Readable tool status labels; the text, not only color, carries the state. */
const TOOL_STATUS = new Map([
  ['ok', phrase('✓ ok')],
  ['error', phrase('✗ error')],
  ['running', phrase('… running')],
  ['incomplete', phrase('! no result')],
]);

/**
 * Read a nullable numeric field without turning unknown into zero.
 *
 * @param value - Validated record.
 * @param key - Field name.
 * @returns Finite number, or null when absent or null.
 */
export function optionalNumber(value: Data, key: string): number | null {
  const field = value[key];
  return typeof field === 'number' && Number.isFinite(field) ? field : null;
}

/**
 * Render a labelled preformatted block of untrusted text.
 *
 * @param label - Trusted caption.
 * @param body - Untrusted text.
 * @param isTruncated - Whether the source text was cut.
 * @returns Caption and text block.
 */
function block(label: string, body: string, isTruncated: boolean): HTMLElement {
  const wrapper = element('div', 'transcript-block');
  wrapper.append(element('span', 'transcript-caption', label), element('pre', 'transcript-text', body));
  if (isTruncated) {
    wrapper.append(element('span', 'subtle', t('Truncated for display; the full text remains in the attempt log.')));
  }
  return wrapper;
}

/**
 * Render a collapsible node (tool call, thinking or prompt).
 *
 * @param summary - Plain summary line.
 * @param content - Already-safe body elements.
 * @param cssClass - Trusted node classes.
 * @returns Native disclosure element, keyboard operable by default.
 */
function disclosure(summary: string, content: HTMLElement[], cssClass: string): HTMLElement {
  const node = element('details', cssClass);
  node.append(element('summary', '', summary), ...content);
  return node;
}

/**
 * Render one tool call with its paired result.
 *
 * @param node - Validated transcript node.
 * @returns Collapsible tool call.
 */
function toolNode(node: Data): HTMLElement {
  const tool = child(node, 'tool');
  const status = text(tool, 'status');
  const summary = text(tool, 'summary');
  const exitCode = optionalNumber(tool, 'exitCode');
  const line = [t(TOOL_STATUS.get(status) ?? status), text(tool, 'name'), summary].filter((part) => part !== '');
  const body = [block(t('Input'), text(tool, 'input'), hasFlag(tool, 'inputTruncated'))];
  if (status !== 'running') {
    body.push(block(t('Output'), text(tool, 'output'), hasFlag(tool, 'outputTruncated')));
  }
  if (exitCode !== null) {
    body.push(element('p', 'subtle', t('Exit code {exitCode}', { exitCode })));
  }
  return disclosure(line.join(' · '), body, `transcript-node tool ${status}`);
}

/**
 * Render a file change node listing each changed path.
 *
 * @param node - Validated transcript node.
 * @returns Caption and path list.
 */
function fileChangeNode(node: Data): HTMLElement {
  const list = element('ul', 'transcript-files');
  const changes = records(node['changes']);
  for (const change of changes) {
    list.append(element('li', '', `${text(change, 'kind')} ${text(change, 'path')}`));
  }
  const rendered = element('div', 'transcript-node file_change');
  rendered.append(element('span', 'transcript-caption', text(node, 'label')), list);
  return rendered;
}

/**
 * Render one transcript node.
 *
 * @param node - Validated transcript node.
 * @returns Safe DOM for the node.
 */
export function transcriptNode(node: Data): HTMLElement {
  const kind = text(node, 'kind');
  const isTruncated = hasFlag(node, 'truncated');
  let rendered: HTMLElement;
  switch (kind) {
    case 'tool': {
      rendered = toolNode(node);
      break;
    }
    case 'thinking':
    case 'input': {
      rendered = disclosure(
        text(node, 'label'),
        [block('', text(node, 'text'), isTruncated)],
        `transcript-node ${kind}`,
      );
      break;
    }
    case 'file_change': {
      rendered = fileChangeNode(node);
      break;
    }
    default: {
      rendered = element('div', `transcript-node ${kind} ${text(node, 'level')}`);
      rendered.append(block(text(node, 'label'), text(node, 'text'), isTruncated));
    }
  }
  rendered.dataset['seq'] = String(number(node, 'seq'));
  return rendered;
}

/**
 * Summarize attempt metrics on one line.
 *
 * @param metrics - Validated attempt metrics.
 * @returns Plain summary text.
 */
export function metricsLine(metrics: Data): string {
  const tokens = child(metrics, 'tokens');
  const cost = child(metrics, 'cost');
  const tools = child(metrics, 'tools');
  return [
    `${formatTokens(optionalNumber(tokens, 'total'))} tokens`,
    formatCost(optionalNumber(cost, 'usd'), text(cost, 'source')),
    formatDuration(optionalNumber(metrics, 'durationMs')),
    t('{total} tool calls ({failed} failed)', {
      total: number(tools, 'total'),
      failed: number(tools, 'failed'),
    }),
    `${String(number(metrics, 'filesTouched'))} files`,
  ].join(' · ');
}

/** Stateful viewer for one attempt at a time. */
export class TranscriptViewer {
  /** Root element, stable across refreshes. */
  public readonly element = element('section', 'panel transcript');
  /** Reads a same-origin API route. */
  private readonly read: (route: string) => Promise<unknown>;
  /** Heading. */
  private readonly title = element('h2', '', t('Transcript'));
  /** Metrics, files and notices. */
  private readonly details = element('div', 'transcript-details');
  /** Scrollable node list. */
  private readonly list = element('div', 'transcript-nodes');
  /** Jump to newly arrived nodes. */
  private readonly newer = element('button', 'small-button transcript-new', '');
  /** Load the next page of a long finished transcript. */
  private readonly more = element('button', 'small-button', t('Load more of this transcript'));
  /** Polite status for loading and errors. */
  private readonly status = element('p', 'subtle');
  /** Selected project and attempt. */
  private target: { project: string; jobId: string } | null = null;
  /** Loaded nodes in order. */
  private nodes: Data[] = [];
  /** Next node cursor, null when the loaded nodes are complete. */
  private nextCursor: number | null = null;
  /** Whether the attempt is still running. */
  private isLive = false;
  /** New nodes not yet scrolled into view. */
  private unseen = 0;
  /** Single-flight guard. */
  private isLoading = false;

  /**
   * Build the empty viewer.
   *
   * @param read - Same-origin JSON reader.
   */
  public constructor(read: (route: string) => Promise<unknown>) {
    this.read = read;
    this.element.setAttribute('aria-label', t('Attempt transcript'));
    this.element.hidden = true;
    this.list.tabIndex = 0;
    this.list.setAttribute('role', 'region');
    this.list.setAttribute('aria-label', t('Transcript nodes'));
    this.status.setAttribute('aria-live', 'polite');
    this.newer.type = 'button';
    this.newer.hidden = true;
    this.more.type = 'button';
    this.more.hidden = true;
    const head = element('div', 'panel-head');
    const close = element('button', 'small-button', t('Close transcript'));
    close.type = 'button';
    close.addEventListener('click', () => {
      this.close();
    });
    head.append(this.title, close);
    const body = element('div', 'panel-body');
    body.append(this.status, this.details, this.newer, this.list, this.more);
    this.element.append(head, body);
    this.newer.addEventListener('click', () => {
      this.list.scrollTop = this.list.scrollHeight;
      this.markSeen();
    });
    this.list.addEventListener('scroll', () => {
      if (this.isAtBottom()) {
        this.markSeen();
      }
    });
    this.more.addEventListener('click', () => {
      void this.load(this.nextCursor ?? this.nodes.length);
    });
  }

  /**
   * Open one attempt's transcript from its first node.
   *
   * @param project - Public project id.
   * @param jobId - Attempt id.
   * @param label - Plain heading for the attempt.
   */
  public async open(project: string, jobId: string, label: string): Promise<void> {
    this.target = { project, jobId };
    this.nodes = [];
    this.nextCursor = null;
    this.unseen = 0;
    this.isLive = false;
    this.list.replaceChildren();
    // Nothing from the previous attempt may show under this one's heading.
    this.details.replaceChildren();
    this.more.hidden = true;
    this.newer.hidden = true;
    this.title.textContent = t('Transcript · {label}', { label });
    this.element.hidden = false;
    await this.load(0);
    this.list.focus();
  }

  /** Hide the viewer and stop following its attempt. */
  public close(): void {
    this.target = null;
    this.element.hidden = true;
  }

  /** Re-read a live attempt from its first unfinished tool call or its end. */
  public async refresh(): Promise<void> {
    if (this.target === null || !this.isLive) {
      return;
    }
    const running = this.nodes.find((node) => text(child(node, 'tool'), 'status') === 'running');
    await this.load(running === undefined ? this.nodes.length : number(running, 'seq'));
  }

  /**
   * Load nodes from a cursor, replacing any loaded nodes at or after it.
   *
   * @param cursor - First node to (re)load.
   */
  private async load(cursor: number): Promise<void> {
    const { target } = this;
    if (target === null || this.isLoading) {
      return;
    }
    this.isLoading = true;
    this.status.textContent = t('Loading transcript…');
    try {
      const route = `${scoped(target.project, '/api/transcript')}&job=${encodeURIComponent(target.jobId)}&cursor=${String(cursor)}&limit=${String(PAGE_SIZE)}`;
      const page = data(await this.read(route));
      if (this.target !== target) {
        return;
      }
      this.apply(page, cursor);
      this.status.textContent = '';
    } catch (error) {
      this.status.textContent = error instanceof Error ? error.message : t('The transcript could not be read.');
    } finally {
      this.isLoading = false;
      // A different attempt opened while this read was in flight: read it now.
      if (this.target !== null && this.target !== target) {
        void this.load(0);
      }
    }
  }

  /**
   * Merge one page into the view, keeping the reader's scroll position.
   *
   * @param page - Validated transcript page.
   * @param cursor - First node the page replaces.
   */
  private apply(page: Data, cursor: number): void {
    const wasAtBottom = this.isAtBottom();
    const before = this.nodes.length;
    const incoming = records(page['nodes']);
    this.nodes = [...this.nodes.slice(0, cursor), ...incoming];
    // A static snapshot: removing nodes must not disturb the iteration.
    const rendered = this.list.querySelectorAll<HTMLElement>(':scope > [data-seq]');
    for (const stale of rendered) {
      if (Number(stale.dataset['seq']) >= cursor) {
        stale.remove();
      }
    }
    this.list.append(...incoming.map((node) => transcriptNode(node)));
    this.isLive = hasFlag(page, 'live');
    this.nextCursor = optionalNumber(page, 'nextCursor');
    this.more.hidden = this.nextCursor === null;
    this.renderDetails(page);
    const added = Math.max(0, this.nodes.length - before);
    if (!wasAtBottom && before > 0 && added > 0) {
      this.unseen += added;
      this.newer.textContent = `${String(this.unseen)} new`;
      this.newer.hidden = false;
    } else if (wasAtBottom && before > 0) {
      this.list.scrollTop = this.list.scrollHeight;
    }
  }

  /**
   * Show metrics, touched files and truncation notices.
   *
   * @param page - Validated transcript page.
   */
  private renderDetails(page: Data): void {
    const metrics = child(page, 'metrics');
    const stream = child(metrics, 'stream');
    const parts: HTMLElement[] = [element('p', '', metricsLine(metrics))];
    if (this.isLive) {
      parts.push(element('p', 'subtle', t('Live attempt: new output appears as the console refreshes.')));
    }
    if (hasFlag(page, 'nodesTruncated')) {
      const total = String(number(page, 'totalNodes'));
      parts.push(element('p', 'notice', t('Transcript capped at {total} nodes.', { total })));
    }
    if (hasFlag(stream, 'truncated')) {
      parts.push(element('p', 'notice', t('The provider log exceeded the read limit; later events are not shown.')));
    }
    if (!hasFlag(stream, 'available')) {
      parts.push(element('p', 'notice', t('No provider log was recorded for this attempt.')));
    }
    const malformed = number(stream, 'malformedLines') + number(stream, 'unknownEvents');
    if (malformed > 0) {
      parts.push(element('p', 'subtle', t('{malformed} unrecognized log lines were skipped.', { malformed })));
    }
    const files = records(page['filesTouched']);
    if (files.length > 0) {
      const list = element('ul', 'transcript-files');
      list.append(
        ...files.map((file) => element('li', '', `${text(file, 'path')} ×${String(number(file, 'touches'))}`)),
      );
      parts.push(disclosure(t('Files touched ({length})', { length: files.length }), [list], 'transcript-touched'));
    }
    if (hasFlag(page, 'filesTruncated')) {
      parts.push(element('p', 'notice', t('More files were touched than are listed here.')));
    }
    this.details.replaceChildren(...parts);
  }

  /**
   * Whether the reader is at the end of the node list.
   *
   * @returns True when scrolled to (or within a small slack of) the bottom.
   */
  private isAtBottom(): boolean {
    return this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight <= BOTTOM_SLACK;
  }

  /** Clear the unseen-node counter. */
  private markSeen(): void {
    this.unseen = 0;
    this.newer.hidden = true;
  }
}
