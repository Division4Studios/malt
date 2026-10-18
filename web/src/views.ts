/**
 * Native DOM mission-control views; project text is always rendered as text.
 *
 * @file
 */
import { child, firstText, numericText, number, records, text, hasFlag } from './api.js';
import { overviewMetrics, objectiveQueue } from './brand-ui.js';
import { capacityView } from './capacity-view.js';
import { definitionProgress } from './goal-ui.js';
import { formatTime, t } from './i18n.js';
import { maintenancePanel, appendBaselineWarning } from './learning-ui.js';
import { organizationPanel } from './organization-ui.js';
import { recoveryPanel } from './recovery-ui.js';
import { handoffPreviews } from './report-ui.js';
import { selectionDetails } from './selection-ui.js';
import { triagePanel } from './triage-ui.js';
import {
  artifactSelector,
  element,
  beginWorkerLayout,
  paneHeight,
  handoffBadge,
  appendHandoffBadge,
  workerBody,
} from './worker-ui.js';

import type { Data, Snapshot } from './api.js';
import type { RecoveryAction } from './recovery-ui.js';
import type { TriageAction } from './triage-ui.js';
/** Compact activity count. */
const COMPACT_EVENTS = 6;
/** Full visible activity page. */
const VISIBLE_EVENTS = 200;
/** Maximum displayed observation excerpt. */
const EXCERPT_LENGTH = 500;
/** Short commit identity for display, never for approval fencing. */
const HEAD_LENGTH = 8;
/** Durable logical roles, independently of live processes. */
export const ROLES = [
  'product-owner',
  'team-lead',
  'developer-1',
  'developer-2',
  'qa-1',
  'qa-2',
  'final-tester',
  'learning-steward',
  'plan-reviewer',
  'fixer',
  'librarian',
  'regression-verifier',
] as const;
/** Operator actions are routed by the controller, never run by a view. */
export interface Actions {
  /** Recover a blocked objective with an explicit human decision. */
  readonly recover: (feature: Data, action: RecoveryAction) => void;
  /** Decide against one exact delivery revision. */
  readonly triage: (task: Data, action: TriageAction) => void;
  /** Edit reusable types and the backend-validated reporting hierarchy. */
  readonly organization: () => void;
  /** Human-authorized handoff to a separate MALT source-project factory. */
  readonly maintenance: (requestId: string) => void;
  /** Select actual output, conversations, assignment or validation evidence. */
  readonly artifact: (role: string, file: string) => void;
  /** Human decision on one exact reviewed skill revision. */
  readonly skillDecision: (requestId: string, shouldApprove: boolean) => void;
  /** Inspect an owned role. */
  readonly inspect: (role: string) => void;
  /** Persist a role instruction or coordinated scope change. */
  readonly instruct: (role: string, taskId: string, shouldReplan: boolean) => void;
  /** Request cancellation of an owned job. */
  readonly cancel: (job: string) => void;
  /** Resume a resolved blocker. */
  readonly retry: (id: string, isFeature: boolean) => void;
  /** Atomically save operator dispatch order and focus. */
  readonly queue: (
    order: string[],
    focusedFeatureId: string | null,
    expectedRevision: number,
    shouldLimitToExisting?: boolean,
  ) => void;
  /** Edit validated project configuration or GitHub connection. */
  readonly setup: (isConnection: boolean) => void;
  /** Edit exact-revision account-local model choices through the same backend. */
  readonly modelPolicy: () => void;
}

export { element } from './worker-ui.js';

/**
 * Create a focusable operator button.
 *
 * @param title - Plain accessible label.
 * @param action - Explicit controller callback.
 * @param cssClass - Trusted visual style.
 * @returns Native button.
 */
function button(title: string, action: () => void, cssClass = 'small-button'): HTMLButtonElement {
  const node = element('button', cssClass, title);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}

/**
 * Create a scoped panel with a heading and count.
 *
 * @param title - Panel heading.
 * @param count - Plain count/status.
 * @param content - Already-safe DOM contents.
 * @returns Panel section.
 */
function panel(title: string, count: string, content: HTMLElement): HTMLElement {
  const node = element('section', 'panel');
  const heading = element('div', 'panel-head');
  heading.append(element('h2', '', title), element('span', 'count', count));
  node.append(heading, content);
  return node;
}

