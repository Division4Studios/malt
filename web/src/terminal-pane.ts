/** @file One real scratch terminal view; read-only replay and explicit lifecycle controls. */
import { request, scoped } from './api.ts';
import { terminalView } from './terminal-contract.ts';
import { TerminalParser } from './terminal-parser.ts';
import { TerminalRenderer, terminalSurface } from './terminal-render.ts';
import { TerminalScreen } from './terminal-screen.ts';
import { TerminalStream } from './terminal-stream.ts';
import { element } from './worker-ui.ts';

import type { TerminalPage, TerminalView } from './terminal-contract.ts';
import type { TerminalConnectionState } from './terminal-stream.ts';

/** Bound model work before yielding to the browser. */
const TEXT_SLICE = 4096;
/** At most the bounded recent history is displayed on explicit inspection. */
const HISTORY_ROWS = 100;
/** Public short session label; full identity remains in scoped requests. */
const ID_LABEL_LENGTH = 8;
/** States which can still own a live native process. */
const ACTIVE: ReadonlySet<string> = new Set(['requested', 'starting', 'running', 'closing']);
/** Scoped view callbacks contain no credentials or agent authority. */
export interface TerminalPaneOptions {
  /** Captured project scope. */
  readonly project: string;
  /** Actual backend session metadata. */
  readonly session: TerminalView;
  /** Current operator connectivity and selected project fence. */
  readonly isReady: () => boolean;
  /** Remove a settled pane without changing native processes. */
  readonly remove: () => void;
  /** Reconcile metadata in the workspace's bounded session list. */
  readonly changed: (session: TerminalView) => void;
}

/**
 * Yield a bounded display update and cancel its scheduled frame on view disposal.
 *
 * @param signal - Owned terminal view lifetime.
 * @returns A settled paint opportunity, including cancellation.
 */
async function nextFrame(signal: AbortSignal): Promise<void> {
  const pending = Promise.withResolvers<undefined>();
  const frame = requestAnimationFrame(() => {
    pending.resolve(undefined);
  });
  const cancel = (): void => {
    cancelAnimationFrame(frame);
    pending.resolve(undefined);
  };
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) {
    cancel();
  }
  try {
    await pending.promise;
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}

/** A pane owns its transient model and fetch; it never owns delivery gates. */
export class TerminalPane {
  /** Stable DOM root survives unrelated dashboard snapshots. */
  public readonly root = element('section', 'panel terminal-pane');
  /** Native focus target; keyboard wiring is separate from captured job logs. */
  public readonly display = element('div');
  /** Bounded pure VT state shared with the native keyboard mode encoder. */
  public readonly screen: TerminalScreen;
  /** Captured immutable selection and scope callbacks. */
  private readonly options: TerminalPaneOptions;
  /** Current actual backend metadata. */
  private current: TerminalView;
  /** Incremental VT state, reset explicitly after replay loss. */
  private parser = new TerminalParser();
  /** Bounded dirty-row/native DOM rendering. */
  private readonly renderer: TerminalRenderer;
  /** Current owned read loop, absent while the pane is hidden. */
  private stream: TerminalStream | null = null;
  /** Connection status is distinct from the actual process state. */
  private phase: TerminalConnectionState = 'disconnected';
  /** Lifecycle writes are single-flight and never retried automatically. */
  private isBusy = false;
  /** Visible connection/process text. */
  private readonly status = element('p', 'subtle terminal-status');
  /** Explicit replay/mutation uncertainty feedback. */
  private readonly warning = element('p', 'notice');
  /** Native lifecycle controls. */
  private readonly closeButton = element('button', 'button secondary', 'Close session');
  /** View-only read reconnection. */
  private readonly reconnectButton = element('button', 'button secondary', 'Reconnect output');
  /** Settled panes can be retired without hiding a live process. */
  private readonly paneRemoval = element('button', 'button secondary', 'Remove pane');
  /** Explicit plain-text view of bounded primary history. */
  private readonly history = element('pre', 'log terminal-history');

