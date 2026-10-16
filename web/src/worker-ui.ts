/**
 * Native controls for selecting real worker output and validation artifacts.
 *
 * @file
 */

import { records, text } from './api.js';

import type { Data, Snapshot } from './api.js';

/**
 * Require an actual typed shell node without accepting unsafe DOM casts.
 *
 * @param id - Fixed public shell ID.
 * @param type - Required native DOM constructor.
 * @returns Typed shell element.
 * @throws {TypeError} If the expected app shell is incomplete.
 */
export function shellNode<T extends HTMLElement>(id: string, type: new () => T): T {
  const value = document.querySelector(`#${CSS.escape(id)}`);
  if (!(value instanceof type)) {
    throw new TypeError(`Missing app element: ${id}`);
  }
  return value;
}

/**
 * Display a plain-text console outcome without injecting project HTML.
 *
 * @param message - Safe display text.
 * @param isSuccessful - Whether an explicit operation was confirmed.
 */
export function consoleNotice(message: string, isSuccessful = false): void {
  const target = shellNode('notice', HTMLDivElement);
  target.hidden = message === '';
  target.textContent = message;
  target.setAttribute('class', isSuccessful ? 'notice success' : 'notice');
}

/**
 * Restore only bounded public role choices, preserving the default if storage fails.
 *
 * @param key - Current app layout key.
 * @param allowed - Known logical role vocabulary.
 * @param fallback - Harmless default selection.
 * @param maximum - Maximum simultaneous log panes.
 * @returns Validated role choices without private contents.
 */
export function restoreRoleLayout(
  key: string,
  allowed: readonly string[],
  fallback: string[],
  maximum: number,
): string[] {
  try {
    const saved = localStorage.getItem(key) ?? localStorage.getItem('mlt-worker-layout-v1');
    const value: unknown = JSON.parse(saved ?? 'null');
    return restoredRoles(value, allowed, fallback, maximum);
  } catch {
    return fallback;
  }
}

/**
 * Validate public persisted layout without accepting arbitrary worker names.
 *
 * @param value - Untrusted local layout value.
 * @param allowed - Known logical roles.
 * @param fallback - Existing harmless selection.
 * @param maximum - Pane ceiling.
 * @returns Bounded known role names or the retained selection.
 */
export function restoredRoles(
  value: unknown,
  allowed: readonly string[],
  fallback: string[],
  maximum: number,
): string[] {
  if (!Array.isArray(value)) {
    return fallback;
  }
  const names = new Set(allowed);
  const roles = value.filter((role): role is string => typeof role === 'string' && names.has(role)).slice(0, maximum);
  return roles.length > 0 ? roles : fallback;
}

/** Optional browser-native PWA install capability. */
export interface InstallEvent extends Event {
  /** Launch the browser's supported installation prompt. */
  readonly prompt: () => Promise<void>;
}

/**
 * Validate a native installation capability without assuming every browser supports it.
 *
 * @param event - Browser installation event.
 * @returns Whether its prompt is actually callable.
 */
export function isInstallEvent(event: Event): event is InstallEvent {
  return 'prompt' in event && typeof event.prompt === 'function';
}

/**
 * Create one safe DOM element with plain text.
 *
 * @param tag - Native HTML tag.
 * @param cssClass - Trusted class list.
 * @param value - Untrusted project text.
 * @returns Typed DOM element.
 */
export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cssClass = '',
  value = '',
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.setAttribute('class', cssClass);
  node.textContent = value;
  return node;
}

/** Bound guidance previews; full text remains in durable assignments. */
const INSTRUCTION_EXCERPT = 380;
/** Relevant recent receipts rendered per worker pane. */
const VISIBLE_INSTRUCTIONS = 5;

/** Fixed public selectors, matching the backend's validated artifact boundary. */
const WORKER_FILES = [
  'stdout.log',
  'stderr.log',
  'completion.json',
  'assignment.json',
  'prompt.md',
  'prepare-evidence.json',
  'test-evidence.json',
  'end-to-end-evidence.json',
] as const;
/** A set accepts untrusted select values without an unsafe union assertion. */
const allowedFiles = new Set<string>(WORKER_FILES);

/** Layout preferences contain only logical role names and pixel heights. */
const HEIGHT_KEY = 'malt-worker-heights-v1';
/** Keep height controls usable on compact displays. */
const MIN_HEIGHT = 340;
/** Bound accidental giant panes and browser storage. */
const MAX_HEIGHT = 1600;
/** Initial pane size, independent of private captured output. */
const DEFAULT_HEIGHT = 600;
/** Native keyboard height increments. */
const HEIGHT_STEP = 20;
/** The factory has eight logical roles; stored layout is bounded to that count. */
const MAX_ROLES = 8;
/** Maximum serialized public layout bytes. */
const LAYOUT_MAX = 2048;
/** Only the currently rendered panes are observed. */
const paneLayout = { heights: new Map<string, number>(), isRestored: false };
/** Unread markers are ephemeral operator view state, isolated to the current project. */
const handoffs = { project: '', seen: new Map<string, ReadonlySet<string>>() };