/**
 * Render a truthful empty state without demo activity.
 *
 * @param title - Missing state.
 * @param description - Useful next action.
 * @returns Empty state element.
 */
function empty(title: string, description: string): HTMLElement {
  const node = element('div', 'empty');
  node.append(element('span', 'empty-mark', '◈'), element('h2', '', title), element('p', '', description));
  return node;
}

/**
 * Status color supplements readable text; arbitrary text never becomes CSS.
 *
 * @param state - Actual status.
 * @returns Bounded styled lifecycle label.
 */
function pill(state: string): HTMLElement {
  const known = [
    'running',
    'done',
    'development',
    'review',
    'verifying',
    'blocked',
    'failed',
    'succeeded',
    'success',
    'ready',
    'queued',
    'merge_ready',
  ];
  return element('span', `pill ${known.includes(state) ? state : ''}`, state.replaceAll('_', ' '));
}

/**
 * Render only safe GitHub HTTPS references.
 *
 * @param url - Saved project reference.
 * @param title - Plain link label.
 * @returns Native link or nonclickable text if the reference is invalid.
 */
function link(url: string, title: string): HTMLElement {
  try {
    const address = new URL(url);
    if (address.protocol !== 'https:' || address.hostname !== 'github.com') {
      return element('span', 'subtle', title);
    }
    const node = element('a', 'ticket-link', title);
    node.href = address.href;
    node.target = '_blank';
    node.rel = 'noopener noreferrer';
    return node;
  } catch {
    return element('span', 'subtle', title);
  }
}

/**
 * Resolve a scoped native issue link from the selected repository.
 *
 * @param state - Project snapshot.
 * @param issue - Native issue number.
 * @returns GitHub reference, absent without a connection.
 */
function issueUrl(state: Snapshot, issue: number): string {
  const repository = text(child(state.github, 'connection'), 'repository');
  return repository === '' ? '' : `https://github.com/${repository}/issues/${String(issue)}`;
}

/**
 * Find the latest attempt for one logical role.
 *
 * @param state - Actual factory jobs.
 * @param role - Logical role slot.
 * @returns Most recent job, or an empty record.
 */
export function roleJob(state: Snapshot, role: string): Data {
  return records(state.factory['jobs']).findLast((job) => text(job, 'role') === role) ?? {};
}

/**
 * Build a role card showing live process state and current ownership.
 *
 * @param state - Factory snapshot.
 * @param role - Independent role.
 * @param actions - Explicit operator controls.
 * @returns Real role card.
 */
function roleCard(state: Snapshot, role: string, actions: Actions): HTMLElement {
  const job = roleJob(state, role);
  const isLive = text(job, 'state') === 'running';
  const task = records(state.factory['tasks']).find((candidate) => text(candidate, 'id') === text(job, 'taskId')) ?? {};
  const node = element('article', 'role');
  node.dataset['state'] = isLive ? 'running' : 'parked';
  const heading = element('div', 'role-header');
  const identity = element('div', 'role-top');
  const name = role.replaceAll('-', ' ');
  identity.append(
    element(
      'span',
      'role-avatar',
      role
        .split('-')
        .map((part) => part[0] ?? '')
        .join('')
        .toUpperCase(),
    ),
    element('h3', '', name),
  );
  heading.append(identity, pill(isLive ? 'running' : t('spun down')));
  node.append(heading);
  appendHandoffBadge(node, state, role);
  const routing = child(job, 'routing');
  const model = firstText(text(routing, 'model'), t('CLI default · capability unverified'));
  if (Object.keys(routing).length > 0) {
    node.append(element('p', 'subtle', `${model} · ${text(routing, 'tier')}`));
  }
  const pid = number(job, 'pid');
  const processId = pid > 0 ? String(pid) : t('starting');
  const provider = text(job, 'provider');
  const kind = text(job, 'kind');
  node.append(
    element(
      'p',
      '',
      isLive
        ? t('{provider} · {kind} · PID {processId}', { provider, kind, processId })
        : t('No model process · awaiting eligible work'),
    ),
  );
  const issue = number(task, 'issue');
  const parkedScope = t(
    role === 'learning-steward' ? 'Evidence, research & project skills' : 'Planning / next assignment',
  );
  node.append(
    issue > 0
      ? link(issueUrl(state, issue), `#${String(issue)} ${text(task, 'title')}`)
      : element('p', '', parkedScope),
  );
  const footer = element('div', 'role-footer');
  footer.append(
    button(t('Open workspace ↗'), () => {
      actions.inspect(role);
    }),
    button(t('Send instruction'), () => {
      actions.instruct(role, text(task, 'id'), false);
    }),
  );
  node.append(footer);
  return node;
}

