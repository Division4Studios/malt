/** @file Explicit focus-scoped native keyboard and geometry controls. */
import { scoped } from './api.ts';
import { phrase, t } from './i18n.js';
import { terminalView } from './terminal-contract.ts';
import { terminalKey, terminalPaste } from './terminal-keys.ts';
import { TerminalWrites } from './terminal-writes.ts';
import { element } from './worker-ui.ts';

import type { TerminalView } from './terminal-contract.ts';
import type { TerminalScreen } from './terminal-screen.ts';

/** Bounded geometry/traffic deadlines; no resize loop can keep the CLI alive. */
const LIMIT = { columns: 500, rows: 200, debounce: 200, deadline: 10_000, cell: 8, line: 18 } as const;
/** Pane height choices and their labels. */
const HEIGHT_LABELS = { compact: phrase('Compact'), standard: phrase('Standard'), tall: phrase('Tall') } as const;

/**
 * Read computed CSS pixels, including fractional zoom-dependent padding.
 *
 * @param value - Native computed length, never project text.
 * @returns Nonnegative finite pixels or a safe zero fallback.
 */
function cssPixels(value: string): number {
  const pixels = Number(value.replace(/px$/v, ''));
  return Number.isFinite(pixels) && pixels >= 0 ? pixels : 0;
}
/** Exactly one pane's native input authority. */
export interface TerminalInputOptions {
  /** Captured selected project and native session identity. */
  readonly project: string;
  /** Captured native session, never a managed job identifier. */
  readonly id: string;
  /** Actual screen geometry/modes. */
  readonly screen: TerminalScreen;
  /** Stable native output mount. */
  readonly display: HTMLElement;
  /** Fresh authenticated session gate. */
  readonly isReady: () => boolean;
  /** Safe non-input status. */
  readonly warn: (message: string) => void;
  /** Apply confirmed geometry through the owning pane's bounded renderer. */
  readonly resized: (session: TerminalView, signal: AbortSignal) => Promise<void>;
}

/** No global key listener: only explicit capture inside this real terminal pane. */
export class TerminalInput {
  /** Native accessible controls, separate from the terminal output region. */
  public readonly root = element('div', 'terminal-input-controls');
  /** Explicitly opt into or release native keystrokes. */
  private readonly capture = element('button', 'button secondary', t('Capture keyboard'));
  /** Native editable input permits composition and mobile keyboards. */
  private readonly keyboard = element('textarea', 'terminal-keyboard');
  /** Tab remains a browser focus key; completion has an explicit native control. */
  private readonly tab = element('button', 'button secondary', t('Send Tab'));
  /** Escape always releases capture; CLI escape remains an explicit native control. */
  private readonly escape = element('button', 'button secondary', t('Send Escape'));
  /** Explicit geometry controls support keyboard-only resizing. */
  private readonly columns = element('input');
  /** Explicit native rows. */
  private readonly rows = element('input');
  /** Native geometry write, never automatically retried after uncertainty. */
  private readonly resizeButton = element('button', 'button secondary', t('Apply size'));
  /** Automatic geometry is opt-in; merely reading output sends no controls. */
  private readonly fit = element('input');
  /** Height selection works without a pointer drag. */
  private readonly height = element('select');
  /** Only this view's pending network mutations are abortable. */
  private lifetime = new AbortController();
  /** Pane/session ownership outlives focus changes for already-authorized keys. */
  private writes: TerminalWrites | null = null;
  /** Only explicit capture admits new keyboard/clipboard events. */
  private isCaptured = false;
  /** Optional native observer has no polling timer. */
  private readonly observer: ResizeObserver;
  /** One pending debounce, cleared on every suspension. */
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** At most one resize request in flight. */
  private isResizing = false;
  /** Observer state is distinct from native process state. */
  private isObserving = false;
  /** Native composition is sent as completed text, never partial key events. */
  private isComposing = false;
  /** Frozen project/session scope. */
  private readonly options: TerminalInputOptions;

