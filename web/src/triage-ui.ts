/**
 * Actionable delivery triage backed by the existing factory ledger.
 *
 * @file
 */
import { child, hasFlag, number, records, text } from './api.js';
import { renderReport } from './report-ui.js';
import { element } from './worker-ui.js';

import type { Data, Snapshot } from './api.js';
import type { Actions } from './views.js';

/** Typed choices correspond to server-side dispositions, never arbitrary commands. */
export const TRIAGE_ACTIONS = {
  acknowledge: ['Acknowledge', 'Record that you have seen this exact revision. It remains blocked until resolved.'],
  investigate: [
    'Ask the lead',
    'Queue one bounded, read-only lead diagnosis. The lead returns evidence, a recommended action and any question for you, then spins down.',
  ],
  repair: [
    'Send to owner',
    'Return this scope to its original developer with your instructions. Source and evidence are preserved; new work requires fresh reviews.',
  ],
  review: [
    'Request fresh QA',
    'Review the latest published source independently. Existing approvals are cleared. This does not approve or merge the PR.',
  ],
  verify: [
    'Verify merged main',
    'Explicitly accept investigation of this confirmed external merge through final merged-main checks. Missing pre-merge factory approvals remain missing; no approval is fabricated.',
  ],
  wait: [
    'Wait for decision',
    'Keep this delivery parked with a clear question or reason. No model process is kept open while waiting.',
  ],
} as const;
/** Durable triage action, validated again by the backend. */
export type TriageAction = keyof typeof TRIAGE_ACTIONS;
/** Bound the visible queue; full delivery history remains available. */
const CARD_LIMIT = 40;
/** Short human-readable card titles. */
const TITLE_LIMIT = 160;

/**
 * Latest durable disposition is distinct from actual task progress.
 *
 * @param task - Actual delivery.
 * @param decisions - Durable history.
 * @returns Current attention label.
 */
export function triageLabel(task: Data, decisions: Data[]): string {
  const latest = decisions.find((decision) => text(decision, 'taskId') === text(task, 'id'));
  if (latest === undefined) {
    return 'Needs attention';
  }
  if (number(latest, 'version') !== number(task, 'version') && text(latest, 'state') !== 'applied') {
    return 'Evidence changed';
  }
  const labels: Record<string, string> = {
    queued: 'Lead queued',
    acknowledged: 'Acknowledged',
    awaiting_operator: 'Your decision',
    applied: 'Action queued',
    stale: 'Evidence changed',
    failed: 'Investigation failed',
  };
  return labels[text(latest, 'state')] ?? 'Needs attention';
}

/**
 * Render safe remote references from the selected target project only.
 *
 * @param task - Actual delivery.
 * @param state - Selected project.
 * @returns Link row.
 */
function references(task: Data, state: Snapshot): HTMLElement {
  const row = element('div', 'triage-refs');
  const repository = text(child(state.github, 'connection'), 'repository');
  if (/^[\w\-.]+\/[\w\-.]+$/v.test(repository)) {
    const issue = element('a', '', `ISSUE ${String(number(task, 'issue'))}`);
    issue.href = `https://github.com/${repository}/issues/${String(number(task, 'issue'))}`;
    issue.target = '_blank';
    issue.rel = 'noopener noreferrer';
    row.append(issue);
  }
  const raw = text(task, 'prUrl');
  if (raw.startsWith('https://github.com/')) {
    const link = element('a', '', `PR ${String(number(task, 'pr'))}`);
    link.href = raw;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    row.append(link);
  }
  const owner = text(task, 'developer');
  row.append(element('span', 'subtle', `OWNER ${owner === '' ? 'unassigned' : owner}`));
  return row;
}

/**
 * Render one blocker with progressive detail and explicit operator dispositions.
 *
 * @param task - Actual scope.
 * @param context - Shared render context.
 * @returns Expandable card.
 */