/**
 * Render all parked and running roles without fabricating process activity.
 *
 * @param state - Actual factory snapshot.
 * @param actions - Role controls.
 * @param shouldIncludeOrganization - Show editable configuration only on the team page.
 * @returns Role grid.
 */
export function teamView(state: Snapshot, actions: Actions, shouldIncludeOrganization = true): HTMLElement {
  const node = element('div');
  if (shouldIncludeOrganization) {
    node.append(organizationPanel(state, actions.organization));
  }
  const seats = element('div', 'roles');
  for (const role of ROLES) {
    seats.append(roleCard(state, role, actions));
  }
  node.append(seats);
  return node;
}

/**
 * Render real committed activity with timestamps and safe evidence text.
 *
 * @param state - Current project snapshot.
 * @param isCompact - Whether to show a short overview.
 * @returns Activity timeline.
 */
export function activityView(state: Snapshot, isCompact = false): HTMLElement {
  const body = element('div', 'panel-body timeline');
  const events = state.events.toReversed().slice(0, isCompact ? COMPACT_EVENTS : VISIBLE_EVENTS);
  for (const event of events) {
    const node = element('article', 'event');
    const detail = element('div');
    const evidence = child(event, 'data');
    const occurred = new Date(number(event, 'created_at'));
    const eventTime = formatTime(occurred);
    detail.append(
      element('div', 'event-text', text(event, 'type').replaceAll('_', ' ').toLowerCase()),
      element('div', 'event-time', eventTime),
    );
    const summary = firstText(
      text(evidence, 'body'),
      text(evidence, 'summary'),
      text(evidence, 'reason'),
      text(evidence, 'phase'),
      text(evidence, 'role'),
    );
    if (summary !== '') {
      detail.append(element('p', 'subtle', summary.slice(0, EXCERPT_LENGTH)));
    }
    node.append(element('span', 'event-dot'), detail);
    body.append(node);
  }
  if (events.length === 0) {
    body.append(element('p', 'subtle', t('No activity yet. A quiet factory is not consuming model tokens.')));
  }
  return body;
}

/**
 * Mission overview ties real process, delivery and capacity state together.
 *
 * @param state - Selected project snapshot.
 * @param actions - Operator controls.
 * @param isConnected - Whether the selected snapshot is currently connected.
 * @returns Overview workspace.
 */
export function overviewView(state: Snapshot, actions: Actions, isConnected = true): HTMLElement {
  const node = element('div');
  const metrics = overviewMetrics(state.factory);
  const grid = element('div', 'grid');
  const left = element('div');
  const team = element('div', 'panel-body');
  team.append(teamView(state, actions, false));
  const roleCount = t('{count} LOGICAL ROLES', { count: String(ROLES.length).padStart(2, '0') });
  left.append(panel(t('Your autonomous team'), roleCount, team));
  const queue = objectiveQueue(records(state.factory['features']), actions, child(state.factory, 'objectiveQueue'));
  left.append(
    panel(t('Product queue'), t('{unfinished} UNFINISHED OBJECTIVES', { unfinished: queue.unfinished }), queue.body),
  );
  const progress = definitionProgress({ factory: state.factory });
  if (progress !== null) {
    left.append(panel(t('Definitions of done'), t('OPEN CHECKLISTS'), progress));
  }
  const right = element('div');
  right.append(
    panel(t('Provider & local capacity'), t('SUBSCRIPTION SESSIONS'), capacityView(state)),
    panel(t('Latest handoffs and messages'), t('DURABLE RECORDS'), handoffPreviews(state, isConnected)),
  );
  grid.append(left, right);
  node.append(recoveryPanel(state, actions), metrics, triagePanel(state, actions), grid);
  return node;
}

