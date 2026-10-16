/**
 * Local pull requests, issue board and diff review for GitHub-free delivery.
 * Every value is untrusted plain text; nothing is parsed as HTML. Mutations are
 * routed by the controller through the single broker-owned ledger writer.
 *
 * @file
 */
import { child, number, records, text } from './api.js';
import { element } from './worker-ui.js';

import type { Data } from './api.js';

/** Board columns in delivery order. */
const COLUMNS = [
  'Backlog',
  'Ready',
  'Development',
  'QA / Review',
  'Merge Ready',
  'Final Verification',
  'Done',
  'Blocked',
] as const;
/** Short commit identity for display only. */
const SHORT_HEAD = 8;
/** Leading fields of a hunk header: marker, old range, new range. */
const HUNK_FIELDS = 3;
/** Diff lines rendered per file before collapsing the rest behind a toggle. */
const FILE_LINE_LIMIT = 400;

/** Controller-owned local delivery interactions. */
export interface PullActions {
  /** Select a pull request and load its diff. */
  readonly select: (pull: number) => void;
  /** Fast-forward the operator checkout from the hub. */
  readonly sync: () => void;
  /** Create a feature parent. */
  readonly createFeature: () => void;
  /** Create a Ready delivery under a feature. */
  readonly createDelivery: (parent: number) => void;
  /** Comment on an issue or pull request. */
  readonly comment: (target: number) => void;
  /** Move an issue to another column. */
  readonly move: (issue: number, status: string) => void;
}

/** Selected pull-request detail, loaded on demand. */
export interface PullSelection {
  /** Selected pull-request number. */
  readonly number: number | null;
  /** Loaded detail, null while loading or unavailable. */
  readonly detail: Data | null;
  /** Load failure text. */
  readonly error: string;
}

/** One parsed file section of a unified diff. */
interface DiffFile {
  /** Display path. */
  readonly path: string;
  /** Added line count. */
  added: number;
  /** Removed line count. */
  removed: number;
  /** Rendered rows. */
  readonly rows: DiffRow[];
}
/** One rendered diff row. */
interface DiffRow {
  /** Row kind for styling. */
  readonly kind: 'add' | 'del' | 'ctx' | 'hunk';
  /** Old line number, empty for additions and hunks. */
  readonly old: string;
  /** New line number, empty for deletions and hunks. */
  readonly new: string;
  /** Line text without the diff marker. */
  readonly text: string;
}

/**
 * Create a native button.
 *
 * @param title - Accessible label.
 * @param action - Controller callback.
 * @param cssClass - Trusted style.
 * @returns Button element.
 */
function button(title: string, action: () => void, cssClass = 'small-button'): HTMLButtonElement {
  const node = element('button', cssClass, title);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}

/**
 * Parse a hunk header's starting line numbers.
 *
 * @param header - `@@ -a,b +c,d @@` line.
 * @returns Old and new starting lines.
 */
function hunkStart(header: string): { old: number; new: number } {
  const [, removed = '-0', added = '+0'] = header.split(' ', HUNK_FIELDS);
  return { old: rangeStart(removed), new: rangeStart(added) };
}

/**
 * Read the first line number of a hunk range such as `-12,5`.
 *
 * @param range - Signed range from a hunk header.
 * @returns Starting line, zero when unreadable.
 */
function rangeStart(range: string): number {
  const value = Number(range.slice(1).split(',', 1)[0]);
  return Number.isSafeInteger(value) ? value : 0;
}

/**
 * Split a unified Git diff into files and numbered rows.
 *
 * @param diff - Unified diff text.
 * @returns Parsed files.
 */
export function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  let line = { old: 0, new: 0 };
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      const [name = raw] = raw.slice('diff --git a/'.length).split(' b/', 1);
      current = { path: name, added: 0, removed: 0, rows: [] };
      files.push(current);
    } else if (current !== null && raw.startsWith('@@')) {
      line = hunkStart(raw);
      current.rows.push({ kind: 'hunk', old: '', new: '', text: raw });
    } else if (current !== null && current.rows.length > 0) {
      appendRow(current, raw, line);
    }
  }
  return files;
}

