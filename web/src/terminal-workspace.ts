/** @file Stable operator terminal workspace, separate from snapshot-rendered worker logs. */
import { request, scoped } from './api.ts';
import { terminalView, terminalViews } from './terminal-contract.ts';
import { TerminalPane } from './terminal-pane.ts';
import { element } from './worker-ui.ts';

import type { TerminalView } from './terminal-contract.ts';

/** Native service admission remains authoritative; the view also bounds rendering. */
const MAX_PANES = 2;
/** Bounded metadata history supplied by the gateway. */
const MAX_SESSIONS = 100;
/** Fixed initial terminal geometry, subsequently adjustable through native controls. */
const INITIAL = { columns: 80, rows: 24 } as const;
/** Public short identity labels. */
const LABEL_LENGTH = 8;

/** Stable DOM survives unrelated snapshots and never launches a process implicitly. */
export class TerminalWorkspace {
  /** Permanent shell mount. */
  private readonly root: HTMLElement;
  /** Operator selection callback; snapshots do not recreate terminal views. */
  private readonly changed: () => void;
  /** Explicit native mode buttons precede either logs or terminal panes. */
  private readonly logs = element('button', 'button secondary', 'Worker logs & handoffs');
  /** Terminal mode has separate execution authority and lifecycle. */
  private readonly terminals = element('button', 'button secondary', 'Scratch terminals');
  /** Fixed provider choices, never executable names or shell arguments. */
  private readonly provider = element('select');
  /** Explicit operator launch. */
  private readonly startButton = element('button', 'button primary', 'Start scratch terminal');
  /** Read-only metadata reconciliation. */
  private readonly refreshButton = element('button', 'button secondary', 'Refresh sessions');
  /** Existing metadata is never reconstructed from simulated worker activity. */
  private readonly sessions = element('select');
  /** Explicitly inspect an existing session without restarting it. */
  private readonly inspectButton = element('button', 'button secondary', 'Open session output');
  /** Native terminal subview. */
  private readonly body = element('section', 'terminal-workspace');
  /** Stable pane mount outside dashboard replacement. */
  private readonly mount = element('div', 'terminal-panes');
  /** Non-transcript status and useful failure messages. */
  private readonly status = element('p', 'notice');
  /** Bounded transient native views. */
  private readonly panes = new Map<string, TerminalPane>();
  /** Validated current project metadata. */
  private metadata: readonly TerminalView[] = [];
  /** Actual selected project; no bearer credentials are stored here. */
  private project = '';
  /** Visibility is distinct from native session lifetime. */
  private isVisible = false;
  /** Connection/project freshness gate for explicit controls. */
  private isReady = false;
  /** Explicit view selection; default never starts a process. */
  private isSelected = false;
  /** Bound launch attempts even across a project switch. */
  private isStarting = false;
  /** Fence late list responses and avoid duplicate requests. */
  private listing: object | null = null;
  /** Invalidate late completion callbacks when project scope changes. */
  private generation = 0;

