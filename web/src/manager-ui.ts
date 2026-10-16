/**
 * Persistent delivery manager view: the real conversation, the manager's true
 * session state and controls, decisions waiting on the operator and the
 * mission brief. Every value is untrusted plain text rendered with textContent.
 *
 * @file
 */
import { data, firstText, number, records, text } from './api.js';
import { ago } from './manager-controller.js';
import { element } from './worker-ui.js';

import type { Data } from './api.js';
import type { ManagerController } from './manager-controller.js';

/** Human labels and tones for session states. */
const STATES: Readonly<Record<string, { label: string; tone: string }>> = {
  starting: { label: 'Starting', tone: 'running' },
  waiting: { label: 'Ready', tone: 'success' },
  working: { label: 'Working', tone: 'running' },
  stopping: { label: 'Stopping', tone: 'queued' },
  stopped: { label: 'Stopped', tone: '' },
  failed: { label: 'Failed', tone: 'failed' },
};
/** Short commit identity length. */
const SHORT = 8;
/** Mission table column titles. */
const COLUMNS = ['Delivery', 'Stage', 'Owner and model', 'Branch', 'Progress', 'Next'];

/**
 * Create a native button.
 *
 * @param title - Accessible label.
 * @param action - Callback.
 * @param cssClass - Trusted style.
 * @returns A keyboard-accessible button wired to the callback.
 */
function button(title: string, action: () => void, cssClass = 'small-button'): HTMLButtonElement {
  const node = element('button', cssClass, title);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}

/**
 * Format a time of day.
 *
 * @param at - Epoch milliseconds.
 * @returns Local time text.
 */
function clock(at: number): string {
  const time = new Date(at);
  return time.toLocaleTimeString();
}

/**
 * Plain facts about the current session.
 *
 * @param status - Manager status.
 * @param session - Current session record.
 * @param now - Current time.
 * @returns Non-empty facts.
 */
function sessionFacts(status: Data, session: Data, now: number): string[] {
  const generation = number(session, 'generation');
  const pid = number(session, 'pid');
  const activity = number(status, 'lastActivityAt');
  const queued = number(status, 'queued');
  const paused = number(status, 'pausedUntil');
  const tool = text(status, 'lastTool');
  return [
    firstText(text(session, 'model'), text(session, 'provider')),
    generation > 0 ? `session ${String(generation)}` : '',
    pid > 0 ? `PID ${String(pid)}` : '',
    activity > 0 ? `active ${ago(activity, now)}` : '',
    tool === '' ? '' : `last tool ${tool}`,
    queued > 0 ? `${String(queued)} queued` : '',
    paused > now ? `rate-limited until ${clock(paused)}` : '',
  ].filter((fact) => fact !== '');
}

/**
 * Start or stop control for the current state.
 *
 * @param isLive - Whether a generation is live.
 * @param controller - View controller.
 * @returns Control button.
 */
function lifecycleButton(isLive: boolean, controller: ManagerController): HTMLButtonElement {
  if (isLive) {
    return button('Stop', () => {
      controller.act('stop');
    });
  }
  return button(
    'Start manager',
    () => {
      controller.act('start');
    },
    'button primary',
  );
}

/**
 * Status bar with the manager's true state and its controls.
 *
 * @param status - Manager status.
 * @param controller - View controller.
 * @param now - Current time.
 * @returns Header with state pill, facts, controls and any stop reason.
 */
function header(status: Data, controller: ManagerController, now: number): HTMLElement {
  const session = status['session'] === null ? {} : data(status['session']);
  const isLive = status['isLive'] === true;
  const state = firstText(text(session, 'state'), 'stopped');
  const shown = STATES[state] ?? { label: state, tone: '' };
  const bar = element('div', 'manager-bar');
  const identity = element('div', 'manager-identity');
  identity.append(
    element('span', `pill ${shown.tone}`, isLive ? shown.label : `Offline · ${shown.label}`),
    element('strong', '', 'Delivery manager'),
    element('span', 'subtle', sessionFacts(status, session, now).join(' · ')),
  );
  const tools = element('div', 'ticket-actions');
  tools.append(
    lifecycleButton(isLive, controller),
    button('Export transcript', () => {
      void controller.exportTranscript();
    }),
  );
  bar.append(identity, tools);
  const reason = text(session, 'reason');
  if (!isLive && reason !== '') {
    bar.append(element('p', state === 'failed' ? 'error' : 'subtle', reason));
  }
  return bar;
}

/**
 * One decision card.
 *
 * @param item - Brief decision.
 * @param controller - View controller.
 * @returns Card with answers for manager questions or the console route for others.
 */
function decisionCard(item: Data, controller: ManagerController): HTMLElement {
  const card = element('article', 'decision-card');
  card.append(element('h3', '', text(item, 'title')), element('p', 'subtle', text(item, 'detail')));
  const route = text(item, 'resolveWith');
  if (text(item, 'kind') !== 'manager') {
    card.append(element('p', 'decision-route', `Resolve in ${route}`));
    return card;
  }
  const id = text(item, 'id');
  const choices = route
    .replace(/^Answer: /v, '')
    .split(' / ')
    .filter((value) => value !== '' && value !== 'Answer in the manager');
  const actions = element('div', 'ticket-actions');
  for (const choice of choices) {
    actions.append(
      button(choice, () => {
        controller.act('answer', { decisionId: id, text: choice });
      }),
    );
  }
  card.append(actions);
  return card;
}

/**
 * Decisions waiting on the operator.
 *
 * @param brief - Mission brief.
 * @param controller - View controller.
 * @returns Panel listing every decision only a human can make.
 */