/**
 * Append one content row and advance line counters.
 *
 * @param file - File section receiving the row.
 * @param raw - Diff line.
 * @param line - Mutable line counters.
 */
function appendRow(file: DiffFile, raw: string, line: { old: number; new: number }): void {
  const counters = line;
  const target = file;
  if (raw.startsWith('+')) {
    target.added += 1;
    target.rows.push({ kind: 'add', old: '', new: String(counters.new), text: raw.slice(1) });
    counters.new += 1;
  } else if (raw.startsWith('-')) {
    target.removed += 1;
    target.rows.push({ kind: 'del', old: String(counters.old), new: '', text: raw.slice(1) });
    counters.old += 1;
  } else if (raw.startsWith(' ')) {
    target.rows.push({ kind: 'ctx', old: String(counters.old), new: String(counters.new), text: raw.slice(1) });
    counters.old += 1;
    counters.new += 1;
  }
}

/**
 * Render one diff row.
 *
 * @param row - Parsed row.
 * @returns Table row.
 */
function diffRow(row: DiffRow): HTMLTableRowElement {
  const node = element('tr', `diff-${row.kind}`);
  const marker = { add: '+', del: '−', ctx: '', hunk: '' }[row.kind];
  node.append(
    element('td', 'diff-number', row.old),
    element('td', 'diff-number', row.new),
    element('td', 'diff-marker', marker),
    element('td', 'diff-text', row.text),
  );
  return node;
}

/**
 * Render a parsed diff with per-file headers and bounded expansion.
 *
 * @param diff - Unified diff text.
 * @param isTruncated - Whether the server bounded the diff.
 * @returns Diff element.
 */
export function diffView(diff: string, isTruncated: boolean): HTMLElement {
  const container = element('div', 'diff');
  const files = parseDiff(diff);
  if (files.length === 0) {
    container.append(element('p', 'subtle', 'No changes to display.'));
    return container;
  }
  for (const file of files) {
    const details = element('details', 'diff-file');
    details.open = true;
    const summary = element('summary', 'diff-file-head');
    summary.append(
      element('span', 'diff-path', file.path),
      element('span', 'diff-added', `+${String(file.added)}`),
      element('span', 'diff-removed', `−${String(file.removed)}`),
    );
    const table = element('table', 'diff-table');
    table.setAttribute('aria-label', `Changes in ${file.path}`);
    const body = element('tbody');
    body.append(...file.rows.slice(0, FILE_LINE_LIMIT).map((row) => diffRow(row)));
    table.append(body);
    details.append(summary, table);
    if (file.rows.length > FILE_LINE_LIMIT) {
      const rest = file.rows.slice(FILE_LINE_LIMIT);
      const more = button(`Show ${String(rest.length)} more lines`, () => {
        body.append(...rest.map((row) => diffRow(row)));
        more.remove();
      });
      details.append(more);
    }
    container.append(details);
  }
  if (isTruncated) {
    container.append(
      element('p', 'error', 'This diff was truncated for display. Inspect the branch in Git for the rest.'),
    );
  }
  return container;
}

/**
 * Render comments as a timeline.
 *
 * @param comments - Ledger comments.
 * @returns Timeline element.
 */
function timeline(comments: readonly Data[]): HTMLElement {
  const list = element('ol', 'pull-timeline');
  for (const entry of comments) {
    const item = element('li');
    const at = new Date(number(entry, 'at'));
    item.append(element('time', 'subtle', at.toLocaleString()), element('p', '', text(entry, 'body')));
    list.append(item);
  }
  return list;
}

/**
 * Render gate checks.
 *
 * @param evidence - Gate snapshot.
 * @returns Check list.
 */
