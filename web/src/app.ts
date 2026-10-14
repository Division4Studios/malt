/**
 * Native TypeScript PWA controller; durable controls are never replayed offline.
 *
 * @file
 */
import {
  LocalRequestError,
  child,
  data,
  records,
  request,
  scoped,
  snapshot,
  text,
  hasFlag,
  resourceSummary,
} from './api.js';
import { skillDialog, maintenanceDialog } from './learning-ui.js';
import { updateNavigation, bindNavigation } from './navigation.js';
import {
  organizationDialog,
  mountConnectionFields,
  resetConnectionFields,
  factoryPolicyDialog,
  githubConnectionDescription,
} from './organization-ui.js';
import { installShellUpdates, startupFailure } from './pwa.js';
import {
  ROLES,
  activityView,
  deliveryView,
  element,
  learningView,
  overviewView,
  roleJob,
  setupView,
  teamView,
  workerView,
} from './views.js';
import { isWorkerArtifact, isInstallEvent } from './worker-ui.js';
import { workflowView } from './workflow-ui.js';

import type { Snapshot, Data } from './api.js';
import type { Actions } from './views.js';
import type { InstallEvent } from './worker-ui.js';

/** View routes remain local UI state, not a competing delivery ledger. */
type View = 'overview' | 'team' | 'workflow' | 'deliveries' | 'workers' | 'activity' | 'learning' | 'setup';
/** Explicit operator mutation presented in the editor dialog. */
interface Edit {
  /** Validated broker operation. */
  readonly operation: string;
  /** Convert user text to the expected control input. */
  readonly input: (body: string) => unknown;
}
/** Simultaneously inspected worker roles. */
const MAX_PANES = 4;
/** Captured output histories retained in memory only. */
const MAX_LOGS = 8;
/** HTTP status requiring a fresh local pairing. */
const UNAUTHORIZED = 401;
/** Clock refresh period. */
const CLOCK_MS = 1000;
/** Stop a failed stream rather than retrying the daemon indefinitely. */
const MAX_RECONNECTS = 5;
/** Bounded visible timeline memory; SQLite retains the complete history. */
const HISTORY_LIMIT = 200;

/**
 * Require an actual typed app-shell node, avoiding unsafe DOM casts.
 *
 * @param id - Fixed shell ID.
 * @param type - Expected DOM constructor.
 * @returns Typed native node.
 * @throws {Error} For an incomplete app shell.
 */
function node<T extends HTMLElement>(id: string, type: new () => T): T {
  const value = document.querySelector(`#${CSS.escape(id)}`);
  if (!(value instanceof type)) {
    throw new TypeError(`Missing app element: ${id}`);
  }
  return value;
}

/**
 * Display an actionable local status without injecting project HTML.
 *
 * @param message - Plain status text.
 * @param isSuccessful - Whether an explicit mutation completed.
 */
function notice(message: string, isSuccessful = false): void {
  const target = node('notice', HTMLDivElement);
  target.hidden = message === '';
  target.textContent = message;
  target.setAttribute('class', isSuccessful ? 'notice success' : 'notice');
}
/** Only public layout choices may persist in browser storage. */
const layoutKey = 'mlt-worker-layout-v1';
/** Bounded read-only stdout cache, never persisted in browser storage. */
const LOG_LIMIT = 20_000;
/** Worker output inspection cadence. */
const LOG_REFRESH_MS = 2000;
/** UI navigation descriptions. */
const HEADINGS: Record<View, readonly [string, string]> = {
  overview: ['Team operations.', 'From intent to verified delivery. Every agent, every handoff, one local team.'],
  workflow: ['Workflow map.', 'Real message traffic. Actual ticket stages. Conditional next handoffs.'],
  team: ['Team constellation.', 'Independent roles. Bounded sessions. Shared project memory.'],
  deliveries: ['Delivery pipeline.', 'Small scopes, independent reviews, verified outcomes.'],
  workers: ['Worker workspaces.', 'Real captured output and durable instructions, side by side.'],
  activity: ['Activity stream.', 'The committed story of your software factory.'],
  learning: ['Learning library.', 'Evidence becomes better skills, checks, and decisions.'],
  setup: ['Project setup.', 'Connect the right repository. Set the gates. Protect local resources.'],
};
/** Application state contains no credential material. */
const state: {
  /** Last observed backend snapshot. */
  current: Snapshot | null;
  /** Selected public project identifier. */
  project: string;
  /** Local navigation route. */
  view: View;
  /** Authenticated observation stream. */
  stream: EventSource | null;
  /** Current explicit operator control. */
  edit: Edit | null;
  /** Browser install capability. */
  installEvent: InstallEvent | null;
  /** Selected logical worker roles. */
  panes: string[];
  /** Preserve native controls and resized panes while semantic state is unchanged. */
  renderKey: string;
  /** Whether authenticated state is currently arriving. */
  isConnected: boolean;
  /** Consecutive native stream errors. */
  reconnects: number;
} = {
  current: null,
  project: 'home',
  view: 'overview',
  stream: null,
  edit: null,
  installEvent: null,
  panes: ['developer-1', 'qa-1'],
  renderKey: '',
  isConnected: false,
  reconnects: 0,
};

