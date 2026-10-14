/**
 * Full-screen operator console with durable targeted instructions.
 *
 * @file
 */
import { emitKeypressEvents } from 'node:readline';

import { rpc } from './client.ts';
import { TABS, dashboardSchema, renderDashboard, viewRows } from './dashboard-view.ts';
import { FACTORY_ROLES } from './factory/schema.ts';

import type { MeshConfig } from './config.ts';
import type { DashboardState } from './dashboard-view.ts';
import type { Key } from 'node:readline';

/** Unpaid read-only display refresh interval. */
const REFRESH_MS = 1500;
/** Bounded instruction entry length. */
const INPUT_MAX = 4000;
/** Terminal pane selection and input state. */
interface ConsoleState {
  /** Latest validated wire state. */
  snapshot: DashboardState | null;
  /** Active tab. */
  tab: number;
  /** Selected record. */
  row: number;
  /** Detail offset. */
  scroll: number;
  /** Operator notices. */
  notice: string;
  /** Current entry mode. */
  mode: 'instruction' | 'scope' | 'objective' | null;
  /** Entered text. */
  input: string;
}
/** Human-controlled fullscreen console; terminal state is always restored. */
class Dashboard {
  /** Addressed target workspace. */
  private readonly config: MeshConfig;
  /** Current interactive view. */
  private readonly state: ConsoleState = {
    snapshot: null,
    tab: 0,
    row: 0,
    scroll: 0,
    notice: '',
    mode: null,
    input: '',
  };
  /** Prevent concurrent requests and duplicate key submissions. */
  private busy = false;
  /** Shutdown state. */
  private closed = false;
  /** Console exit promise. */
  private readonly exit = Promise.withResolvers<undefined>();

  /**
   * Construct a console without touching the terminal.
   *
   * @param config - Authenticated target workspace.
   */
  public constructor(config: MeshConfig) {
    this.config = config;
  }