  /**
   * Mount native navigation once, without fetching or starting any provider.
   *
   * @param root - Permanent shell mount outside dashboard replacement.
   * @param changed - Refresh the surrounding log view after explicit selection.
   */
  public constructor(root: HTMLElement, changed: () => void) {
    this.root = root;
    this.changed = changed;
    const navigation = element('nav', 'toolbar terminal-navigation');
    navigation.setAttribute('aria-label', 'Worker workspace mode');
    for (const button of [this.logs, this.terminals, this.startButton, this.refreshButton, this.inspectButton]) {
      button.type = 'button';
    }
    navigation.append(this.logs, this.terminals);
    this.logs.addEventListener('click', () => {
      this.select(false);
    });
    this.terminals.addEventListener('click', () => {
      this.select(true);
    });
    for (const name of ['codex', 'claude']) {
      const option = element('option', '', name.toUpperCase());
      option.value = name;
      this.provider.append(option);
    }
    this.provider.setAttribute('aria-label', 'Scratch terminal provider');
    this.sessions.setAttribute('aria-label', 'Existing scratch terminal session');
    const controls = element('div', 'toolbar');
    controls.append(this.provider, this.startButton, this.refreshButton, this.sessions, this.inspectButton);
    this.startButton.addEventListener('click', () => {
      void this.startSession();
    });
    this.refreshButton.addEventListener('click', () => {
      void this.refreshSessions();
    });
    this.inspectButton.addEventListener('click', () => {
      const session = this.metadata.find((entry) => entry.id === this.sessions.value);
      if (session !== undefined) {
        this.open(session);
      }
    });
    this.body.append(
      element('h2', '', 'Operator scratch terminals'),
      element(
        'p',
        'subtle',
        'Real native CLI sessions in separate scratch worktrees. These are distinct from managed worker logs, durable conversations, instructions, and delivery evidence. Hidden views stop reading; native sessions retain backend idle and lifetime limits.',
      ),
      controls,
      this.status,
      this.mount,
    );
    root.append(navigation, this.body);
    this.update();
  }

  /**
   * Whether the normal log view should yield to the stable terminal mount.
   *
   * @returns Explicit operator mode.
   */
  public get selected(): boolean {
    return this.isSelected;
  }

  /**
   * Reconcile actual project/visibility/connectivity without recreating native DOM.
   *
   * @param project - Current operator project scope.
   * @param isVisible - Whether Workers is selected with an actual snapshot.
   * @param isReady - Authenticated fresh local connectivity.
   */
  public sync(project: string, isVisible: boolean, isReady: boolean): void {
    if (project !== this.project) {
      this.generation += 1;
      for (const pane of this.panes.values()) {
        pane.dispose();
      }
      this.panes.clear();
      this.metadata = [];
      this.listing = null;
      this.sessions.replaceChildren();
      this.status.textContent = '';
      this.project = project;
      this.isVisible = false;
    }
    const wasReading = this.isVisible && this.isReady && this.isSelected;
    this.isVisible = isVisible;
    this.isReady = isReady;
    const shouldRead = isVisible && isReady && this.isSelected;
    if (wasReading !== shouldRead) {
      for (const pane of this.panes.values()) {
        if (shouldRead) {
          pane.resume();
        } else {
          pane.suspend();
        }
      }
      if (shouldRead) {
        void this.refreshSessions();
      }
    }
    this.update();
  }

  /** Suspend reads when this document leaves; never replay controls on restoration. */
  public suspend(): void {
    this.isReady = false;
    for (const pane of this.panes.values()) {
      pane.suspend();
    }
    this.update();
  }

  /**
   * Switch mode explicitly without creating a native session.
   *
   * @param isSelected - Requested terminal mode.
   */
  private select(isSelected: boolean): void {
    if (this.isSelected === isSelected) {
      return;
    }
    this.isSelected = isSelected;
    for (const pane of this.panes.values()) {
      if (isSelected && this.isReady) {
        pane.resume();
      } else {
        pane.suspend();
      }
    }
    this.update();
    this.changed();
    if (isSelected) {
      void this.refreshSessions();
    }
  }

  /** Refresh focus-preserving controls from current local observations. */
  private update(): void {
    this.root.hidden = !this.isVisible;
    this.body.hidden = !this.isSelected;
    this.logs.setAttribute('aria-pressed', String(!this.isSelected));
    this.terminals.setAttribute('aria-pressed', String(this.isSelected));
    this.startButton.disabled = !this.isReady || this.isStarting || this.panes.size >= MAX_PANES;
    this.refreshButton.disabled = !this.isReady || this.listing !== null;
    this.inspectButton.disabled = !this.isReady || this.metadata.length === 0;
    for (const pane of this.panes.values()) {
      pane.updateControls();
    }
  }