/** Read-only log tails for selected panes. */
const logs = new Map<string, string>();
/** Public artifact tab choices; captured contents remain memory-only. */
const files = new Map<string, string>();
/** Durable byte cursor per captured output. */
const cursors = new Map<string, number>();
/** Explicit mutations run one at a time and are never automatically retried. */
const pendingControls = new Set<string>();
/** Prevent overlapping reads from duplicating a captured output chunk. */
const pendingLogs = new Set<string>();
/** Durable event sequence deduplication for the currently selected project. */
const eventHistory = new Map<number, Data>();
/** Scope associated with the bounded in-memory timeline. */
const historyScope = { project: 'home' };

/**
 * Validate native navigation without casts or a nested conditional chain.
 *
 * @param value - Untrusted element dataset.
 * @returns Whether the value names a local view.
 */
const isView = (value: string): value is View => Object.hasOwn(HEADINGS, value);
/** Restore only harmless role layout state, never private project data. */
function restoreLayout(): void {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(layoutKey) ?? 'null');
    restoreRoles(value);
  } catch {
    /* Storage may be unavailable; the default layout remains usable. */
  }
}

/**
 * Validate harmless persisted role selections outside the storage error boundary.
 *
 * @param value - Untrusted browser storage.
 */
function restoreRoles(value: unknown): void {
  if (!Array.isArray(value)) {
    return;
  }
  const names = new Set<string>(ROLES);
  const roles = value.filter((role): role is string => typeof role === 'string' && names.has(role)).slice(0, MAX_PANES);
  state.panes = roles.length > 0 ? roles : state.panes;
}

/**
 * Open a reviewed explicit operator control in a native accessible dialog.
 *
 * @param description - Editor title, explanation and initial input.
 * @param action - Validated operation and input conversion.
 */
function editor(
  description: { title: string; explanation: string; initial: string; evidence?: string },
  action: Edit,
): void {
  if (state.current === null || !navigator.onLine || !state.isConnected) {
    notice('Reconnect to the local console before applying controls.');
    return;
  }
  state.edit = action;
  resetConnectionFields(node('editor-body', HTMLTextAreaElement));
  node('editor-title', HTMLHeadingElement).textContent = description.title;
  node('editor-description', HTMLParagraphElement).textContent = description.explanation;
  const evidence = node('editor-evidence', HTMLPreElement);
  evidence.textContent = description.evidence ?? '';
  evidence.hidden = description.evidence === undefined;
  node('editor-body', HTMLTextAreaElement).value = description.initial;
  node('editor', HTMLDialogElement).showModal();
}

/**
 * Submit one explicit broker operation; errors never trigger automatic mutation retries.
 *
 * @param operation - Allowed control name.
 * @param input - Operator-reviewed input.
 */