  /**
   * Build semantic native controls without starting any provider or fetch.
   *
   * @param options - Actual selected session and operator callbacks.
   */
  public constructor(options: TerminalPaneOptions) {
    this.options = Object.freeze({ ...options });
    this.current = options.session;
    this.screen = new TerminalScreen(this.current.columns, this.current.rows);
    const liveRegion = element('p');
    this.renderer = new TerminalRenderer(terminalSurface(this.display, liveRegion));
    this.root.setAttribute('aria-label', `${this.current.provider} scratch terminal`);
    const heading = element('header', 'panel-heading');
    heading.append(
      element('h3', '', `${this.current.provider.toUpperCase()} / ${this.current.id.slice(0, ID_LABEL_LENGTH)}`),
    );
    const tools = element('div', 'toolbar');
    for (const button of [this.closeButton, this.reconnectButton, this.paneRemoval]) {
      button.type = 'button';
      tools.append(button);
    }
    this.closeButton.addEventListener('click', () => {
      void this.closeSession();
    });
    this.reconnectButton.addEventListener('click', () => {
      this.resume();
    });
    this.paneRemoval.addEventListener('click', () => {
      if (ACTIVE.has(this.current.state)) {
        return;
      }

      this.dispose();
      this.options.remove();
    });
    this.display.tabIndex = 0;
    this.display.setAttribute('role', 'region');
    this.display.setAttribute('aria-label', `${this.current.provider} terminal output`);
    this.warning.hidden = true;
    const details = element('details', 'terminal-history-details');
    details.append(element('summary', '', 'Recent scrollback (memory only)'), this.history);
    details.addEventListener('toggle', () => {
      if (details.open) {
        this.showHistory();
      }
    });
    const location = element('p', 'subtle terminal-location', this.current.worktree);
    this.root.append(heading, tools, this.status, this.warning, this.display, liveRegion, details, location);
    this.updateControls();
  }

  /**
   * Expose actual metadata without granting process authority to the browser.
   *
   * @returns Current backend session observation.
   */
  public get session(): TerminalView {
    return this.current;
  }

  /**
   * Report whether explicit terminal interaction has a current live boundary.
   *
   * @returns Whether the selected operator and native session are live.
   */
  public get canInteract(): boolean {
    return this.options.isReady() && this.phase === 'live' && this.current.state === 'running' && !this.isBusy;
  }

  /** Stop only the view's network work; the backend session retains its timeout policy. */
  public suspend(): void {
    this.stream?.close();
    this.stream = null;
    this.phase = 'disconnected';
    this.updateControls();
  }

  /** Reconnect read-only output from a fresh bounded replay/model, never start a process. */
  public resume(): void {
    if (!this.options.isReady()) {
      this.updateControls();
      return;
    }
    this.stream?.close();
    this.parser = new TerminalParser();
    this.screen.reset();
    this.warning.hidden = true;
    const stream = new TerminalStream({
      project: this.options.project,
      id: this.current.id,
      page: async (page, signal) => {
        if (this.stream === stream) {
          await this.receive(page, signal);
        }
      },
      state: (phase) => {
        if (this.stream !== stream) {
          return;
        }

        this.phase = phase;
        this.updateControls();
      },
    });
    this.stream = stream;
    void this.observe(stream);
  }

  /** Refresh disabled states without replacing DOM or input focus. */
  public updateControls(): void {
    this.closeButton.disabled = !this.options.isReady() || this.isBusy || !ACTIVE.has(this.current.state);
    this.reconnectButton.disabled = !this.options.isReady() || this.isBusy;
    this.paneRemoval.disabled = ACTIVE.has(this.current.state) || this.isBusy;
    const reason = this.current.reason === '' ? '' : ` · ${this.current.reason}`;
    this.status.textContent = this.isBusy
      ? 'Closing requested. Waiting for owned process cleanup…'
      : `${this.current.state} · output ${this.phase}${reason}`;
    this.root.dataset['terminalState'] = this.current.state;
  }

