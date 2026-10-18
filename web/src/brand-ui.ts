/**
 * Original isometric MALT illustrations, rendered with native SVG and CSS.
 * Decorative motion is separate from the factual factory metrics.
 *
 * @file
 */
import { records, text, child, number, hasFlag } from './api.js';
import { formatDateTime, t } from './i18n.js';
import { focusDescription } from './recovery-ui.js';
import { element } from './worker-ui.js';

import type { Data } from './api.js';
import type { Actions } from './views.js';

/** Original line motifs for process, verified delivery, queue and blocker cards. */
const MOTIFS = [
  'M58 66L90 84L122 66M90 84V110M58 66V88M122 66V88',
  'M62 80L82 98L120 62',
  'M58 66L90 84L122 66M58 78L90 96L122 78M58 90L90 108L122 90',
  'M70 80V66C70 45 110 45 110 66V80M64 80H116V111H64ZM90 92V101',
] as const;
/** Fixed namespace, with no markup/string injection or external asset loading. */
const SVG_NS = 'http://www.w3.org/2000/svg';
/** Bound overview blocker text while retaining full evidence in artifacts. */
const BLOCKER_EXCERPT = 500;

/**
 * Format an observed reset time.
 *
 * @param milliseconds - Persisted accounting timestamp.
 * @returns Local display time.
 */
function resetLabel(milliseconds: number): string {
  const date = new Date(milliseconds);
  return formatDateTime(date);
}

/**
 * Build a safe native SVG element from internal static attributes.
 *
 * @param tag - SVG element name.
 * @param attributes - Internal drawing attributes.
 * @returns SVG node.
 */
function shape<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attributes: Readonly<Record<string, string>>,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) {
    node.setAttribute(name, value);
  }
  return node;
}

/**
 * Draw an original floating network crate; CSS respects reduced motion.
 *
 * @param index - Trusted metric order, not external project text.
 * @returns Decorative illustration, excluded from the accessibility tree.
 */
export function metricArtwork(index: number): SVGSVGElement {
  const artwork = shape('svg', {
    viewBox: '0 0 180 160',
    class: 'metric-art',
    'aria-hidden': 'true',
    focusable: 'false',
  });
  artwork.append(shape('ellipse', { cx: '90', cy: '145', rx: '60', ry: '8', class: 'art-shadow' }));
  const body = shape('g', { class: 'art-float' });
  body.append(
    shape('path', { d: 'M30 50L90 18L150 50L90 82ZM30 50V98L90 130L150 98V50M90 82V130', class: 'art-crate' }),
    shape('path', { d: MOTIFS[index] ?? MOTIFS[0], class: 'art-motif' }),
    shape('path', { d: 'M20 126L45 140H135L160 126', class: 'art-flow' }),
  );
  artwork.append(body);
  return artwork;
}

/**
 * Objectives still awaiting delivery, excluding finished and scope-replaced requests.
 *
 * @param objectives - Product objectives in original order.
 * @returns Pending objectives in original order.
 */
function pendingObjectives(objectives: Data[]): Data[] {
  return objectives.filter((feature) => text(feature, 'phase') !== 'done' && feature['scopeReplacement'] === undefined);
}

/**
 * Group the complete snapshot without letting completed work hide unfinished work.
 *
 * @param objectives - Product objectives in original order.
 * @returns Phase groups, with completed and scope-replaced records last.
 */
export function objectiveGroups(objectives: Data[]): { title: string; items: Data[] }[] {
  const groups = [
    { title: t('Queued'), phases: ['queued'] },
    { title: t('In progress'), phases: ['refining', 'provisioning', 'active'] },
    { title: t('Needs attention'), phases: ['blocked'] },
    { title: 'Completed', phases: ['done'] },
  ];
  const current = objectives.filter((feature) => feature['scopeReplacement'] === undefined);
  return [
    ...groups.map(({ title, phases }) => {
      return {
        title,
        items: current.filter((feature) => phases.includes(text(feature, 'phase'))),
      };
    }),
    {
      title: 'Scope replaced (superseded)',
      items: objectives.filter((feature) => feature['scopeReplacement'] !== undefined),
    },
  ];
}

/**
 * Present factual backend counts with distinct original decorative artwork.
 *
 * @param factory - Authenticated factory state.
 * @returns Semantic metric cards.
 */