async function control(operation: string, input: unknown): Promise<void> {
  if (pendingControls.size > 0 || state.current === null) {
    return;
  }
  pendingControls.add(operation);
  try {
    if (operation === 'open-project' && typeof input === 'string') {
      await openProject(input);
      return;
    }
    await request(scoped(state.project, '/api/control'), { operation, input });
    notice('Saved to project memory. The factory will coordinate the next safe step.', true);
    await refresh();
  } catch (error) {
    notice(error instanceof Error ? error.message : 'The control could not be applied.');
  } finally {
    pendingControls.delete(operation);
  }
}
/** Role and ticket interactions feed the durable server control path. */
const actions: Actions = {
  organization: () => {
    const dialog = organizationDialog(child(state.current?.factory ?? {}, 'settings'));
    editor(dialog.description, dialog.action);
  },
  artifact: (role, file) => {
    if (!isWorkerArtifact(file)) {
      return;
    }
    files.set(role, file);
    render();
    const label = CSS.escape(`${role} artifact`);
    document.querySelector<HTMLSelectElement>(`select[aria-label="${CSS.escape(label)}"]`)?.focus();
    void readLogs();
  },
  skillDecision: (requestId, shouldApprove) => {
    void reviewSkill(requestId, shouldApprove);
  },
  maintenance: (requestId) => {
    const dialog = maintenanceDialog(requestId);
    editor(dialog.description, dialog.action);
  },
  inspect: (role) => {
    state.panes = [role, ...state.panes.filter((item) => item !== role)].slice(0, MAX_PANES);
    try {
      localStorage.setItem(layoutKey, JSON.stringify(state.panes));
    } catch {
      /* Persistence is optional for layout. */
    }
    state.view = 'workers';
    render();
    void readLogs();
  },
  instruct: (role, taskId, shouldReplan) => {
    const requestId = crypto.randomUUID();
    editor(
      {
        title: shouldReplan ? 'Coordinate a scope change' : `Instruct ${role}`,
        explanation: shouldReplan
          ? 'Product owner and team lead will revise the plan. Affected work is paused; existing edits are preserved.'
          : 'Saved durably for this role. A live bounded assignment is interrupted safely; the instruction is included in the next relevant assignment.',
        initial: '',
      },
      {
        operation: 'factory_instruct',
        input: (body) => ({ requestId, role, body, ...(taskId !== '' && { taskId }), replan: shouldReplan }),
      },
    );
  },
  cancel: (jobId) => {
    void control('factory_cancel_job', { jobId });
  },
  retry: (id, isFeature) => {
    void control('factory_retry', isFeature ? { featureId: id } : { taskId: id });
  },
  setup: (isConnection) => {
    if (isConnection) {
      editor(githubConnectionDescription(), { operation: 'github_connect', input: () => ({}) });
      if (node('editor', HTMLDialogElement).open) {
        state.edit = {
          operation: 'github_connect',
          input: mountConnectionFields(
            node('editor-body', HTMLTextAreaElement),
            child(state.current?.github ?? {}, 'connection'),
          ),
        };
      }
      return;
    }
    const dialog = factoryPolicyDialog(child(state.current?.factory ?? {}, 'settings'));
    editor(dialog.description, dialog.action);
  },
};

/**
 * Inspect a scoped immutable comparison before asking for an explicit decision.
 *
 * @param requestId - Reviewed proposal identity.
 * @param shouldApprove - Operator-selected approval or rejection.
 */
async function reviewSkill(requestId: string, shouldApprove: boolean): Promise<void> {
  const projectId = state.project;
  try {
    const response = await request(`${scoped(projectId, '/api/skill')}&requestId=${encodeURIComponent(requestId)}`);
    if (state.project !== projectId) {
      return;
    }
    const dialog = skillDialog(data(response), requestId, shouldApprove);
    editor(dialog.description, dialog.action);
  } catch (error) {
    notice(error instanceof Error ? error.message : 'Could not retrieve the skill proposal.');
  }
}
/** Render the selected native view without touching an open operator editor. */
function render(): void {
  if (state.current === null) {
    return;
  }
  const observed = state.current;
  const resources = document.querySelector('[data-resource-machine]');
  if (resources !== null) {
    resources.textContent = resourceSummary(observed.factory);
  }
  const factory = Object.fromEntries(Object.entries(observed.factory).filter(([key]) => key !== 'resources'));
  const renderKey = JSON.stringify({
    project: observed.project,
    factory,
    view: state.view,
    panes: state.panes,
    files: files.entries().toArray(),
    events: observed.events,
    learning: observed.learning,
    github: observed.github,
  });
  if (renderKey === state.renderKey) {
    return;
  }
  state.renderKey = renderKey;
  const target = node('content', HTMLDivElement);
  node('view-title', HTMLHeadingElement).textContent = HEADINGS[state.view][0];
  node('view-description', HTMLParagraphElement).textContent = HEADINGS[state.view][1];
  updateNavigation(state.view);
  const builders: Record<View, () => HTMLElement> = {
    overview: () => overviewView(observed, actions),
    team: () => teamView(observed, actions),
    workflow: () => workflowView(observed, actions.inspect),
    deliveries: () => deliveryView(observed, actions),
    workers: () => workerView(observed, { roles: state.panes, logs, files, actions }),
    activity: () => activityView(observed),
    learning: () => learningView(observed, actions),
    setup: () => setupView(observed, actions),
  };
  target.replaceChildren(builders[state.view]());
  node('project-path', HTMLSpanElement).textContent = `${text(observed.project, 'root')} / .malt`;
  const run = node('run', HTMLButtonElement);
  run.disabled = !hasFlag(observed.factory, 'configured');
  run.textContent = hasFlag(observed.factory, 'active') ? 'Pause factory' : 'Start factory';
  node('new-objective', HTMLButtonElement).disabled = false;
}