/**
 * Show completed handoffs not yet opened in this browser session.
 *
 * @param state - Actual bounded job history from the backend.
 * @param role - Logical worker whose output may be inspected.
 * @param shouldRead - Mark this role's observed handoffs read when its pane opens.
 * @returns Plain-text unread badge, absent when nothing is unseen.
 */
export function handoffBadge(state: Snapshot, role: string, shouldRead = false): HTMLElement | null {
  const project = text(state.project, 'id');
  if (handoffs.project !== project) {
    handoffs.project = project;
    handoffs.seen.clear();
  }
  const completed = records(state.factory['jobs']).filter(
    (job) => text(job, 'role') === role && text(job, 'state') !== 'running',
  );
  const seen = handoffs.seen.get(role);
  const unread = completed.filter((job) => seen?.has(text(job, 'id')) !== true).length;
  if (shouldRead) {
    handoffs.seen.set(role, new Set(completed.map((job) => text(job, 'id'))));
    return null;
  }
  return unread === 0 ? null : element('span', 'pill', `${String(unread)} unread handoffs`);
}

/**
 * Attach a genuine unread handoff count to a logical role card.
 *
 * @param node - Current role card.
 * @param state - Actual project job history.
 * @param role - Logical role identity.
 */
export function appendHandoffBadge(node: HTMLElement, state: Snapshot, role: string): void {
  const badge = handoffBadge(state, role);
  if (badge !== null) {
    node.append(badge);
  }
}
/** ResizeObserver tracks genuine native CSS handle changes without a polling timer. */
const paneObserver =
  typeof ResizeObserver === 'undefined'
    ? null
    : new ResizeObserver((entries) => {
        for (const entry of entries) {
          if (!(entry.target instanceof HTMLElement)) {
            continue;
          }
          const role = entry.target.dataset['workerRole'];
          if (role !== undefined) {
            saveHeight(role, Math.round(entry.target.getBoundingClientRect().height));
          }
        }
      });

/**
 * Persist only bounded public layout, never messages, credentials or job contents.
 *
 * @param role - Logical role selected by the controller.
 * @param height - Actual native pane height.
 */
function saveHeight(role: string, height: number): void {
  if (!Number.isSafeInteger(height) || height < MIN_HEIGHT || height > MAX_HEIGHT) {
    return;
  }
  paneLayout.heights.set(role, height);
  while (paneLayout.heights.size > MAX_ROLES) {
    const first = paneLayout.heights.keys().next().value;
    if (first === undefined) {
      break;
    }
    paneLayout.heights.delete(first);
  }
  try {
    localStorage.setItem(HEIGHT_KEY, JSON.stringify(Object.fromEntries(paneLayout.heights)));
  } catch {
    /* Native resizing works even when browser storage is disabled. */
  }
}

/** Disconnect retired DOM nodes and restore harmless layout once per page. */
export function beginWorkerLayout(): void {
  paneObserver?.disconnect();
  if (paneLayout.isRestored) {
    return;
  }
  paneLayout.isRestored = true;
  try {
    restoreHeights(localStorage.getItem(HEIGHT_KEY) ?? localStorage.getItem('mlt-worker-heights-v1') ?? '{}');
  } catch {
    /* Invalid or unavailable storage retains the default layout. */
  }
}

/**
 * Validate bounded public pixel heights without accepting arbitrary CSS values.
 *
 * @param saved - Untrusted browser layout JSON.
 */
function restoreHeights(saved: string): void {
  if (saved.length > LAYOUT_MAX) {
    return;
  }
  const parsed: unknown = JSON.parse(saved);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return;
  }
  for (const [role, height] of Object.entries(parsed).slice(0, MAX_ROLES)) {
    if (typeof height === 'number' && Number.isSafeInteger(height) && height >= MIN_HEIGHT && height <= MAX_HEIGHT) {
      paneLayout.heights.set(role, height);
    }
  }
}

/**
 * Attach mouse and keyboard resizing to one actual worker pane.
 *
 * @param pane - Native owned view element.
 * @param role - Logical role, never a process execution command.
 * @returns Keyboard-accessible native height control.
 */
export function paneHeight(pane: HTMLElement, role: string): HTMLElement {
  const target = pane;
  const height = paneLayout.heights.get(role) ?? DEFAULT_HEIGHT;
  target.dataset['workerRole'] = role;
  target.style.height = `${String(height)}px`;
  paneObserver?.observe(target);
  const label = element('label', 'resize-control', 'Pane height');
  const range = element('input');
  range.type = 'range';
  range.min = String(MIN_HEIGHT);
  range.max = String(MAX_HEIGHT);
  range.step = String(HEIGHT_STEP);
  range.value = String(height);
  range.setAttribute('aria-label', `${role} pane height`);
  range.addEventListener('input', () => {
    const next = Number(range.value);
    saveHeight(role, next);
    target.style.height = `${String(next)}px`;
  });
  label.append(range);
  return label;
}