export function overviewMetrics(factory: Data): HTMLElement {
  const metrics = element('div', 'metrics');
  const jobs = records(factory['jobs']);
  const tasks = records(factory['tasks']);
  const features = records(factory['features']);
  const values = [
    [
      t('Active agents'),
      jobs.filter((job) => text(job, 'state') === 'running').length,
      'cyan',
      t('bounded live assignments'),
    ],
    [
      t('Delivered'),
      tasks.filter((task) => text(task, 'phase') === 'done').length,
      'green',
      t('verified on merged main'),
    ],
    [
      t('Unstarted deliveries'),
      tasks.filter((task) => text(task, 'phase') === 'ready').length,
      'violet',
      t('may await dependencies or capacity'),
    ],
    [t('Pending objectives'), pendingObjectives(features).length, 'cyan', t('product requests not yet delivered')],
    [
      t('Blocked'),
      tasks.filter((task) => text(task, 'phase') === 'blocked' && task['scopeCleanup'] === undefined).length +
        features.filter((feature) => text(feature, 'phase') === 'blocked').length,
      '',
      t('requires a concrete resolution'),
    ],
  ] as const;
  for (const [index, [label, count, color, note]] of values.entries()) {
    const item = element('div', 'metric');
    item.append(
      element('div', 'metric-label', label),
      element('div', `metric-value ${color}`, String(count)),
      element('div', 'metric-note', note),
      metricArtwork(index),
    );
    metrics.append(item);
  }
  return metrics;
}

/**
 * Explain quiet dispatch using actual settings and provider accounting.
 *
 * @param factory - Authenticated project factory snapshot.
 * @returns Logical coordinator state and concrete current blockers.
 */
export function dispatchSummary(factory: Data): string[] {
  const messages = [
    t(
      hasFlag(factory, 'active')
        ? 'Supervisor enabled. Product owner and lead are scheduled when work is eligible; they do not keep idle model processes running.'
        : 'Factory paused. Start the factory to dispatch queued work.',
    ),
  ];
  const error = text(factory, 'error');
  if (error !== '') {
    messages.push(error);
  }
  const providers = child(child(factory, 'settings'), 'providers');
  const capacities = records(factory['capacities']);
  for (const capacity of capacities) {
    const provider = text(capacity, 'provider');
    const policy = child(providers, provider);
    const budget = number(policy, 'budgetTokens');
    const pending =
      number(capacity, 'usedTokens') + number(capacity, 'reservedTokens') + number(policy, 'reservationTokens');
    if (budget > 0 && pending > budget && number(capacity, 'resetAt') > Date.now()) {
      const resets = resetLabel(number(capacity, 'resetAt'));
      messages.push(
        t(
          '{provider}: configured scheduling budget exhausted; resets {resets}. This is separate from subscription quota.',
          { provider, resets },
        ),
      );
    }
    if (number(capacity, 'cooldownUntil') <= Date.now()) {
      continue;
    }
    const until = resetLabel(number(capacity, 'cooldownUntil'));
    messages.push(t('{provider}: provider cooldown until {until}.', { provider, until }));
  }
  const blocked = records(factory['tasks']).filter(
    (task) => text(task, 'phase') === 'blocked' && task['scopeReplacement'] === undefined,
  );
  for (const task of blocked) {
    const blocker = readableBlocker(text(task, 'error'));
    messages.push(t('Issue #{issue} blocked: {blocker}', { issue: number(task, 'issue'), blocker }));
  }
  return messages;
}

/**
 * Describe a known harness failure without inventing a model diagnosis.
 *
 * @param error - Durable technical evidence, rendered separately in full.
 * @returns Bounded operator explanation with an explicit continuation marker.
 */
function readableBlocker(error: string): string {
  if (error.includes('No current managed source claim')) {
    return t(
      'QA cannot inspect the PR because its read-only assignment claim is missing or expired. This is a review-access blocker, not an approval or confirmed code defect. Restore the owned claim and rerun independent QA on the same commits.',
    );
  }
  if (error.includes('truncated:true') || error.includes('essential source remains inaccessible')) {
    return t(
      'QA cannot finish because its read-only tool cannot open large source files. This is an inspection-tool blocker, not a confirmed code defect. Repair source paging, then rerun independent QA on the same commits.',
    );
  }
  const first = error.split('\n', 1)[0] ?? '';
  return first.length > BLOCKER_EXCERPT
    ? t('{excerpt}… Read the technical details below.', { excerpt: first.slice(0, BLOCKER_EXCERPT) })
    : first;
}

/**
 * Present concise blocker meaning while preserving full exact evidence.
 *
 * @param factory - Authenticated project state.
 * @returns Keyboard-accessible overview with expandable technical reports.
 */
export function dispatchPanel(factory: Data): HTMLElement {
  const panel = element('section', 'notice');
  panel.append(element('h2', '', t('Coordinator & dispatch')));
  for (const message of dispatchSummary(factory)) {
    panel.append(element('p', '', message));
  }
  const tasks = records(factory['tasks']);
  for (const task of tasks) {
    if (text(task, 'phase') !== 'blocked' || task['scopeReplacement'] !== undefined) {
      continue;
    }
    const details = element('details', 'blocker-details');
    const issue = String(number(task, 'issue'));
    details.append(
      element('summary', '', t('Technical details for issue #{issue}', { issue })),
      element('pre', '', text(task, 'error')),
    );
    panel.append(details);
  }
  return panel;
}

