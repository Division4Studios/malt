/**
 * Controller for the persistent delivery manager view. It owns the bounded
 * conversation window, refreshed only when the manager's status changes, and
 * keeps the composer and transcript as persistent DOM nodes so live refreshes
 * never discard a half-typed message or jump the operator's scroll position.
 *
 * @file
 */
import { data, number, records, request, scoped, text } from './api.js';
import { element } from './worker-ui.js';

import type { Data } from './api.js';

/** Conversation entries kept in view. */
const WINDOW = 200;
/** Page size for transcript export. */
const EXPORT_PAGE = 500;
/** Milliseconds per second. */
const SECOND_MS = 1000;
/** Seconds per minute, and minutes per hour. */
const SECONDS_PER_MINUTE = 60;
/** Show hours from this many minutes on. */
const HOURS_AFTER_MINUTES = 90;
/** Characters of an ISO date. */
const DATE_LENGTH = 10;
/** Distance from the bottom that still counts as following the conversation. */
const FOLLOW_SLACK = 48;

/** Collaborators owned by the main app. */
export interface ManagerDependencies {
  /** Current public project identifier. */
  readonly project: () => string;
  /** Single-flight operator control. */
  readonly control: (operation: string, input: unknown) => Promise<boolean>;
  /** Accessible notice. */
  readonly notice: (message: string, isSuccess?: boolean) => void;
  /** Re-render the current view. */
  readonly render: () => void;
}

/** Plain labels for conversation delivery states. */
const STATE_LABELS: Readonly<Record<string, string>> = {
  queued: 'Queued',
  sent: 'Sent',
  acknowledged: 'Received',
  answered: 'Answered',
  failed: 'Failed',
  delivered: 'Delivered to the manager',
};

/**
 * Format a time as a short relative phrase.
 *
 * @param at - Epoch milliseconds.
 * @param now - Current time.
 * @returns Phrase such as "3 min ago".
 */
export function ago(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / SECOND_MS));
  if (seconds < SECONDS_PER_MINUTE) {
    return `${String(seconds)} s ago`;
  }
  const minutes = Math.round(seconds / SECONDS_PER_MINUTE);
  const hours = Math.round(minutes / SECONDS_PER_MINUTE);
  return minutes < HOURS_AFTER_MINUTES ? `${String(minutes)} min ago` : `${String(hours)} h ago`;
}

/**
 * Render one conversation entry.
 *
 * @param entry - Ledger entry.
 * @param now - Current time.
 * @returns Entry element.
 */
function entryNode(entry: Data, now: number): HTMLElement {
  const author = text(entry, 'author');
  const state = text(entry, 'state');
  const node = element('article', `chat-entry chat-${author}`);
  if (author === 'digest') {
    node.append(element('p', 'chat-meta', `Reports delivered to the manager · ${STATE_LABELS[state] ?? state}`));
    return node;
  }
  if (author !== 'system') {
    node.append(
      element('p', 'chat-author', { operator: 'You', manager: 'Manager', report: 'Report' }[author] ?? author),
    );
  }
  node.append(element('p', 'chat-body', text(entry, 'body')));
  const meta = [ago(number(entry, 'created_at'), now)];
  if (author === 'operator' && STATE_LABELS[state] !== undefined) {
    meta.push(STATE_LABELS[state] ?? state);
  }
  const footer = element('p', `chat-meta${state === 'failed' ? ' chat-failed' : ''}`, meta.join(' · '));
  if (state === 'failed' && text(entry, 'note') !== '') {
    footer.append(element('span', '', ` — ${text(entry, 'note')}`));
  }
  node.append(footer);
  return node;
}

/**
 * Render a transcript as Markdown for export.
 *
 * @param entries - All conversation entries.
 * @param project - Project label.
 * @returns Markdown document.
 */
export function transcriptMarkdown(entries: readonly Data[], project: string): string {
  const lines = [`# Delivery manager transcript — ${project}`, ''];
  for (const entry of entries) {
    const created = new Date(number(entry, 'created_at'));
    const author = text(entry, 'author');
    const delivery = author === 'operator' ? ` · ${text(entry, 'state')}` : '';
    lines.push(`**${author}** · ${created.toISOString()}${delivery}`, '', text(entry, 'body'), '');
  }
  return lines.join('\n');
}

/** Manager view controller. */
export class ManagerController {
  /** Persistent transcript container. */
  public readonly transcript = element('div', 'chat-transcript');
  /** Persistent composer. */
  public readonly composer = element('form', 'chat-composer');
  /** Loaded conversation window. */
  private entries: Data[] = [];
  /** Status signature of the loaded window. */
  private loadedSignature = '';
  /** Project of the loaded window. */
  private loadedProject = '';
  /** Draft input. */
  private readonly input = element('textarea', 'chat-input');
  /** App collaborators. */
  private readonly dependencies: ManagerDependencies;