/**
 * Validate a UI artifact selector before issuing a backend request.
 *
 * @param file - Native selector value.
 * @returns Whether it names a fixed managed artifact.
 */
export function isWorkerArtifact(file: string): boolean {
  return allowedFiles.has(file);
}

/**
 * Show dispatch and explicit model reports separately from acceptance proof.
 *
 * @param factory - Validated snapshot record.
 * @param role - Selected logical role.
 * @param taskId - Actual delivery, absent for planning.
 * @returns Bounded, text-only instruction receipt panel.
 */
export function instructionPanel(factory: Data, role: string, taskId: string): HTMLElement {
  const panel = document.createElement('section');
  panel.classList.add('panel-body', 'instruction-receipts');
  panel.setAttribute('aria-label', `${role} operator instruction receipts`);
  const title = document.createElement('h3');
  title.textContent = 'Operator instructions';
  panel.append(title);
  const instructions = records(factory['instructions'])
    .filter((instruction) => {
      const target = text(instruction, 'taskId');
      return text(instruction, 'role') === role && (target === '' || target === taskId);
    })
    .slice(0, VISIBLE_INSTRUCTIONS);
  if (instructions.length === 0) {
    const empty = document.createElement('p');
    empty.textContent = 'No queued instructions for this role or delivery.';
    panel.append(empty);
  }
  for (const instruction of instructions) {
    const row = document.createElement('p');
    const state = text(instruction, 'state');
    const label = state === 'applied' || state === 'acknowledged' ? `${state} (agent report)` : state;
    row.textContent = `${label}: ${text(instruction, 'body').slice(0, INSTRUCTION_EXCERPT)}`;
    panel.append(row);
  }
  return panel;
}

/**
 * Render real peer conversations independently of logs and instruction receipts.
 *
 * @param factory - Scoped authenticated backend snapshot.
 * @param role - Logical worker whose incoming/outgoing messages are shown.
 * @returns Text-only bounded conversation panel; inspection never acknowledges agent messages.
 */
export function conversationPanel(factory: Data, role: string): HTMLElement {
  const panel = element('section', 'panel-body instruction-receipts');
  panel.setAttribute('aria-label', `${role} broker conversations`);
  panel.append(element('h3', '', 'Broker conversations'));
  const identity = `factory-${role}`;
  const messages = records(factory['conversations'])
    .filter((message) => text(message, 'sender_name') === identity || text(message, 'recipient_name') === identity)
    .slice(-VISIBLE_INSTRUCTIONS);
  if (messages.length === 0) {
    panel.append(element('p', 'subtle', 'No recent peer messages for this role.'));
  }
  for (const message of messages) {
    const row = element('article', 'lesson');
    row.append(
      element('strong', '', `${text(message, 'sender_name')} → ${text(message, 'recipient_name')}`),
      element('p', '', text(message, 'body')),
    );
    if (message['truncated'] === true) {
      row.append(
        element('p', 'subtle', 'Preview clipped; full history remains in project SQLite and the agent inbox.'),
      );
    }
    panel.append(row);
  }
  return panel;
}

/**
 * Compose distinct actual logs, peer conversations and operator receipt sections.
 *
 * @param context - Existing scoped native controls and observed output.
 * @returns Safe worker body with no terminal simulation or client scheduling authority.
 */
export function workerBody(context: {
  factory: Data;
  role: string;
  taskId: string;
  summary: string;
  tools: HTMLElement;
  log: HTMLElement;
}): HTMLElement {
  const body = element('div');
  body.append(
    context.tools,
    instructionPanel(context.factory, context.role, context.taskId),
    conversationPanel(context.factory, context.role),
    element('p', 'panel-body subtle', context.summary),
    context.log,
  );
  return body;
}

/**
 * Build a keyboard-accessible native selector, rendering labels as text.
 *
 * @param role - Logical role label.
 * @param file - Selected artifact.
 * @param change - Controller callback; never direct process execution.
 * @returns Scoped native artifact selector.
 */
export function artifactSelector(
  role: string,
  file: string,
  change: (role: string, file: string) => void,
): HTMLSelectElement {
  const selector = document.createElement('select');
  selector.classList.add('artifact-select');
  selector.setAttribute('aria-label', `${role} artifact`);
  for (const candidate of WORKER_FILES) {
    const option = document.createElement('option');
    option.textContent = candidate;
    option.value = candidate;
    selector.append(option);
  }
  selector.value = isWorkerArtifact(file) ? file : 'stdout.log';
  selector.addEventListener('change', () => {
    if (isWorkerArtifact(selector.value)) {
      change(role, selector.value);
    }
  });
  return selector;
}

/**
 * Save only harmless role layout; storage failure must not prevent navigation.
 *
 * @param key - Application-owned public layout key.
 * @param roles - Validated logical role selections.
 */
export function persistRoles(key: string, roles: readonly string[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(roles));
  } catch {
    /* Layout remains usable when browser storage is unavailable. */
  }
}