/** Keep full objectives reachable behind compact titles. */
const OBJECTIVE_TITLE = 160;

/**
 * Render all unfinished work, followed by a collapsed completed archive.
 *
 * @param objectives - Complete factory feature snapshot.
 * @param actions - Operator retry controls.
 * @param queue - Durable operator priority and focus snapshot.
 * @returns Queue body and truthful unfinished total.
 */
export function objectiveQueue(
  objectives: Data[],
  actions: Actions,
  queue: Data = {},
): { body: HTMLElement; unfinished: number } {
  const body = element('div', 'panel-body');
  if (objectives.length === 0) {
    body.append(
      element('h3', '', t('The next mission starts here')),
      element(
        'p',
        'subtle',
        t('Add an objective. Your product owner and lead will prepare small, verifiable deliveries.'),
      ),
    );
  }
  const order = Array.isArray(queue['order'])
    ? queue['order'].filter((id): id is string => typeof id === 'string')
    : objectives.map((feature) => text(feature, 'id'));
  const ranks = new Map(order.map((id, index) => [id, index]));
  const ordered = objectives.toSorted(
    (left, right) => (ranks.get(text(left, 'id')) ?? ranks.size) - (ranks.get(text(right, 'id')) ?? ranks.size),
  );
  const unfinishedItems = pendingObjectives(ordered);
  const focus = text(queue, 'focusedFeatureId');
  const revision = number(queue, 'revision');
  body.append(
    element(
      'p',
      'subtle',
      t(
        'Priority applies to new assignments. Running work finishes safely. Blocked work stays blocked until resolved and explicitly retried.',
      ),
    ),
  );
  if (focus !== '') {
    const notice = element('div', 'notice');
    const focusedObjective = ordered.find((item) => text(item, 'id') === focus) ?? {};
    const focusedTitle = text(focusedObjective, 'objective').slice(0, OBJECTIVE_TITLE);
    notice.append(element('p', '', focusDescription(queue, focusedTitle)));
    const release = element('button', 'small-button', t('Resume all objectives'));
    release.type = 'button';
    release.addEventListener('click', () => {
      actions.queue(order, null, revision);
    });
    notice.append(release);
    body.append(notice);
  }
  const groups = [
    { title: 'Dispatch priority', items: unfinishedItems },
    ...objectiveGroups(ordered).filter(
      (group) => group.title === 'Completed' || group.title === 'Scope replaced (superseded)',
    ),
  ];
  const completed = element('details', 'objective-completed');
  completed.dataset['queueKey'] = 'completed';
  const count = groups.find((group) => group.title === 'Completed')?.items.length ?? 0;
  const summary = element('summary', '', t('Completed ({count})', { count }));
  summary.dataset['queueFocus'] = 'completed';
  completed.append(summary);
  let unfinished = 0;
  for (const group of groups) {
    if (group.items.length === 0) {
      continue;
    }
    const section = element('section', 'objective-group');
    section.setAttribute('aria-label', group.title);
    section.append(element('h3', '', `${group.title} (${String(group.items.length)})`));
    for (const feature of group.items) {
      const row = objectiveRow(feature, actions);
      if (group.title === 'Dispatch priority') {
        appendQueueControls(row, feature, { order, focus, revision, unfinished: unfinishedItems }, actions);
      }
      section.append(row);
    }
    if (group.title === 'Completed' || group.title === 'Scope replaced (superseded)') {
      completed.append(section);
    } else {
      unfinished += group.items.length;
      body.append(section);
    }
  }
  if (completed.children.length > 1) {
    body.append(completed);
  }
  return { body, unfinished };
}

/**
 * Render safe objective text and native keyboard controls with stable refresh keys.
 *
 * @param feature - Persisted product request.
 * @param actions - Authorized operator controls.
 * @returns Native article with stable interaction keys.
 */
function objectiveRow(feature: Data, actions: Actions): HTMLElement {
  const row = element('article', 'lesson');
  const id = text(feature, 'id');
  row.dataset['featureId'] = id;
  const objective = text(feature, 'objective');
  const isReplaced = feature['scopeReplacement'] !== undefined;
  row.append(
    element('span', 'pill', isReplaced ? 'superseded' : text(feature, 'phase')),
    element('h3', '', objective.slice(0, OBJECTIVE_TITLE)),
  );
  if (objective.length > OBJECTIVE_TITLE) {
    const detail = element('details');
    detail.dataset['queueKey'] = `objective:${id}`;
    const summary = element('summary', '', t('Read full objective'));
    summary.dataset['queueFocus'] = `objective:${id}`;
    detail.append(summary, element('p', 'subtle', objective));
    row.append(detail);
  }
  if (!isReplaced && text(feature, 'phase') === 'blocked') {
    const retry = element('button', 'small-button', t('Retry resolved request'));
    retry.type = 'button';
    retry.addEventListener('click', () => {
      actions.retry(id, true);
    });
    retry.dataset['queueFocus'] = `retry:${id}`;
    row.append(element('p', 'subtle', text(feature, 'error')), retry);
  }
  return row;
}