function checks(evidence: Data): HTMLElement {
  const list = element('ul', 'pull-checks');
  const rollup = records(evidence['statusCheckRollup']);
  for (const check of rollup) {
    const isPassing = text(check, 'conclusion') === 'SUCCESS';
    const item = element('li', isPassing ? 'check-pass' : 'check-fail');
    item.append(
      element('span', 'check-mark', isPassing ? '✓' : '✗'),
      element('span', '', text(check, 'name')),
      element('span', 'subtle', isPassing ? 'passing' : 'failing'),
    );
    list.append(item);
  }
  if (rollup.length === 0) {
    list.append(element('li', 'subtle', 'Settled pull requests carry no live merge checks.'));
  }
  return list;
}

/**
 * Render the selected pull request.
 *
 * @param selection - Selected record and loaded detail.
 * @param actions - Controller callbacks.
 * @returns Detail pane.
 */
export function detailView(selection: PullSelection, actions: PullActions): HTMLElement {
  const pane = element('section', 'panel pull-detail');
  if (selection.number === null) {
    pane.append(element('p', 'subtle', 'Select a pull request to review its checks, discussion and diff.'));
    return pane;
  }
  if (selection.detail === null) {
    pane.append(
      element(
        'p',
        selection.error === '' ? 'subtle' : 'error',
        selection.error === '' ? 'Loading diff…' : selection.error,
      ),
    );
    return pane;
  }
  const pull = child(selection.detail, 'pull');
  const evidence = child(selection.detail, 'evidence');
  const head = element('header', 'pull-head');
  const state = text(pull, 'state');
  const pullNumber = number(pull, 'number');
  head.append(
    element('h2', '', `#${String(pullNumber)} ${text(pull, 'title')}`),
    element('span', `pill pull-state-${state.toLowerCase()}`, state.toLowerCase()),
  );
  const branch = element(
    'p',
    'pull-branch',
    `${text(pull, 'head')} → ${text(pull, 'base')} · merge ${text(evidence, 'mergeStateStatus').toLowerCase()}`,
  );
  const merged = text(pull, 'mergeCommit');
  if (merged !== '') {
    branch.append(element('span', 'subtle', ` · merged as ${merged.slice(0, SHORT_HEAD)}`));
  }
  const toolbar = element('div', 'ticket-actions');
  toolbar.append(
    button('Comment', () => {
      actions.comment(pullNumber);
    }),
  );
  pane.append(
    head,
    branch,
    element('p', 'pull-body', text(pull, 'body')),
    element('h3', '', 'Checks'),
    checks(evidence),
    element('h3', '', 'Discussion'),
    timeline(records(pull['comments'])),
    toolbar,
    element('h3', '', 'Changes'),
    diffView(text(selection.detail, 'diff'), selection.detail['truncated'] === true),
  );
  return pane;
}

/**
 * Render the pull-request list, open first.
 *
 * @param pulls - Ledger pull requests.
 * @param selected - Selected number.
 * @param actions - Controller callbacks.
 * @returns List element.
 */
function pullList(pulls: readonly Data[], selected: number | null, actions: PullActions): HTMLElement {
  const list = element('ul', 'pull-list');
  const ordered = pulls.toSorted((left, right) => {
    const leftRank = text(left, 'state') === 'OPEN' ? 0 : 1;
    const rightRank = text(right, 'state') === 'OPEN' ? 0 : 1;
    return leftRank === rightRank ? number(right, 'updatedAt') - number(left, 'updatedAt') : leftRank - rightRank;
  });
  for (const pull of ordered) {
    const pullNumber = number(pull, 'number');
    const item = element('li');
    const choose = button(
      `#${String(pullNumber)} ${text(pull, 'title')}`,
      () => {
        actions.select(pullNumber);
      },
      'pull-row',
    );
    choose.setAttribute('aria-pressed', String(pullNumber === selected));
    choose.append(element('span', `pill pull-state-${text(pull, 'state').toLowerCase()}`, text(pull, 'state')));
    item.append(choose);
    list.append(item);
  }
  if (ordered.length === 0) {
    list.append(element('li', 'subtle', 'No pull requests yet. Developers open them after validation.'));
  }
  return list;
}

/**
 * Render one issue card with its column controls.
 *
 * @param issue - Ledger issue.
 * @param actions - Controller callbacks.
 * @returns Card element.
 */