/**
 * Group actual delivery stages without pretending local approval is a GitHub review.
 *
 * @param state - Delivery and remote evidence.
 * @param actions - Operator instructions/retry.
 * @returns Scrollable real delivery board.
 */
export function deliveryView(state: Snapshot, actions: Actions): HTMLElement {
  const tasks = records(state.factory['tasks']);
  if (tasks.length === 0) {
    return empty(
      t('No delivery tickets yet'),
      t('Product owner and team lead prepare atomic parent/child issues on the connected GitHub Project.'),
    );
  }
  const board = element('div', 'board');
  const columns = [
    ['PREPARED', ['ready']],
    ['DEVELOPMENT', ['development', 'publishing', 'blocked']],
    [t('REVIEW & VERIFY'), ['review', 'merge_ready', 'merging', 'verifying', 'closing']],
    ['DELIVERED', ['done']],
  ] as const;
  for (const [title, phases] of columns) {
    const column = element('section', 'column');
    const items = tasks.filter((task) => (phases as readonly string[]).includes(text(task, 'phase')));
    const heading = element('div', 'column-title');
    heading.append(element('span', '', title), element('span', '', String(items.length)));
    column.append(heading);
    for (const task of items) {
      column.append(ticket(state, task, actions));
    }
    board.append(column);
  }
  return board;
}

/**
 * Show one verifiable task with concrete ownership, findings and references.
 *
 * @param state - Project references.
 * @param task - Real task.
 * @param actions - Operator controls.
 * @returns Delivery card.
 */
function ticket(state: Snapshot, task: Data, actions: Actions): HTMLElement {
  const node = element('article', 'ticket');
  const phase = text(task, 'phase');
  const issue = number(task, 'issue');
  const owner = firstText(text(task, 'developer'), t('unassigned'));
  const attempts = numericText(task, 'attempts');
  node.append(
    link(issueUrl(state, issue), `#${String(issue)} · parent #${numericText(task, 'parentIssue')}`),
    element('h3', '', text(task, 'title')),
    pill(phase),
    element('p', '', t('Owner: {owner} · attempts {attempts}', { owner, attempts })),
  );
  const reviews = records(task['reviews']);
  const head = firstText(text(task, 'head').slice(0, HEAD_LENGTH), 'unpublished');
  node.append(element('p', '', t('Independent QA: {length}/2 · head {head}', { length: reviews.length, head })));
  const criteria = task['acceptanceCriteria'];
  if (Array.isArray(criteria)) {
    const list = element('ul');
    for (const criterion of criteria) {
      if (typeof criterion === 'string') {
        list.append(element('li', '', criterion));
      }
    }
    node.append(list);
  }
  if (text(task, 'error') !== '') {
    node.append(element('p', 'error', text(task, 'error')));
  }
  if (text(task, 'prUrl') !== '') {
    const label = t('PR #{pr} ↗', { pr: numericText(task, 'pr') });
    node.append(link(text(task, 'prUrl'), label));
  }
  const controls = element('div', 'ticket-actions');
  controls.append(
    button(t('Instruct owner'), () => {
      actions.instruct(owner === 'unassigned' ? 'team-lead' : owner, text(task, 'id'), false);
    }),
    button(t('Change scope'), () => {
      actions.instruct('team-lead', text(task, 'id'), true);
    }),
  );
  if (phase === 'blocked') {
    controls.append(
      button(t('Retry resolved blocker'), () => {
        actions.retry(text(task, 'id'), false);
      }),
    );
  }
  node.append(controls);
  return node;
}

/**
 * Read-only worker panes show genuine captured output, not simulated terminals.
 *
 * @param state - Actual jobs.
 * @param context - Selected roles, output tails and actions.
 * @returns Resizable bounded worker workspace.
 */