/**
 * Mark actual connection freshness and disable mutations when disconnected.
 *
 * @param isConnected - Whether actual state was received.
 */
function connection(isConnected: boolean): void {
  state.isConnected = isConnected;
  document.body.dataset['connection'] = isConnected ? 'live' : 'stale';
  node('connection-text', HTMLSpanElement).textContent = isConnected
    ? 'LOCAL CONSOLE CONNECTED'
    : 'DISCONNECTED · STATE IS STALE';
  node('connection-dot', HTMLSpanElement).classList.toggle('idle', !isConnected);
  if (isConnected) {
    node('run', HTMLButtonElement).disabled = state.current === null || !hasFlag(state.current.factory, 'configured');
    node('new-objective', HTMLButtonElement).disabled = state.current === null;
    return;
  }

  node('run', HTMLButtonElement).disabled = true;
  node('new-objective', HTMLButtonElement).disabled = true;
}
/** Read one actual snapshot without mutating project state. */
async function refresh(): Promise<void> {
  const projectId = state.project;
  try {
    const response = await request(scoped(projectId, '/api/snapshot'));
    applyObserved(snapshot(response), projectId);
    connection(true);
    render();
  } catch (error) {
    connection(false);
    if (error instanceof LocalRequestError && error.status === UNAUTHORIZED) {
      const dialog = node('pairing', HTMLDialogElement);
      if (!dialog.open) {
        dialog.showModal();
      }
    } else {
      notice(error instanceof Error ? error.message : 'The broker is unavailable.');
    }
  }
}

/**
 * Fence a late observation from a project the operator has left.
 *
 * @param observed - Validated backend state.
 * @param projectId - Scope captured before the asynchronous request.
 * @throws {TypeError} When the observed timeline is invalid.
 */