function decisions(brief: Data, controller: ManagerController): HTMLElement {
  const panel = element('section', 'panel manager-decisions');
  const items = records(brief['decisions']);
  const head = element('div', 'panel-head');
  head.append(element('h2', '', 'Needs your decision'), element('span', 'count', String(items.length)));
  const list = element('div', 'panel-body');
  list.append(...items.map((item) => decisionCard(item, controller)));
  if (items.length === 0) {
    list.append(element('p', 'subtle', 'Nothing is waiting on you.'));
  }
  panel.append(head, list);
  return panel;
}

/**
 * Progress evidence for one running assignment.
 *
 * @param job - Brief job.
 * @param now - Current time.
 * @returns Plain evidence text.
 */
function progress(job: Data, now: number): string {
  const checkpoint = number(job, 'progressAt');
  const activity = number(job, 'activityAt');
  const parts = [
    checkpoint > 0 ? `checkpoint ${ago(checkpoint, now)}` : '',
    activity > 0 ? `output ${ago(activity, now)}` : '',
    job['isPossiblyStalled'] === true ? 'possibly stalled' : '',
  ].filter((part) => part !== '');
  return parts.length === 0 ? 'no evidence yet' : parts.join(' · ');
}

/**
 * Owner and model of a delivery.
 *
 * @param delivery - Brief delivery.
 * @param job - Running assignment, if any.
 * @returns Display text.
 */
function ownerText(delivery: Data, job: Data | null): string {
  if (job === null) {
    return firstText(text(delivery, 'developer'), '—');
  }
  const model = firstText(text(job, 'model'), text(job, 'provider'));
  return `${text(job, 'role')} · ${model}`;
}

/**
 * One mission table row.
 *
 * @param delivery - Brief delivery.
 * @param now - Current time.
 * @returns Table row.
 */
function deliveryRow(delivery: Data, now: number): HTMLTableRowElement {
  const job = delivery['job'] === null ? null : data(delivery['job']);
  const row = element('tr', job?.['isPossiblyStalled'] === true ? 'mission-stalled' : '');
  const branch = [text(delivery, 'branch'), text(delivery, 'head').slice(0, SHORT)].filter((part) => part !== '');
  const location = firstText(branch.join(' @ '), '—');
  const title = `#${String(number(delivery, 'issue'))} ${text(delivery, 'title')}`;
  row.append(
    element('td', '', title),
    element('td', '', text(delivery, 'stage').replaceAll('_', ' ')),
    element('td', '', ownerText(delivery, job)),
    element('td', 'mission-branch', location),
    element('td', '', job === null ? '—' : progress(job, now)),
    element('td', '', text(delivery, 'nextAction')),
  );
  return row;
}

/**
 * Table of open deliveries with stage, owner, branch, progress and next step.
 *
 * @param deliveries - Open deliveries.
 * @param now - Current time.
 * @returns Table element.
 */
function deliveryTable(deliveries: readonly Data[], now: number): HTMLTableElement {
  const table = element('table', 'mission-table');
  const headRow = element('tr');
  headRow.append(...COLUMNS.map((title) => element('th', '', title)));
  const thead = element('thead');
  thead.append(headRow);
  const tbody = element('tbody');
  tbody.append(...deliveries.map((delivery) => deliveryRow(delivery, now)));
  table.append(thead, tbody);
  return table;
}

/**
 * Mission details: objectives and open deliveries.
 *
 * @param brief - Objectives, deliveries and completion count from the factory.
 * @param now - Current time.
 * @returns Panel with objectives and a delivery table.
 */
function mission(brief: Data, now: number): HTMLElement {
  const panel = element('section', 'panel manager-mission');
  const deliveries = records(brief['deliveries']);
  const head = element('div', 'panel-head');
  const done = `${String(number(brief, 'done'))} done`;
  head.append(element('h2', '', 'Mission'), element('span', 'count', done));
  const body = element('div', 'panel-body');
  const objectives = records(brief['objectives']);
  for (const objective of objectives) {
    const line = `${text(objective, 'phase')} · ${text(objective, 'objective')}`;
    body.append(element('p', 'mission-objective', line));
  }
  body.append(
    deliveries.length === 0
      ? element('p', 'subtle', 'No open deliveries. Tell the manager what you want built.')
      : deliveryTable(deliveries, now),
  );
  panel.append(head, body);
  return panel;
}

/**
 * Render the manager view.
 *
 * @param summary - Snapshot manager status and brief, null before configuration.
 * @param controller - View controller with persistent transcript and composer.
 * @returns Complete manager workspace.
 */
export function managerView(summary: Data | null, controller: ManagerController): HTMLElement {
  if (summary === null) {
    const empty = element('div', 'empty');
    empty.append(
      element('span', 'empty-mark', '◈'),
      element('h2', '', 'Configure the factory first'),
      element(
        'p',
        '',
        'The delivery manager steers the configured factory. Set it up under Project, then start the manager here.',
      ),
    );
    return empty;
  }
  const now = Date.now();
  const status = data(summary['status']);
  const brief = data(summary['brief']);
  const conversation = element('section', 'panel manager-conversation');
  conversation.append(controller.transcript, controller.composer);
  const side = element('div', 'manager-side');
  side.append(decisions(brief, controller), mission(brief, now));
  const columns = element('div', 'manager-columns');
  columns.append(conversation, side);
  const view = element('div', 'manager-view');
  view.append(header(status, controller, now), columns);
  return view;
}