  /** Fetch bounded scoped metadata only; this operation never starts an agent. */
  private async refreshSessions(): Promise<void> {
    if (!this.isReady || this.listing !== null) {
      return;
    }
    const identity = {};
    this.listing = identity;
    const { generation } = this;
    const { project } = this;
    this.update();
    try {
      const response = await request(scoped(project, '/api/terminals'));
      if (!this.ownsScope(generation)) {
        return;
      }
      this.metadata = terminalViews(response);
      this.renderSessions();
    } catch {
      if (this.ownsScope(generation)) {
        this.status.textContent = 'Session refresh failed. Reconnect to the local console; no start request was sent.';
      }
    } finally {
      if (this.listing === identity) {
        this.listing = null;
        this.update();
      }
    }
  }

  /** Replace bounded session options, retaining the operator's selection. */
  private renderSessions(): void {
    const selected = this.sessions.value;
    this.sessions.replaceChildren();
    for (const session of this.metadata) {
      const option = element(
        'option',
        '',
        `${session.provider} / ${session.id.slice(0, LABEL_LENGTH)} / ${session.state}`,
      );
      option.value = session.id;
      this.sessions.append(option);
    }
    if (this.metadata.some((session) => session.id === selected)) {
      this.sessions.value = selected;
    }
  }

  /** Start exactly once on explicit operator input; ambiguous writes are not retried. */
  private async startSession(): Promise<void> {
    if (!this.isReady || this.isStarting || this.panes.size >= MAX_PANES) {
      return;
    }
    const provider = this.provider.value;
    if (provider !== 'codex' && provider !== 'claude') {
      return;
    }
    const { generation } = this;
    const { project } = this;
    this.isStarting = true;
    this.status.textContent = 'Starting an owned scratch terminal…';
    this.update();
    try {
      const session = terminalView(
        await request(scoped(project, '/api/control'), {
          operation: 'terminal_start',
          input: { provider, ...INITIAL },
        }),
      );
      if (!this.ownsScope(generation)) {
        return;
      }
      this.metadata = [session, ...this.metadata.filter((entry) => entry.id !== session.id)].slice(0, MAX_SESSIONS);
      this.renderSessions();
      this.status.textContent = `Session ${session.state}${session.reason === '' ? '' : ': '}${session.reason}`;
      this.open(session);
    } catch (error) {
      if (this.ownsScope(generation)) {
        this.status.textContent = `${error instanceof Error ? error.message : 'Start was not confirmed.'} Refresh sessions before retrying; requests are never replayed automatically.`;
      }
    } finally {
      this.isStarting = false;
      this.update();
    }
  }

  /**
   * Mount actual existing session output without changing its process state.
   *
   * @param session - Validated current-project metadata.
   */
  private open(session: TerminalView): void {
    if (this.panes.has(session.id)) {
      return;
    }
    if (this.panes.size >= MAX_PANES) {
      this.status.textContent = 'Two panes are open. Close and remove a settled pane before opening another.';
      return;
    }
    const { project } = this;
    const { generation } = this;
    const pane = new TerminalPane({
      project,
      session,
      isReady: () => this.ownsScope(generation) && this.isReady && this.isVisible && this.isSelected,
      remove: () => {
        if (!this.ownsScope(generation)) {
          return;
        }

        this.panes.delete(session.id);
        this.update();
      },
      changed: (updated) => {
        if (!this.ownsScope(generation)) {
          return;
        }
        this.metadata = this.metadata.map((entry) => (entry.id === updated.id ? updated : entry));
      },
    });
    this.panes.set(session.id, pane);
    this.mount.append(pane.root);
    if (this.isReady && this.isVisible && this.isSelected) {
      pane.resume();
    }
    this.update();
  }

  /**
   * Read the live generation after awaits; a captured value cannot authorize late work.
   *
   * @param generation - Scope frozen before the asynchronous operation.
   * @returns Whether the same selected project still owns the view.
   */
  private ownsScope(generation: number): boolean {
    return generation === this.generation;
  }
}