  /**
   * Build controls without sending a key, resize or provider start.
   *
   * @param options - Actual owned terminal boundary.
   */
  public constructor(options: TerminalInputOptions) {
    this.options = Object.freeze({ ...options });
    this.observer = new ResizeObserver(() => {
      this.scheduleFit();
    });
    const toolbar = element('div', 'toolbar');
    for (const button of [this.capture, this.tab, this.escape, this.resizeButton]) {
      button.type = 'button';
    }
    toolbar.append(this.capture, this.tab, this.escape);
    this.keyboard.rows = 1;
    this.keyboard.spellcheck = false;
    this.keyboard.autocomplete = 'off';
    this.keyboard.setAttribute('autocapitalize', 'off');
    this.keyboard.setAttribute('aria-label', t('Captured terminal keyboard input'));
    this.keyboard.placeholder = t('Capture keyboard to send native input. Escape releases; Tab moves focus.');
    this.capture.addEventListener('pointerdown', (event) => {
      if (this.isCaptured) {
        event.preventDefault();
      }
    });
    this.capture.addEventListener('click', () => {
      if (this.isCaptured) {
        this.release();
      } else {
        this.captureKeys();
      }
      this.update();
    });
    this.keyboard.addEventListener('keydown', (event) => {
      this.keydown(event);
    });
    this.keyboard.addEventListener('paste', (event) => {
      event.preventDefault();
      if (this.isCaptured) {
        this.paste(event.clipboardData?.getData('text/plain') ?? '');
      }
    });
    this.keyboard.addEventListener('blur', () => {
      this.release();
      this.update();
    });
    this.keyboard.addEventListener('compositionstart', () => {
      this.isComposing = true;
    });
    this.keyboard.addEventListener('compositionend', () => {
      this.isComposing = false;
      this.readEditable();
    });
    this.keyboard.addEventListener('input', () => {
      if (!this.isComposing) {
        this.readEditable();
      }
    });
    this.tab.addEventListener('click', () => {
      this.sendExplicit('\t');
    });
    this.escape.addEventListener('click', () => {
      this.sendExplicit('\u{1B}');
    });
    this.buildGeometry();
    this.root.append(
      toolbar,
      this.keyboard,
      element(
        'p',
        'subtle',
        t(
          'Input goes directly to this scratch CLI. It is not a durable worker instruction and is never saved or replayed.',
        ),
      ),
      this.geometry(),
    );
    this.update();
  }

  /** Reconcile native readiness without moving focus or replacing DOM. */
  public update(): void {
    const isReady = this.options.isReady();
    if (!isReady) {
      this.suspend();
    } else if (this.lifetime.signal.aborted) {
      this.lifetime = new AbortController();
    }
    this.capture.disabled = !isReady;
    this.capture.textContent = t(this.isCaptured ? 'Release keyboard' : 'Capture keyboard');
    this.capture.setAttribute('aria-pressed', String(this.isCaptured));
    this.keyboard.disabled = !isReady || !this.isCaptured;
    this.tab.disabled = !isReady;
    this.escape.disabled = !isReady;
    this.resizeButton.disabled = !isReady || this.isResizing;
    this.fit.disabled = !isReady;
    if (!(isReady && this.fit.checked) || this.isObserving) {
      return;
    }

    this.observer.observe(this.options.display);
    this.isObserving = true;
  }

  /** Cancel reads/mutations owned by this view and drop every unsent keystroke. */
  public suspend(): void {
    this.release();
    this.writes?.close();
    this.writes = null;
    this.lifetime.abort();
    this.observer.disconnect();
    this.isObserving = false;
    if (this.timer === null) {
      return;
    }

    clearTimeout(this.timer);
    this.timer = null;
  }

  /** Retire observers, queued text and controls when the pane is disposed. */
  public dispose(): void {
    this.suspend();
    this.root.remove();
  }

  /** Explicit human keyboard capture; reconnect never restores it automatically. */
  private captureKeys(): void {
    if (!this.options.isReady()) {
      return;
    }
    this.ensureQueue();
    this.isCaptured = true;
    this.update();
    this.keyboard.focus();
  }