  /**
   * Build the persistent composer.
   *
   * @param dependencies - App collaborators.
   */
  public constructor(dependencies: ManagerDependencies) {
    this.dependencies = dependencies;
    this.input.rows = 3;
    this.input.placeholder = 'Message the delivery manager. Enter sends; Shift+Enter adds a line.';
    this.input.setAttribute('aria-label', 'Message to the delivery manager');
    const send = element('button', 'button primary', 'Send');
    send.type = 'submit';
    this.composer.append(this.input, send);
    this.composer.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.send();
    });
    this.input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing) {
        return;
      }

      event.preventDefault();
      void this.send();
    });
    this.transcript.setAttribute('role', 'log');
    this.transcript.setAttribute('aria-live', 'polite');
    this.transcript.setAttribute('aria-label', 'Conversation with the delivery manager');
  }

  /**
   * Reload the conversation window when the manager's status changed.
   *
   * @param summary - Snapshot manager summary.
   */
  public observe(summary: Data | null): void {
    const project = this.dependencies.project();
    if (project !== this.loadedProject) {
      this.loadedProject = project;
      this.entries = [];
      this.loadedSignature = '';
      this.draw();
    }
    if (summary === null) {
      return;
    }
    const status = data(summary['status']);
    const session = status['session'] === null ? {} : data(status['session']);
    const signature = JSON.stringify([
      number(status, 'latestSeq'),
      number(status, 'queued'),
      number(session, 'updated_at'),
      text(session, 'state'),
    ]);
    if (signature === this.loadedSignature) {
      return;
    }

    this.loadedSignature = signature;
    void this.load(project, number(status, 'latestSeq'));
  }

  /**
   * Run a manager control.
   *
   * @param action - Control action.
   * @param extra - Additional input.
   */
  public act(action: string, extra: Record<string, unknown> = {}): void {
    void this.dependencies.control('factory_manager', { action, ...extra });
  }

  /**
   * Remember composer focus and selection so a re-render can restore them.
   *
   * @returns Restores focus if the composer had it.
   */
  public captureFocus(): () => void {
    if (document.activeElement !== this.input) {
      return () => {
        /* The composer did not have focus. */
      };
    }
    const { selectionStart, selectionEnd } = this.input;
    return () => {
      this.input.focus();
      this.input.setSelectionRange(selectionStart, selectionEnd);
    };
  }

  /** Download the complete transcript as Markdown. */
  public async exportTranscript(): Promise<void> {
    const project = this.dependencies.project();
    const all = await this.readAll(project);
    const blob = new Blob([transcriptMarkdown(all, project)], { type: 'text/markdown' });
    const link = element('a');
    link.href = URL.createObjectURL(blob);
    const today = new Date();
    link.download = `manager-transcript-${today.toISOString().slice(0, DATE_LENGTH)}.md`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  /**
   * Read the whole conversation in cursor order.
   *
   * @param project - Project captured before the reads.
   * @param after - Exclusive cursor to continue from.
   * @returns Every entry after the cursor.
   */
  private async readAll(project: string, after = 0): Promise<Data[]> {
    const url = `${scoped(project, '/api/manager-history')}&after=${String(after)}&limit=${String(EXPORT_PAGE)}`;
    const entries = records(data(await request(url))['entries']);
    return entries.length < EXPORT_PAGE
      ? entries
      : [...entries, ...(await this.readAll(project, number(entries.at(-1) ?? {}, 'seq')))];
  }

  /** Send the draft; it stays in the composer if the control fails. */
  private async send(): Promise<void> {
    const draft = this.input.value.trim();
    if (draft === '') {
      return;
    }
    const isApplied = await this.dependencies.control('factory_manager', { action: 'send', text: draft });
    if (!isApplied) {
      return;
    }

    this.input.value = '';
    this.input.focus();
  }

  /**
   * Load the recent conversation window.
   *
   * @param project - Project captured before the request.
   * @param latest - Latest sequence reported by the snapshot.
   */
  private async load(project: string, latest: number): Promise<void> {
    const after = Math.max(0, latest - WINDOW);
    try {
      const page = data(
        await request(`${scoped(project, '/api/manager-history')}&after=${String(after)}&limit=${String(WINDOW)}`),
      );
      if (project === this.dependencies.project()) {
        this.entries = records(page['entries']);
        this.draw();
      }
    } catch (error) {
      this.dependencies.notice(error instanceof Error ? error.message : 'Could not read the manager conversation.');
    }
  }

  /** Redraw the transcript, following the bottom only if the operator was already there. */
  private draw(): void {
    const box = this.transcript;
    const isFollowing = box.scrollHeight - box.scrollTop - box.clientHeight < FOLLOW_SLACK;
    const now = Date.now();
    box.replaceChildren(...this.entries.map((entry) => entryNode(entry, now)));
    if (this.entries.length === 0) {
      box.append(
        element(
          'p',
          'subtle chat-empty',
          'No conversation yet. Start the manager, then tell it what you want delivered; it will clarify, plan and report back.',
        ),
      );
    }
    if (isFollowing) {
      box.scrollTop = box.scrollHeight;
    }
  }
}