function applyObserved(observed: Snapshot, projectId: string): void {
  if (state.project !== projectId) {
    return;
  }
  if (historyScope.project !== projectId) {
    eventHistory.clear();
    historyScope.project = projectId;
  }
  for (const event of observed.events) {
    const sequence = event['seq'];
    if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence)) {
      throw new TypeError('Invalid activity sequence.');
    }
    eventHistory.set(sequence, event);
  }
  const events = eventHistory
    .entries()
    .toArray()
    .toSorted(([left], [right]) => left - right)
    .slice(-HISTORY_LIMIT);
  eventHistory.clear();
  for (const [sequence, event] of events) {
    eventHistory.set(sequence, event);
  }
  state.current = { ...observed, events: events.map(([, event]) => event) };
}
/** Attach a bounded native event stream to the current project only. */
function subscribe(): void {
  state.stream?.close();
  state.reconnects = 0;
  const projectId = state.project;
  const stream = new EventSource(scoped(projectId, '/api/stream'));
  state.stream = stream;
  stream.addEventListener('state', (event) => {
    if (
      state.project !== projectId ||
      state.stream !== stream ||
      !(event instanceof MessageEvent) ||
      typeof event.data !== 'string'
    ) {
      return;
    }
    try {
      const value: unknown = JSON.parse(event.data);
      applyObserved(snapshot(value), projectId);
      state.reconnects = 0;
      connection(true);
      render();
    } catch {
      connection(false);
      notice('Invalid live state received. Refresh the local console.');
    }
  });
  stream.addEventListener('disconnected', () => {
    connection(false);
  });
  stream.addEventListener('error', () => {
    connection(false);
    state.reconnects += 1;
    if (state.reconnects < MAX_RECONNECTS) {
      return;
    }

    state.stream?.close();
    notice(
      'The local console is unavailable. Automatic retries have stopped; refresh the page after restarting the daemon.',
    );
  });
}
/** Populate the project switcher with secret-free server-discovered scopes. */
async function projects(): Promise<void> {
  const values = records(await request('/api/projects'));
  const select = node('project', HTMLSelectElement);
  select.replaceChildren();
  for (const value of values) {
    const option = element('option', '', text(value, 'name'));
    option.value = text(value, 'id');
    select.append(option);
  }
  select.value = state.project;
}
/** Inspect captured stdout by bounded byte cursors, retaining only a small tail. */
async function readLogs(): Promise<void> {
  if (state.view !== 'workers' || state.current === null || document.hidden) {
    return;
  }
  const observed = state.current;
  const projectId = state.project;
  const artifacts = state.panes
    .map((role) => ({ id: text(roleJob(observed, role), 'id'), file: files.get(role) ?? 'stdout.log' }))
    .filter((entry) => entry.id !== '');
  await Promise.all(artifacts.map(async (entry) => readLog(projectId, entry)));
  while (logs.size > MAX_LOGS) {
    const first = logs.keys().next().value;
    if (first === undefined) {
      continue;
    }

    logs.delete(first);
    cursors.delete(first);
  }
}

/**
 * Fetch one owned log tail with a single-flight cursor and a project fence.
 *
 * @param projectId - Scope captured before the read.
 * @param entry - Actual owned job identity and allowlisted artifact.
 */
async function readLog(projectId: string, entry: { id: string; file: string }): Promise<void> {
  const artifactKey = `${entry.id}:${entry.file}`;
  const key = `${projectId}:${artifactKey}`;
  if (pendingLogs.has(key)) {
    return;
  }
  pendingLogs.add(key);
  const after = entry.file.endsWith('.log') ? (cursors.get(artifactKey) ?? 0) : 0;
  const route = `${scoped(projectId, '/api/artifact')}&job=${encodeURIComponent(entry.id)}&file=${encodeURIComponent(entry.file)}&after=${String(after)}`;
  try {
    const response = await request(route);
    if (state.project !== projectId) {
      return;
    }
    applyLog(artifactKey, data(response));
  } catch {
    /* A log may not yet exist; the last observed tail remains available. */
  } finally {
    pendingLogs.delete(key);
  }
}

/**
 * Apply actual captured output once, rendering project text through textContent.
 *
 * @param id - Owned job and allowlisted artifact cache key.
 * @param value - Validated log response.
 * @throws {TypeError} When the captured output cursor is invalid.
 */