export function workerView(
  state: Snapshot,
  context: {
    roles: readonly string[];
    logs: ReadonlyMap<string, string>;
    files: ReadonlyMap<string, string>;
    actions: Actions;
  },
): HTMLElement {
  const grid = element('div', 'worker-grid');
  beginWorkerLayout();
  for (const role of context.roles) {
    handoffBadge(state, role, true);
    const job = roleJob(state, role);
    const jobId = text(job, 'id');
    const file = context.files.get(role) ?? 'stdout.log';
    const taskId = text(job, 'taskId');
    const tools = element('div', 'panel-body toolbar');
    const processState = firstText(text(job, 'state'), t('spun down'));
    const selector = artifactSelector(role, file, context.actions.artifact);
    tools.append(
      selector,
      pill(processState),
      button(t('Send instruction'), () => {
        context.actions.instruct(role, taskId, false);
      }),
      button(t('Coordinated scope change'), () => {
        context.actions.instruct('team-lead', taskId, true);
      }),
    );
    if (text(job, 'state') === 'running') {
      tools.append(
        button(t('Cancel owned job'), () => {
          context.actions.cancel(jobId);
        }),
      );
    }
    const log = element(
      'pre',
      'log',
      context.logs.get(`${jobId}:${file}`) ??
        (text(job, 'id') === ''
          ? t('This role has not been started. No model process is running.')
          : t('Reading actual {file}…', { file })),
    );
    log.setAttribute('aria-label', t('{role} captured output', { role }));
    log.dataset['job'] = text(job, 'id');
    log.dataset['file'] = file;
    const summary = firstText(
      text(job, 'summary'),
      t('Captured output and handoffs. This pane is not an interactive terminal.'),
    );
    const body = workerBody({ factory: state.factory, role, taskId, summary, tools, log });
    body.prepend(selectionDetails(job, text(state.factory, 'error')));
    const pane = panel(role.replaceAll('-', ' '), firstText(text(job, 'provider').toUpperCase(), 'PARKED'), body);
    pane.classList.add('worker-pane');
    tools.append(paneHeight(pane, role));
    grid.append(pane);
  }
  return grid;
}

/**
 * Render observed lessons and reviewed project skills with provenance links.
 *
 * @param state - Project learning snapshot.
 * @param actions - Explicit human decisions through the backend.
 * @returns Learning library.
 */
export function learningView(state: Snapshot, actions: Actions): HTMLElement {
  const grid = element('div', 'library-grid');
  const decisions = element('div', 'panel-body');
  const requests = records(state.factory['skillRequests']);
  for (const request of requests) {
    if (text(request, 'status') !== 'awaiting_operator') {
      continue;
    }
    const id = text(request, 'id');
    const revision = text(request, 'revision');
    const item = element('article', 'lesson');
    item.append(
      element('h3', '', text(request, 'name')),
      element('p', '', text(request, 'reason')),
      element('p', '', text(request, 'summary')),
      element('p', 'subtle', t('Exact revision: {revision}', { revision })),
      button(t('Review and approve'), () => {
        actions.skillDecision(id, true);
      }),
      button(t('Review and reject'), () => {
        actions.skillDecision(id, false);
      }),
    );
    decisions.append(item);
  }
  grid.append(panel(t('Human approval gate'), t('PROJECT OVERRIDES'), decisions));
  grid.append(
    panel(
      t('Reusable factory improvements'),
      t('SEPARATE SOURCE PIPELINE'),
      maintenancePanel(requests, actions.maintenance),
    ),
  );
  for (const [heading, key] of [
    [t('Observed lessons'), 'lessons'],
    [t('Active & retired skills'), 'skills'],
    [t('Candidate proposals'), 'candidates'],
  ] as const) {
    const items = records(state.learning[key]);
    const body = element('div');
    for (const item of items) {
      const node = element('article', 'lesson');
      const decision = requests.find(
        (request) =>
          text(request, 'name') === text(item, 'name') && text(request, 'revision') === text(item, 'revision'),
      );
      const proposalState = decision === undefined ? '' : text(decision, 'status');
      const title = firstText(text(item, 'summary'), text(item, 'name'));
      const explanation = firstText(text(item, 'cause'), text(item, 'rationale'), text(item, 'reason'));
      const status = firstText(proposalState, text(item, 'state'), text(item, 'outcome'), 'proposed');
      node.append(
        element('h3', '', title),
        element('p', '', explanation),
        element('p', '', text(item, 'prevention')),
        pill(status),
      );
      body.append(node);
    }
    if (items.length === 0) {
      const lowered = heading.toLowerCase();
      body.append(
        empty(
          t('No {heading} yet', { heading: lowered }),
          t('The learning steward records real outcomes and proposes focused project-specific improvements.'),
        ),
      );
    }
    grid.append(panel(heading, `${String(items.length)} VISIBLE`, body));
  }
  const sources = element('div', 'panel-body');
  for (const repository of [
    'mattpocock/skills',
    'addyosmani/agent-skills',
    'backnotprop/pstack',
    'tiimgreen/github-cheat-sheet',
  ]) {
    const row = element('p');
    row.append(link(`https://github.com/${repository}`, repository));
    sources.append(row);
  }
  sources.append(
    element(
      'p',
      'subtle',
      t(
        'Bundled role skills are pinned and licensed in .malt/skills/builtin. Software upgrades refresh unchanged managed baselines and retain previous revisions. Project adaptations require independent lead review and human approval; active local revisions override defaults on new assignments.',
      ),
    ),
  );
  appendBaselineWarning(sources, state.learning);
  grid.append(panel(t('Reviewed research baseline'), t('PINNED PROVENANCE'), sources));
  return grid;
}