  /** Keep explicit controls ordered behind already admitted keys across blur. */
  private ensureQueue(): void {
    if (this.writes !== null || !this.options.isReady()) {
      return;
    }
    const { signal } = this.lifetime;
    this.writes = new TerminalWrites({
      isReady: () => !signal.aborted && this.options.isReady(),
      send: async (text) => {
        await this.post('terminal_input', { text }, signal);
      },
      failed: () => {
        this.writes = null;
        this.release();
        this.options.warn(
          t(
            'Input was not confirmed. Unsent keys were discarded. Inspect the CLI before capturing again; nothing was retried.',
          ),
        );
        this.update();
      },
    });
  }

  /** Release capture without sending the browser's focus escape to the CLI. */
  private release(): void {
    this.isCaptured = false;
    this.keyboard.value = '';
    this.isComposing = false;
  }

  /**
   * Handle only keys focused in this pane's explicit capture field.
   *
   * @param event - Native focused key event.
   */
  private keydown(event: KeyboardEvent): void {
    if (!this.isCaptured || !this.options.isReady()) {
      return;
    }
    if (event.key === 'Escape' || event.key === 'Tab') {
      this.release();
      this.update();
      if (event.key === 'Escape') {
        event.preventDefault();
        this.capture.focus();
      }
      return;
    }
    const text = terminalKey(event, this.options.screen.isApplicationCursor);
    if (text === null) {
      return;
    }

    event.preventDefault();
    this.enqueue(text);
  }

  /** Read completed native IME/mobile text, clearing it before any request. */
  private readEditable(): void {
    const text = this.keyboard.value;
    this.keyboard.value = '';
    this.paste(text);
  }

  /**
   * Sanitize explicit clipboard/composition text without interpreting escape sequences.
   *
   * @param text - Native editable/clipboard text.
   */
  private paste(text: string): void {
    try {
      this.enqueue(terminalPaste(text, this.options.screen.isBracketedPaste));
    } catch {
      this.options.warn(
        t('Paste exceeds the raw clipboard or 16 KiB native input limit. Split it into smaller explicit pastes.'),
      );
    }
  }

  /**
   * Admit only bounded captured text and expose backpressure without echoing it.
   *
   * @param text - Encoded native input.
   */
  private enqueue(text: string): void {
    try {
      this.writes?.append(text);
    } catch {
      this.options.warn(t('Terminal input queue is full. This input was not queued; wait before trying again.'));
    }
  }

  /**
   * Send a literal Tab/Escape on an explicit button, separate from focus capture.
   *
   * @param text - Fixed native control byte.
   */
  private sendExplicit(text: string): void {
    this.ensureQueue();
    this.enqueue(text);
  }

  /** Prepare keyboard-reachable native dimensions and opt-in fit controls. */
  private buildGeometry(): void {
    for (const [field, value, maximum, name] of [
      [this.columns, this.options.screen.grid.columns, LIMIT.columns, t('Terminal columns')],
      [this.rows, this.options.screen.grid.rows, LIMIT.rows, t('Terminal rows')],
    ] as const) {
      field.type = 'number';
      field.min = '1';
      field.max = String(maximum);
      field.value = String(value);
      field.setAttribute('aria-label', name);
    }
    this.fit.type = 'checkbox';
    this.fit.addEventListener('change', () => {
      this.observer.disconnect();
      this.isObserving = false;
      this.update();
      this.scheduleFit();
    });
    this.resizeButton.addEventListener('click', () => {
      void this.resize();
    });
    this.height.setAttribute('aria-label', t('Terminal pane height'));
    for (const value of ['compact', 'standard', 'tall'] as const) {
      const option = element('option', '', t(HEIGHT_LABELS[value]));
      option.value = value;
      this.height.append(option);
    }
    this.height.value = 'standard';
    this.height.addEventListener('change', () => {
      for (const value of ['compact', 'standard', 'tall']) {
        this.options.display.classList.toggle(`terminal-${value}`, this.height.value === value);
      }
    });
    this.options.display.classList.add('terminal-standard');
  }