function applyLog(id: string, value: ReturnType<typeof data>): void {
  const cursor = value['nextCursor'];
  if (typeof cursor !== 'number' || !Number.isSafeInteger(cursor) || cursor < 0) {
    throw new TypeError('Invalid captured output cursor.');
  }
  cursors.set(id, cursor);
  const file = text(value, 'file');
  const prior = file.endsWith('.log') ? (logs.get(id) ?? '') : '';
  const tail = `${prior}${text(value, 'text')}`.slice(-LOG_LIMIT);
  logs.set(id, tail);
  for (const pre of document.querySelectorAll<HTMLPreElement>('pre[data-job]')) {
    if (`${pre.dataset['job'] ?? ''}:${pre.dataset['file'] ?? ''}` === id) {
      pre.textContent = tail === '' ? 'This artifact has not emitted data yet.' : tail;
    }
  }
}
/** Queue an explicit product objective for owner/lead refinement. */
function objective(): void {
  const requestId = crypto.randomUUID();
  editor(
    {
      title: 'Define the next mission',
      explanation:
        'Describe the outcome and boundaries. Your product owner and team lead will turn it into small, reviewable GitHub deliveries.',
      initial: '',
    },
    { operation: 'factory_request', input: (body) => ({ objective: body, requestId }) },
  );
}
/** Wire semantic native controls once, then observe the real local service. */
async function start(): Promise<void> {
  restoreLayout();
  bindNavigation((selected) => {
    if (!isView(selected)) {
      return;
    }
    state.view = selected;
    render();
    void readLogs();
  });
  node('new-objective', HTMLButtonElement).addEventListener('click', objective);
  node('run', HTMLButtonElement).addEventListener('click', () => {
    void control(hasFlag(state.current?.factory ?? {}, 'active') ? 'factory_pause' : 'factory_start', {});
  });
  node('editor-cancel', HTMLButtonElement).addEventListener('click', () => {
    node('editor', HTMLDialogElement).close();
  });
  node('editor-form', HTMLFormElement).addEventListener('submit', (event) => {
    event.preventDefault();
    if (state.edit === null) {
      return;
    }
    try {
      const input = state.edit.input(node('editor-body', HTMLTextAreaElement).value);
      const { operation } = state.edit;
      node('editor', HTMLDialogElement).close();
      void control(operation, input);
    } catch (error) {
      notice(error instanceof Error ? error.message : 'Invalid control input.');
    }
  });
  node('project', HTMLSelectElement).addEventListener('change', () => {
    state.project = node('project', HTMLSelectElement).value;
    state.current = null;
    logs.clear();
    cursors.clear();
    void refresh();
    subscribe();
  });
  node('open-project', HTMLButtonElement).addEventListener('click', () => {
    editor(
      {
        title: 'Open a project',
        explanation: 'Enter the absolute repository folder. Its operational memory stays in its own .malt directory.',
        initial: '',
      },
      { operation: 'open-project', input: (body) => body.trim() },
    );
  });
  node('pair-form', HTMLFormElement).addEventListener('submit', (event) => {
    event.preventDefault();
    void pair();
  });
  node('signout', HTMLButtonElement).addEventListener('click', () => {
    void signout();
  });
  addEventListener('offline', () => {
    state.stream?.close();
    connection(false);
    notice('Offline. Controls are not queued or replayed. Reconnect to the local service.');
  });
  addEventListener('online', () => {
    void refresh();
    subscribe();
  });
  addEventListener('beforeinstallprompt', (event) => {
    if (!isInstallEvent(event)) {
      return;
    }

    event.preventDefault();
    state.installEvent = event;
    node('install', HTMLButtonElement).hidden = false;
  });
  node('install', HTMLButtonElement).addEventListener('click', () => {
    void state.installEvent?.prompt();
  });
  window.addEventListener('pagehide', () => {
    state.stream?.close();
  });
  setInterval(() => {
    const now = new Date();
    node('clock', HTMLSpanElement).textContent = now.toLocaleTimeString();
  }, CLOCK_MS);
  setInterval(() => {
    void readLogs();
  }, LOG_REFRESH_MS);
  await installShellUpdates(node('update-shell', HTMLButtonElement), notice);
  try {
    await projects();
    await refresh();
    subscribe();
  } catch (error) {
    connection(false);
    startupFailure(error, notice, subscribe);
  }
}
/** Pair explicitly with the owning console, keeping the secret out of browser storage. */
async function pair(): Promise<void> {
  try {
    await request('/api/pair', { code: node('pair-code', HTMLInputElement).value });
    node('pair-code', HTMLInputElement).value = '';
    node('pairing', HTMLDialogElement).close();
    await projects();
    await refresh();
    subscribe();
  } catch (error) {
    node('pair-error', HTMLParagraphElement).textContent = error instanceof Error ? error.message : 'Pairing failed.';
  }
}

/**
 * Open a target repository explicitly and switch only after broker confirmation.
 *
 * @param workspace - User-selected absolute path.
 */
async function openProject(workspace: string): Promise<void> {
  try {
    const value = data(await request('/api/projects', { workspace }));
    state.project = text(value, 'id');
    await projects();
    await refresh();
    subscribe();
  } catch (error) {
    notice(error instanceof Error ? error.message : 'Project could not be opened.');
  }
}
/** Revoke browser access without stopping the independently running factory. */
async function signout(): Promise<void> {
  await request('/api/logout', {});
  state.stream?.close();
  state.current = null;
  logs.clear();
  cursors.clear();
  connection(false);
  node('pairing', HTMLDialogElement).showModal();
}

await start();