  /** Dispose transient view state without claiming a native close succeeded. */
  public dispose(): void {
    this.suspend();
    this.root.remove();
  }

  /**
   * Contain a failed view loop and fence results from a superseded reconnect.
   *
   * @param stream - Exactly the owned read loop being observed.
   */
  private async observe(stream: TerminalStream): Promise<void> {
    try {
      await stream.run();
    } catch {
      if (this.stream === stream) {
        this.phase = 'disconnected';
        this.updateControls();
      }
    }
  }

  /**
   * Recheck cancellation afresh after an asynchronous paint opportunity.
   *
   * @param signal - Current view lifetime.
   * @returns Whether bounded rendering still has pending dirty rows.
   */
  private hasPendingPaint(signal: AbortSignal): boolean {
    return !signal.aborted && this.renderer.render(this.screen);
  }

  /**
   * Apply bounded safe output and yield before consuming further network data.
   *
   * @param page - Validated scoped replay page.
   * @param signal - Owned view lifetime.
   */
  private async receive(page: TerminalPage, signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      return;
    }
    if (page.session.columns !== this.screen.grid.columns || page.session.rows !== this.screen.grid.rows) {
      this.screen.resize(page.session.columns, page.session.rows);
    }
    this.current = page.session;
    this.options.changed(this.current);
    this.updateControls();
    if (page.unavailable) {
      this.showWarning(
        'Replay is unavailable after a backend restart or retention limit. Session metadata is preserved.',
      );
    }
    for (const chunk of page.output) {
      signal.throwIfAborted();
      if (chunk.type === 'truncated') {
        this.parser = new TerminalParser();
        this.screen.reset();
        this.showWarning('Earlier output was evicted. Display reset; request a CLI redraw if needed.');
      } else {
        // eslint-disable-next-line no-await-in-loop -- Apply and yield one bounded text slice at a time.
        await this.applyText(chunk.text, signal);
      }
    }
    while (this.hasPendingPaint(signal)) {
      // eslint-disable-next-line no-await-in-loop -- Dirty rows are limited per paint frame, never queued without a bound.
      await nextFrame(signal);
    }
  }

  /**
   * Bound parser/model CPU work before returning control to the browser.
   *
   * @param text - One validated safe output entry.
   * @param signal - Owned view lifetime.
   */
  private async applyText(text: string, signal: AbortSignal): Promise<void> {
    for (let offset = 0; offset < text.length && !signal.aborted; offset += TEXT_SLICE) {
      this.screen.apply(this.parser.feed(text.slice(offset, offset + TEXT_SLICE)));
      if (offset + TEXT_SLICE < text.length) {
        // eslint-disable-next-line no-await-in-loop -- Bound hostile escape/scroll work while retaining native fetch backpressure.
        await nextFrame(signal);
      }
    }
  }

  /**
   * Display a fixed safe warning as text.
   *
   * @param message - Non-transcript status.
   */
  private showWarning(message: string): void {
    this.warning.hidden = false;
    this.warning.textContent = message;
  }

  /** Show a bounded plain-text history only on explicit operator inspection. */
  private showHistory(): void {
    const rows = this.screen.grid.history.slice(-HISTORY_ROWS);
    this.history.textContent =
      rows.length === 0
        ? 'No retained scrollback.'
        : rows.map((row) => row.map((cell) => cell.text).join('')).join('\n');
  }

  /** Close the actual owned session once; ambiguous errors never replay the control. */
  private async closeSession(): Promise<void> {
    if (!this.options.isReady() || this.isBusy || !ACTIVE.has(this.current.state)) {
      return;
    }
    this.isBusy = true;
    this.updateControls();
    try {
      this.current = terminalView(
        await request(scoped(this.options.project, '/api/control'), {
          operation: 'terminal_close',
          input: { id: this.current.id },
        }),
      );
      this.options.changed(this.current);
    } catch {
      this.showWarning('Close was not confirmed. Inspect or refresh sessions before deciding whether to try again.');
    } finally {
      this.isBusy = false;
      this.updateControls();
    }
  }
}