  /**
   * Compose semantic geometry controls without untrusted markup.
   *
   * @returns Stable native toolbar.
   */
  private geometry(): HTMLElement {
    const toolbar = element('div', 'toolbar terminal-geometry');
    const fit = element('label', '', t('Fit to pane'));
    fit.prepend(this.fit);
    toolbar.append(this.columns, this.rows, this.resizeButton, fit, this.height);
    return toolbar;
  }

  /** Debounce optional native geometry changes; no polling or implicit input. */
  private scheduleFit(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.fit.checked || !this.options.isReady()) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.fit.checked || !this.options.isReady() || this.isResizing) {
        return;
      }
      const style = getComputedStyle(this.options.display);
      const canvas = document.createElement('canvas').getContext('2d');
      if (canvas !== null) {
        // The shorthand can be empty when font-variant-ligatures is non-default.
        canvas.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      }
      const cell = canvas?.measureText('M').width ?? LIMIT.cell;
      const measuredLine = Number(style.lineHeight.replace(/px$/v, ''));
      const line = Number.isFinite(measuredLine) && measuredLine > 0 ? measuredLine : LIMIT.line;
      const horizontalPadding = cssPixels(style.paddingLeft) + cssPixels(style.paddingRight);
      const verticalPadding = cssPixels(style.paddingTop) + cssPixels(style.paddingBottom);
      const columns = Math.floor((this.options.display.clientWidth - horizontalPadding) / cell);
      const rows = Math.floor((this.options.display.clientHeight - verticalPadding) / line);
      this.columns.value = String(Math.max(1, Math.min(LIMIT.columns, columns)));
      this.rows.value = String(Math.max(1, Math.min(LIMIT.rows, rows)));
      void this.resize();
    }, LIMIT.debounce);
  }

  /** Apply only validated explicit geometry; uncertainty disables auto fit. */
  private async resize(): Promise<void> {
    if (!this.options.isReady() || this.isResizing || !this.columns.checkValidity() || !this.rows.checkValidity()) {
      return;
    }
    const columns = this.columns.valueAsNumber;
    const rows = this.rows.valueAsNumber;
    if (!Number.isSafeInteger(columns) || !Number.isSafeInteger(rows)) {
      return;
    }
    if (columns === this.options.screen.grid.columns && rows === this.options.screen.grid.rows) {
      return;
    }
    const { signal } = this.lifetime;
    this.isResizing = true;
    this.update();
    try {
      const session = await this.post('terminal_resize', { columns, rows }, signal);
      if (!signal.aborted && this.options.isReady()) {
        await this.options.resized(session, signal);
      }
    } catch {
      if (!signal.aborted) {
        this.fit.checked = false;
        this.observer.disconnect();
        this.isObserving = false;
        this.options.warn(
          t('Resize was not confirmed. Auto fit is disabled; inspect the native size before retrying.'),
        );
      }
    } finally {
      this.isResizing = false;
      this.update();
      if (this.fit.checked) {
        this.scheduleFit();
      }
    }
  }

  /**
   * Send one bounded authenticated native control with cancellation and no retry.
   *
   * @param operation - Fixed operator-only control.
   * @param input - Bounded numeric geometry or transient text.
   * @param signal - Exact captured view lifetime.
   * @returns Confirmed matching session metadata.
   * @throws {Error} For failed, ambiguous or incorrectly scoped results.
   */
  private async post(
    operation: 'terminal_input' | 'terminal_resize',
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<TerminalView> {
    signal.throwIfAborted();
    const response = await fetch(scoped(this.options.project, '/api/control'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.any([signal, AbortSignal.timeout(LIMIT.deadline)]),
      body: JSON.stringify({ operation, input: { ...input, id: this.options.id } }),
    });
    if (!response.ok) {
      throw new Error('Native terminal control was not confirmed.');
    }
    const session = terminalView(await response.json());
    if (session.id !== this.options.id) {
      throw new Error('Native terminal scope changed.');
    }
    return session;
  }
}
