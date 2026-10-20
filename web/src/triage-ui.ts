/**
 * Actionable delivery triage backed by the existing factory ledger.
 *
 * @file
 */
import { child, hasFlag, issueLabel, number, records, text } from './api.js';
import { dispatchSummary } from './brand-ui.js';
import { phrase, t, translated } from './i18n.js';
import { renderReport } from './report-ui.js';
import { element } from './worker-ui.js';

import type { Data, Snapshot } from './api.js';
import type { Actions } from './views.js';
import type { EditorDescription } from './worker-ui.js';

/** Typed choices correspond to server-side dispositions, never arbitrary commands. */
export const TRIAGE_ACTIONS = translated({
  adopt_merge: [
    phrase('Adopt external merge'),
    phrase(
      'Name the full commit already delivered on this project’s main and explain its scope. This queues mandatory merged-main verification; source, worktrees and missing QA evidence are preserved.',
    ),
  ],
  approve_size: [
    phrase('Approve this size exception'),
    phrase(
      'Allow only this validated head/base and measured diff. Explain why splitting would be harmful. Tests, two QA reviews and merge gates remain required; changed source requires a new decision.',
    ),
  ],
  acknowledge: [
    phrase('Acknowledge'),
    phrase('Record that you have seen this exact revision. It remains blocked until resolved.'),
  ],
  investigate: [
    phrase('Ask the lead'),
    phrase(
      'Queue one bounded, read-only lead diagnosis. The lead returns evidence, a recommended action and any question for you, then spins down.',
    ),
  ],
  repair: [
    phrase('Send to owner'),
    phrase(
      'Return this scope to its original developer with your instructions. Source and evidence are preserved; new work requires fresh reviews.',
    ),
  ],
  review: [
    phrase('Request fresh QA'),
    phrase(
      'Review the latest published source independently. Existing approvals are cleared. This does not approve or merge the PR.',
    ),
  ],
  verify: [
    phrase('Verify merged main'),
    phrase(
      'Explicitly accept investigation of this confirmed external merge through final merged-main checks. Missing pre-merge factory approvals remain missing; no approval is fabricated.',
    ),
  ],
  wait: [
    phrase('Wait for decision'),
    phrase('Keep this delivery parked with a clear question or reason. No model process is kept open while waiting.'),
  ],
} as const);
/** Durable triage action, validated again by the backend. */
export type TriageAction = keyof typeof TRIAGE_ACTIONS;
/** Bound the visible queue; full delivery history remains available. */
const CARD_LIMIT = 40;
/** Short human-readable card titles. */
const TITLE_LIMIT = 160;
/** Exact native Git SHA-1 identity accepted by the operator adoption gate. */
const COMMIT_LENGTH = 40;

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
    return t('Needs attention');
  }
  if (number(latest, 'version') !== number(task, 'version') && text(latest, 'state') !== 'applied') {
    return t('Evidence changed');
  }
  const labels: Record<string, string> = {
    queued: t('Lead queued'),
    acknowledged: t('Acknowledged'),
    awaiting_operator: t('Your decision'),
    applied: t('Action queued'),
    stale: t('Evidence changed'),
    failed: t('Investigation failed'),
  };
  return labels[text(latest, 'state')] ?? t('Needs attention');
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
  const label = issueLabel(task);
  // Only a GitHub issue has a GitHub page; another tracker's key is shown without a link.
  if (!label.startsWith('#')) {
    row.append(element('span', '', t('ISSUE {issue}', { issue: label })));
  } else if (/^[\w\-.]+\/[\w\-.]+$/v.test(repository)) {
    const issue = element('a', '', t('ISSUE {issue}', { issue: label }));
    issue.href = `https://github.com/${repository}/issues/${String(number(task, 'issue'))}`;
    issue.target = '_blank';
    issue.rel = 'noopener noreferrer';
    row.append(issue);
  }
  const raw = text(task, 'prUrl');
  if (raw.startsWith('https://github.com/')) {
    const link = element('a', '', t('PR {pr}', { pr: number(task, 'pr') }));
    link.href = raw;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    row.append(link);
  }
  const owner = text(task, 'developer');
  const ownerName = owner === '' ? t('unassigned') : owner;
  row.append(element('span', 'subtle', t('OWNER {owner}', { owner: ownerName })));
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
  const signal = element('span', 'triage-signal', '\u{203A}');
  signal.setAttribute('aria-hidden', 'true');
  summary.append(
    signal,
    element('span', 'triage-title', `${issueLabel(task)} ${text(task, 'title')}`),
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
    body.append(element('h4', '', t('Latest disposition')), renderReport(text(decision, 'note')));
    if (text(decision, 'summary') !== '') {
      body.append(element('h4', '', t('Lead diagnosis & next action')), renderReport(text(decision, 'summary')));
    }
  }
  const gate = child(task, 'publicationGate');
  if (text(gate, 'head') !== '') {
    const measurement = element(
      'p',
      'notice',
      t(
        'Validated size: {lines} changed lines / {files} files. Approval covers only head {head} against base {base}.',
        {
          lines: number(gate, 'lines'),
          files: number(gate, 'files'),
          head: text(gate, 'head'),
          base: text(gate, 'base'),
        },
      ),
    );
    body.append(measurement);
  }
  const controls = element('div', 'triage-actions');
  const isOwned = records(state.factory['jobs']).some(
    (job) => text(job, 'state') === 'running' && text(job, 'taskId') === text(task, 'id'),
  );
  for (const action of [
    'acknowledge',
    'investigate',
    'repair',
    'review',
    'verify',
    'wait',
    'approve_size',
    'adopt_merge',
  ] as const) {
    const button = element('button', 'triage-action', TRIAGE_ACTIONS[action][0]);
    button.type = 'button';
    button.title = TRIAGE_ACTIONS[action][1];
    button.disabled = isOwned || isActionUnavailable(task, action);
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
        t('An assignment owns this delivery. Inspect or safely cancel it in Workers before changing its disposition.'),
      ),
    );
  }
  const details = element('details', 'triage-evidence');
  details.dataset['queueKey'] = `report:${id}`;
  details.append(element('summary', '', t('Read complete blocker report')), renderReport(error));
  body.append(controls, details);
  card.append(summary, body);
  return card;
}