function blockerCard(task: Data, context: { state: Snapshot; actions: Actions; decisions: Data[] }): HTMLElement {
  const { state, actions, decisions } = context;
  const card = element('details', 'triage-card');
  const id = text(task, 'id');
  card.dataset['queueKey'] = `triage:${id}`;
  const summary = element('summary');
  summary.dataset['queueFocus'] = `triage:${id}`;
  const issue = String(number(task, 'issue'));
  summary.append(
    element('span', 'triage-signal', '◇'),
    element('span', 'triage-title', `#${issue} ${text(task, 'title')}`),
    element('span', 'pill', triageLabel(task, decisions)),
  );
  const body = element('div', 'triage-body');
  body.append(references(task, state));
  const error = text(task, 'error');
  const preview = error.split('\n').find((line) => line.trim() !== '' && !line.startsWith('#')) ?? error;
  const cause = renderReport(preview.slice(0, TITLE_LIMIT));
  cause.classList.add('triage-cause');
  body.append(cause);
  const decision = decisions.find((item) => text(item, 'taskId') === text(task, 'id'));
  if (decision !== undefined) {
    body.append(element('h4', '', 'Latest disposition'), renderReport(text(decision, 'note')));
    if (text(decision, 'summary') !== '') {
      body.append(element('h4', '', 'Lead diagnosis & next action'), renderReport(text(decision, 'summary')));
    }
  }
  const controls = element('div', 'triage-actions');
  const isOwned = records(state.factory['jobs']).some(
    (job) => text(job, 'state') === 'running' && text(job, 'taskId') === text(task, 'id'),
  );
  for (const action of ['acknowledge', 'investigate', 'repair', 'review', 'verify', 'wait'] as const) {
    const button = element('button', 'triage-action', TRIAGE_ACTIONS[action][0]);
    button.type = 'button';
    button.title = TRIAGE_ACTIONS[action][1];
    button.disabled =
      isOwned ||
      (action === 'verify'
        ? task['merge'] === null
        : action === 'review' && (task['pr'] === null || task['merge'] !== null));
    button.addEventListener('click', () => {
      actions.triage(task, action);
    });
    controls.append(button);
  }
  if (isOwned) {
    body.append(
      element(
        'p',
        'subtle',
        'An assignment owns this delivery. Inspect or safely cancel it in Workers before changing its disposition.',
      ),
    );
  }
  const details = element('details', 'triage-evidence');
  details.dataset['queueKey'] = `report:${id}`;
  details.append(element('summary', '', 'Read complete blocker report'), renderReport(error));
  body.append(controls, details);
  card.append(summary, body);
  return card;
}

/**
 * Mission's decision inbox replaces a persistent wall of dispatch errors.
 *
 * @param state - Authenticated snapshot.
 * @param actions - Existing control boundary.
 * @returns Accessible triage workspace.
 */
export function triagePanel(state: Snapshot, actions: Actions): HTMLElement {
  const panel = element('section', 'triage-hub');
  panel.setAttribute('aria-label', 'Dispatcher triage');
  const tasks = records(state.factory['tasks']).filter((task) => {
    return (
      task['scopeReplacement'] === undefined &&
      text(task, 'phase') !== 'done' &&
      (text(task, 'phase') === 'blocked' || text(task, 'error') !== '')
    );
  });
  const header = element('header', 'triage-header');
  header.append(
    element('span', 'eyebrow', 'DISPATCH / FINISH FIRST'),
    element('h2', '', 'Clear the path.'),
    element('span', 'pill', `${String(tasks.length)} need attention`),
  );
  const description = hasFlag(state.factory, 'active')
    ? 'Supervisor enabled. Existing PR reviews, repairs and verification take priority. Roles spin down while decisions wait.'
    : 'Factory paused. Decisions are saved; jobs start after you resume.';
  panel.append(header, element('p', 'subtle', description));
  const error = text(state.factory, 'error');
  if (error !== '') {
    const report = element('details', 'triage-evidence');
    report.append(element('summary', '', 'Supervisor diagnostic'), renderReport(error));
    panel.append(report);
  }
  const decisions = records(state.factory['triage']);
  if (tasks.length === 0) {
    panel.append(element('p', 'triage-clear', '✓ No delivery blockers awaiting attention.'));
  }
  for (const task of tasks.slice(0, CARD_LIMIT)) {
    panel.append(blockerCard(task, { state, actions, decisions }));
  }
  if (tasks.length > CARD_LIMIT) {
    panel.append(element('p', 'subtle', 'Additional scopes are available in the delivery board.'));
  }
  const providers = child(state.factory, 'settings');
  panel.dataset['configured'] = String(Object.keys(providers).length > 0);
  return panel;
}

/**
 * Review an exact revision in the durable-control editor.
 *
 * @param task - Observed scope.
 * @param action - Explicit choice.
 * @returns Editor metadata.
 */
export function triageDialog(
  task: Data,
  action: TriageAction,
): {
  description: { title: string; explanation: string; initial: string };
  action: { operation: string; input: (body: string) => unknown };
} {
  const requestId = crypto.randomUUID();
  return {
    description: {
      title: `${TRIAGE_ACTIONS[action][0]} · issue #${String(number(task, 'issue'))}`,
      explanation: TRIAGE_ACTIONS[action][1],
      initial: action === 'acknowledge' ? 'Reviewed the current blocker.' : '',
    },
    action: {
      operation: 'factory_triage',
      input: (note) => {
        return {
          requestId,
          taskId: text(task, 'id'),
          expectedVersion: number(task, 'version'),
          action,
          note,
        };
      },
    },
  };
}