  /** Run until q/Ctrl+C and restore the terminal even after failure. */
  public async run(): Promise<void> {
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdout.write('\u{1B}[?1049h\u{1B}[?25l');
    process.stdin.on('keypress', this.keypress);
    const resize = (): void => {
      this.draw();
    };
    const stop = (): void => {
      this.exit.resolve(undefined);
    };
    process.stdout.on('resize', resize);
    process.once('SIGTERM', stop);
    const timer = setInterval(() => {
      void this.refresh();
    }, REFRESH_MS);
    try {
      await this.refresh();
      await this.exit.promise;
    } finally {
      this.closed = true;
      clearInterval(timer);
      process.stdin.removeListener('keypress', this.keypress);
      process.stdout.removeListener('resize', resize);
      process.removeListener('SIGTERM', stop);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\u{1B}[?25h\u{1B}[?1049l');
    }
  }

  /**
   * Keyboard navigation and actions.
   *
   * @param text - Printable text.
   * @param key - Terminal key event.
   */
  private readonly keypress = (text: string, key: Key): void => {
    if (key.ctrl === true && key.name === 'c') {
      this.exit.resolve(undefined);
      return;
    }
    if (this.state.mode !== null) {
      this.inputKey(text, key);
      return;
    }
    if (key.name === 'q') {
      this.exit.resolve(undefined);
      return;
    }
    if (this.hasActionKey(key.name)) {
      this.draw();
      return;
    }
    this.navigate(text, key.name);
    this.draw();
  };

  /**
   * Move selection without issuing an operator mutation.
   *
   * @param text - Printable numeric shortcut.
   * @param name - Native navigation key.
   */
  private navigate(text: string, name: string | undefined): void {
    const count = this.state.snapshot === null ? 0 : viewRows(this.state.snapshot, this.state).rows.length;
    switch (name) {
      case 'tab': {
        this.state.tab = (this.state.tab + 1) % TABS.length;
        this.state.row = 0;
        this.state.scroll = 0;
        break;
      }
      case 'up':
      case 'k': {
        this.state.row = Math.max(0, this.state.row - 1);
        this.state.scroll = 0;
        break;
      }
      case 'down':
      case 'j': {
        this.state.row = Math.min(Math.max(0, count - 1), this.state.row + 1);
        this.state.scroll = 0;
        break;
      }
      case 'left': {
        this.state.scroll = Math.max(0, this.state.scroll - 1);
        break;
      }
      case 'right': {
        this.state.scroll += 1;
        break;
      }
      case undefined:
      default: {
        const tab = Number(text) - 1;
        if (Number.isSafeInteger(tab) && tab >= 0 && tab < TABS.length) {
          this.state.tab = tab;
          this.state.row = 0;
          this.state.scroll = 0;
        }
      }
    }
  }

  /** Render only validated real state; no inference for display refresh. */
  private draw(): void {
    if (this.closed) {
      return;
    }
    const { snapshot } = this.state;
    if (snapshot === null) {
      process.stdout.write(`\u{1B}[H\u{1B}[2JConnecting to ${this.config.name}…`);
      return;
    }
    const notice =
      this.state.mode === null
        ? this.state.notice
        : `${this.state.mode}: ${this.state.input}▏  [Enter sends · Esc cancels]`;
    process.stdout.write(
      `\u{1B}[2J${renderDashboard(snapshot, this.state, { width: process.stdout.columns, height: process.stdout.rows }, notice)}`,
    );
  }

  /** Poll live ledger once; preserve selected role or record between refreshes. */
  private async refresh(): Promise<void> {
    if (this.busy || this.closed) {
      return;
    }
    this.busy = true;
    try {
      this.state.snapshot = dashboardSchema.parse(await rpc(this.config, 'factory_status', {}));
      const count = viewRows(this.state.snapshot, this.state).rows.length;
      this.state.row = Math.min(this.state.row, Math.max(0, count - 1));
    } catch (error) {
      this.state.notice = Error.isError(error) ? error.message : 'Broker unavailable; reconnecting.';
    } finally {
      this.busy = false;
      this.draw();
    }
  }

  /**
   * Find the selected durable delivery or role.
   *
   * @returns Selected role and optional delivery identity.
   */
  private target(): { role: (typeof FACTORY_ROLES)[number]; taskId?: string } {
    const { snapshot } = this.state;
    if (TABS[this.state.tab] === 'Deliveries') {
      const task = snapshot?.tasks.toSorted((a, b) => Number(a.phase === 'done') - Number(b.phase === 'done'))[
        this.state.row
      ];
      return task === undefined ? { role: 'team-lead' } : { role: task.developer ?? 'team-lead', taskId: task.id };
    }
    return { role: TABS[this.state.tab] === 'Team' ? (FACTORY_ROLES[this.state.row] ?? 'team-lead') : 'team-lead' };
  }

  /** Send operator text durably, with coordinated replanning for scope changes. */
  private async submit(): Promise<void> {
    const { mode, input } = this.state;
    if (mode === null || this.busy || input.trim() === '') {
      return;
    }
    this.busy = true;
    try {
      const response = await this.submitRequest(mode, input);
      this.state.mode = null;
      this.state.input = '';
      this.state.notice = `Saved in .malt: ${JSON.stringify(response)}. Team notified.`;
    } catch (error) {
      this.state.notice = Error.isError(error) ? error.message : 'Instruction could not be saved.';
      this.state.mode = null;
    } finally {
      this.busy = false;
      await this.refresh();
    }
  }

  /**
   * Route one completed text entry through the durable broker boundary.
   *
   * @param mode - Selected operator entry mode.
   * @param input - Untrusted operator text, validated by the broker.
   * @returns Committed operation receipt.
   */
  private async submitRequest(mode: NonNullable<ConsoleState['mode']>, input: string): Promise<unknown> {
    return mode === 'objective'
      ? rpc(this.config, 'factory_request', { objective: input })
      : rpc(this.config, 'factory_instruct', { ...this.target(), body: input, replan: mode === 'scope' });
  }

  /**
   * Handle action shortcuts separately from pane navigation.
   *
   * @param name - Optional native key name.
   * @returns Whether the action consumed the key.
   */
  private hasActionKey(name: string | undefined): boolean {
    switch (name) {
      case 'i': {
        this.state.mode = 'instruction';
        return true;
      }
      case 'c': {
        this.state.mode = 'scope';
        return true;
      }
      case 'n': {
        this.state.mode = 'objective';
        return true;
      }
      case 'space': {
        void this.control('toggle');
        return true;
      }
      case 'x': {
        void this.control('cancel');
        return true;
      }
      case undefined:
      default: {
        return false;
      }
    }
  }

  /**
   * Execute a key-triggered control once, then refresh actual ledger state.
   *
   * @param operation - Pause/start or explicit cancellation.
   */
  private async control(operation: 'toggle' | 'cancel'): Promise<void> {
    const { snapshot } = this.state;
    if (snapshot === null || this.busy) {
      return;
    }
    this.busy = true;
    try {
      await this.performControl(operation, snapshot);
    } catch (error) {
      this.state.notice = Error.isError(error) ? error.message : 'Control failed.';
    } finally {
      this.busy = false;
      await this.refresh();
    }
  }

  /**
   * Apply one explicit action against the observed durable selection.
   *
   * @param operation - Pause/start or owned job cancellation.
   * @param snapshot - Validated observed state.
   */
  private async performControl(operation: 'toggle' | 'cancel', snapshot: DashboardState): Promise<void> {
    if (operation === 'toggle') {
      await rpc(this.config, snapshot.active ? 'factory_pause' : 'factory_start', {});
    } else {
      const target = this.target();
      const job = snapshot.jobs.find((candidate) => {
        return (
          candidate.state === 'running' &&
          candidate.role === target.role &&
          (target.taskId === undefined || candidate.taskId === target.taskId)
        );
      });
      if (job !== undefined) {
        await rpc(this.config, 'factory_cancel_job', { jobId: job.id });
      }
    }
  }

  /**
   * Edit a pending instruction locally; no request until Enter.
   *
   * @param text - Printable key text.
   * @param key - Parsed terminal key.
   */
  private inputKey(text: string, key: Key): void {
    const record = key;
    switch (record.name) {
      case 'escape': {
        this.state.mode = null;
        this.state.input = '';
        break;
      }
      case 'return': {
        void this.submit();
        break;
      }
      case 'backspace': {
        this.state.input = this.state.input.slice(0, -1);
        break;
      }
      case undefined:
      default: {
        if (record.ctrl !== true && record.meta !== true && text.length > 0 && !text.startsWith('\u{1B}')) {
          this.state.input = (this.state.input + text).slice(0, INPUT_MAX);
        }
      }
    }
    this.draw();
  }
}

/**
 * Open the full-screen console, or fail clearly when no interactive terminal exists.
 *
 * @param config - Addressed target project.
 */
export async function runDashboard(config: MeshConfig): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('The dashboard needs an interactive terminal. Use factory-status for JSON output.');
  }
  const dashboard = new Dashboard(config);
  await dashboard.run();
}