/**
 * Give each unfinished objective keyboard-operable priority and focus controls.
 *
 * @param row - Safe objective article.
 * @param feature - Actual project objective.
 * @param state - Current complete order and concurrency revision.
 * @param actions - Authenticated controller boundary.
 */
function appendQueueControls(
  row: HTMLElement,
  feature: Data,
  state: { order: string[]; focus: string; revision: number; unfinished: Data[] },
  actions: Actions,
): void {
  const id = text(feature, 'id');
  const index = state.unfinished.findIndex((item) => text(item, 'id') === id);
  const controls = element('div', 'objective-controls');
  controls.append(element('span', 'pill', t('Priority {priority}', { priority: index + 1 })));
  const options = [
    [t('Move first'), 0],
    [t('Move up'), index - 1],
    [t('Move down'), index + 1],
  ] as const;
  for (const [label, destination] of options) {
    const button = element('button', 'small-button', label);
    button.type = 'button';
    button.disabled = destination < 0 || destination >= state.unfinished.length || destination === index;
    button.setAttribute('aria-label', `${label}: ${text(feature, 'objective').slice(0, OBJECTIVE_TITLE)}`);
    button.dataset['queueFocus'] = `${label}:${id}`;
    button.addEventListener('click', () => {
      const target = state.unfinished[destination];
      if (target === undefined) {
        return;
      }
      const order = state.order.filter((item) => item !== id);
      const targetId = text(target, 'id');
      const targetIndex = order.indexOf(targetId);
      order.splice(targetIndex + (destination > index ? 1 : 0), 0, id);
      actions.queue(order, state.focus === '' ? null : state.focus, state.revision);
    });
    controls.append(button);
  }
  const focus = element('button', 'small-button', t(state.focus === id ? 'Focused' : 'Focus only this objective'));
  focus.type = 'button';
  focus.disabled = state.focus === id;
  focus.dataset['queueFocus'] = `focus:${id}`;
  focus.addEventListener('click', () => {
    actions.queue(state.order, id, state.revision);
  });
  controls.append(focus);
  row.append(controls);
}

/** Native queue state isolated to one selected project. */
export class QueueState {
  /** Scope prevents identical feature IDs from leaking between projects. */
  private project = '';
  /** Retain both open and closed choices, including while another view is selected. */
  private readonly details = new Map<string, boolean>();

  /**
   * Replace a view while restoring only the selected project's queue state.
   *
   * @param target - Existing content container.
   * @param next - Newly rendered view.
   * @param project - Selected project identifier.
   */
  public replace(target: HTMLElement, next: HTMLElement, project: string): void {
    const isSameProject = project === this.project;
    let focus = '';
    if (isSameProject) {
      for (const detail of target.querySelectorAll<HTMLDetailsElement>('details[data-queue-key]')) {
        this.details.set(detail.dataset['queueKey'] ?? '', detail.open);
      }
      const active = target.ownerDocument.activeElement;
      if (active instanceof HTMLElement && target.contains(active)) {
        focus = active.dataset['queueFocus'] ?? '';
      }
    } else {
      this.details.clear();
      this.project = project;
    }
    pruneHandoffDetails(this.details, next);
    for (const detail of next.querySelectorAll<HTMLDetailsElement>('details[data-queue-key]')) {
      detail.open = this.details.get(detail.dataset['queueKey'] ?? '') ?? false;
    }
    target.replaceChildren(next);
    if (focus === '') {
      return;
    }
    const control = target.querySelector<HTMLElement>(`[data-queue-focus="${CSS.escape(focus)}"]`);
    control?.focus({ preventScroll: true });
  }
}

/**
 * Retain at most the displayed feed's disclosure choices, without clearing other view state.
 *
 * @param choices - Current project's native disclosure choices.
 * @param next - New view; unrelated views do not evict the last bounded feed.
 */
function pruneHandoffDetails(choices: Map<string, boolean>, next: HTMLElement): void {
  if (next.querySelector('.handoff-feed') === null && !next.classList.contains('handoff-feed')) {
    return;
  }
  const visible = new Set(
    Array.from(next.querySelectorAll<HTMLElement>('[data-queue-key]'), (node) => node.dataset['queueKey'] ?? ''),
  );
  for (const key of choices.keys()) {
    if (key.startsWith('handoff:') && !visible.has(key)) {
      choices.delete(key);
    }
  }
}