/**
 * Project setup operates real validated backend configuration, not local-only settings.
 *
 * @param state - Actual setup readiness.
 * @param actions - Explicit server controls.
 * @returns Setup cards.
 */
export function setupView(state: Snapshot, actions: Actions): HTMLElement {
  const grid = element('div', 'setup-steps');
  const connection = child(state.github, 'connection');
  const project = child(connection, 'project');
  const workflowField = firstText(text(child(connection, 'statusField'), 'name'), t('not selected'));
  const github = element('section', 'setup-card');
  const repositoryLabel = firstText(
    text(connection, 'repository'),
    t('Connect the selected target repository to its intended Project.'),
  );
  github.append(
    element('div', 'eyebrow', t('01 / DELIVERY SOURCE')),
    element('h2', '', t('GitHub Project')),
    pill(hasFlag(state.github, 'connected') ? 'connected' : t('not connected')),
    element('p', 'subtle', repositoryLabel),
    element(
      'p',
      'subtle',
      t('Workflow field: {workflowField}. Tickets appear in this Project; board grouping must use this field.', {
        workflowField,
      }),
    ),
    link(text(project, 'url'), t('Open connected Project ↗')),
    button(
      t('Configure connection'),
      () => {
        actions.setup(true);
      },
      'button secondary',
    ),
  );
  const factory = element('section', 'setup-card');
  factory.append(
    element('div', 'eyebrow', t('02 / EXECUTION POLICY')),
    element('h2', '', t('Factory & validation')),
    pill(hasFlag(state.factory, 'configured') ? 'configured' : t('setup required')),
    element(
      'p',
      'subtle',
      t(
        'Configure real prepare, test and end-to-end commands, provider executables, review standards and local resource limits. Pause before changing policy.',
      ),
    ),
    button(
      t('Edit factory configuration'),
      () => {
        actions.setup(false);
      },
      'button secondary',
    ),
    button(t('Edit model and effort policy'), actions.modelPolicy, 'button secondary'),
  );
  const providers = element('section', 'setup-card');
  providers.append(
    element('div', 'eyebrow', t('03 / SUBSCRIPTION SESSIONS')),
    element('h2', '', t('Codex + Claude')),
    element(
      'p',
      'subtle',
      t(
        'Authenticate the native CLIs on the machine or container running the broker. Provider keys never go in browser settings. Quota is unknown unless actual telemetry reports it.',
      ),
    ),
    element(
      'p',
      'subtle',
      t(
        'Windows: use native .exe paths. Docker: install and authenticate Linux provider CLIs inside the execution image.',
      ),
    ),
  );
  const storage = element('section', 'setup-card');
  storage.append(
    element('div', 'eyebrow', t('04 / PROJECT MEMORY')),
    element('h2', '', t('Durable, local, recoverable')),
    element('p', 'subtle', `${text(state.project, 'root')} / .malt`),
    element(
      'p',
      'subtle',
      t(
        'Conversations, instructions, delivery state, skills and evidence stay with the project. The generated README is a navigation aid; SQLite and committed artifacts remain authoritative.',
      ),
    ),
  );
  grid.append(github, factory, providers, storage);
  return grid;
}