/**
 * Hide unsafe stage transitions while the backend remains authoritative.
 *
 * @param task - Selected delivery snapshot.
 * @param action - Explicit disposition.
 * @returns Whether required stage evidence is unavailable.
 */
function isActionUnavailable(task: Data, action: TriageAction): boolean {
  return (
    (action === 'adopt_merge' && task['merge'] !== null) ||
    (action === 'approve_size' && (text(task, 'phase') !== 'blocked' || task['publicationGate'] === undefined)) ||
    (action === 'verify'
      ? task['merge'] === null
      : action === 'review' && (task['pr'] === null || task['merge'] !== null))
  );
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
  panel.setAttribute('aria-label', t('Dispatcher triage'));
  const tasks = records(state.factory['tasks']).filter((task) => {
    return (
      task['scopeReplacement'] === undefined &&
      text(task, 'phase') !== 'done' &&
      (text(task, 'phase') === 'blocked' || text(task, 'error') !== '')
    );
  });
  const header = element('header', 'triage-header');
  header.append(
    element('span', 'eyebrow', t('DISPATCH / FINISH FIRST')),
    element('h2', '', t('Clear the path.')),
    element('span', 'pill', t('{length} need attention', { length: tasks.length })),
  );
  const description = t(
    hasFlag(state.factory, 'active')
      ? 'Supervisor enabled. Existing PR reviews, repairs and verification take priority. Roles spin down while decisions wait.'
      : 'Factory paused. Decisions are saved; jobs start after you resume.',
  );
  panel.append(header, element('p', 'subtle', description));
  const admission = dispatchSummary({ ...state.factory, tasks: [], error: '' }).slice(1);
  for (const message of admission) {
    panel.append(element('p', 'notice', message));
  }
  const error = text(state.factory, 'error');
  if (error !== '') {
    const report = element('details', 'triage-evidence');
    report.append(element('summary', '', t('Supervisor diagnostic')), renderReport(error));
    panel.append(report);
  }
  const decisions = records(state.factory['triage']);
  if (tasks.length === 0) {
    panel.append(element('p', 'triage-clear', t('✓ No delivery blockers awaiting attention.')));
  }
  for (const task of tasks.slice(0, CARD_LIMIT)) {
    panel.append(blockerCard(task, { state, actions, decisions }));
  }
  if (tasks.length > CARD_LIMIT) {
    panel.append(element('p', 'subtle', t('Additional scopes are available in the delivery board.')));
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
  description: EditorDescription;
  action: { operation: string; input: (body: string) => unknown };
} {
  let readCommit = emptyCommit;
  return {
    description: {
      title: t('{action} · issue {issue}', {
        action: TRIAGE_ACTIONS[action][0],
        issue: issueLabel(task),
      }),
      explanation: TRIAGE_ACTIONS[action][1],
      initial: action === 'acknowledge' ? t('Reviewed the current blocker.') : '',
      mount: () => {
        if (action === 'adopt_merge') {
          readCommit = mountAdoptionField();
        }
      },
    },
    action: {
      operation: 'factory_triage',
      input: (note) => {
        const mergeCommit = readCommit().trim();
        if (action === 'adopt_merge' && (!/^[\da-f]{40}$/v.test(mergeCommit) || note.trim() === '')) {
          throw new TypeError('Enter a full 40-character lowercase commit SHA and explain why it delivers this issue.');
        }
        return {
          requestId: decisionIdentity(task, action, JSON.stringify([note, mergeCommit])),
          taskId: text(task, 'id'),
          expectedVersion: number(task, 'version'),
          action,
          note,
          ...(action === 'adopt_merge' && { mergeCommit }),
        };
      },
    },
  };
}

/**
 * Collect an explicit commit without making operators edit a JSON payload.
 *
 * @returns Current native field value; the backend validates it again.
 * @throws {TypeError} When the shared operator editor is unavailable.
 */
function mountAdoptionField(): () => string {
  const body = document.querySelector('#editor-body');
  if (!(body instanceof HTMLTextAreaElement)) {
    throw new TypeError('The operator editor is unavailable.');
  }
  document.querySelector('[data-editor-fields]')?.remove();
  const panel = element('section', 'connection-fields');
  panel.dataset['editorFields'] = 'adopt-merge';
  const input = element('input');
  input.id = 'triage-merge-commit';
  input.type = 'text';
  input.pattern = '[0-9a-f]{40}';
  input.maxLength = COMMIT_LENGTH;
  input.required = true;
  input.autocomplete = 'off';
  input.spellcheck = false;
  const label = element('label', '', t('External merge commit (full SHA)'));
  label.htmlFor = input.id;
  panel.append(
    label,
    input,
    element(
      'p',
      'subtle',
      t(
        'Use the selected repository’s merged main. Verification must pass before completion; this does not grant an approval or merge a PR.',
      ),
    ),
  );
  body.before(panel);
  return () => input.value;
}

/**
 * Other dispositions do not carry a commit identity.
 *
 * @returns Empty optional field.
 */
function emptyCommit(): string {
  return '';
}

/** Exact retry identities survive closing/reopening an uncertain editor, bounded in memory only. */
const decisionIds = new Map<string, string>();
/** Maximum explicit recent intents retained per browser session. */
const DECISION_LIMIT = 100;

/**
 * A changed payload is a new intent; an unchanged retry reuses its durable receipt identity.
 *
 * @param task - Exact delivery revision.
 * @param action - Explicit operator disposition.
 * @param note - Reviewed payload.
 * @returns Stable identity for this exact intent.
 */
function decisionIdentity(task: Data, action: TriageAction, note: string): string {
  const key = JSON.stringify([text(task, 'id'), number(task, 'version'), action, note]);
  const known = decisionIds.get(key);
  if (known !== undefined) {
    return known;
  }
  const id = crypto.randomUUID();
  decisionIds.set(key, id);
  if (decisionIds.size > DECISION_LIMIT) {
    const oldest = decisionIds.keys().next().value;
    if (oldest !== undefined) {
      decisionIds.delete(oldest);
    }
  }
  return id;
}