function issueCard(issue: Data, actions: PullActions): HTMLElement {
  const card = element('article', `issue-card issue-${text(issue, 'state')}`);
  const issueNumber = number(issue, 'number');
  const parent = String(number(issue, 'parent'));
  const kind = text(issue, 'kind') === 'feature' ? 'Feature' : `Delivery of #${parent}`;
  card.append(element('h4', '', `#${String(issueNumber)} ${text(issue, 'title')}`), element('p', 'subtle', kind));
  const tools = element('div', 'ticket-actions');
  if (text(issue, 'kind') === 'feature' && text(issue, 'state') === 'open') {
    tools.append(
      button('Add delivery', () => {
        actions.createDelivery(issueNumber);
      }),
    );
  }
  if (text(issue, 'status') === 'Backlog' && text(issue, 'kind') === 'delivery') {
    tools.append(
      button('Mark Ready', () => {
        actions.move(issueNumber, 'Ready');
      }),
    );
  }
  tools.append(
    button('Comment', () => {
      actions.comment(issueNumber);
    }),
  );
  card.append(tools);
  return card;
}

/**
 * Render the issue board by workflow column, hiding empty columns.
 *
 * @param issues - Ledger issues.
 * @param actions - Controller callbacks.
 * @returns Board element.
 */
function board(issues: readonly Data[], actions: PullActions): HTMLElement {
  const container = element('div', 'issue-board');
  for (const column of COLUMNS) {
    const members = issues.filter((issue) => text(issue, 'status') === column);
    if (members.length === 0) {
      continue;
    }
    const lane = element('section', 'issue-lane');
    lane.setAttribute('aria-label', `${column} issues`);
    lane.append(
      element('h3', '', `${column} · ${String(members.length)}`),
      ...members.map((issue) => issueCard(issue, actions)),
    );
    container.append(lane);
  }
  if (issues.length === 0) {
    container.append(element('p', 'subtle', 'No local issues yet. Request an objective or create a feature.'));
  }
  return container;
}

/**
 * Explain how to enable local delivery when the project uses GitHub.
 *
 * @returns Empty state.
 */
function disabled(): HTMLElement {
  const node = element('div', 'empty');
  node.append(
    element('span', 'empty-mark', '◈'),
    element('h2', '', 'Local delivery is off'),
    element(
      'p',
      '',
      'This project delivers through GitHub. To keep issues, pull requests and merges on this machine, pause the factory and set "delivery": "local" and "remote": "malt-hub" in Project setup. MALT creates a protected local hub; only your model subscriptions leave the machine.',
    ),
  );
  return node;
}

/**
 * Render the local delivery workspace.
 *
 * @param local - Ledger summary, null when local delivery is off.
 * @param selection - Selected pull request.
 * @param actions - Controller callbacks.
 * @param detail - Selected pull-request pane, reused across live refreshes.
 * @returns View element.
 */
export function pullsView(
  local: Data | null,
  selection: PullSelection,
  actions: PullActions,
  detail: HTMLElement,
): HTMLElement {
  if (local === null) {
    return disabled();
  }
  const view = element('div', 'pulls-view');
  const toolbar = element('div', 'pulls-toolbar');
  toolbar.append(
    element('span', 'subtle', `Protected hub · ${text(local, 'remote')}/${text(local, 'base')}`),
    button('New feature', actions.createFeature),
    button('Sync my checkout', actions.sync),
  );
  const pulls = records(local['pulls']);
  const issues = records(local['issues']);
  const columns = element('div', 'pulls-columns');
  const listPanel = element('section', 'panel');
  const listHead = element('div', 'panel-head');
  listHead.append(element('h2', '', 'Pull requests'), element('span', 'count', String(pulls.length)));
  listPanel.append(listHead, pullList(pulls, selection.number, actions));
  columns.append(listPanel, detail);
  const boardPanel = element('section', 'panel');
  const boardHead = element('div', 'panel-head');
  boardHead.append(element('h2', '', 'Issues'), element('span', 'count', String(issues.length)));
  boardPanel.append(boardHead, board(issues, actions));
  view.append(toolbar, columns, boardPanel);
  return view;
}
