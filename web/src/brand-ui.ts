/**
 * Original isometric MALT illustrations, rendered with native SVG and CSS.
 * Decorative motion is separate from the factual factory metrics.
 *
 * @file
 */

import { records, text } from './api.js';
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
    { title: 'Queued', phases: ['queued'] },
    { title: 'In progress', phases: ['refining', 'provisioning', 'active'] },
    { title: 'Needs attention', phases: ['blocked'] },
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
      'Active agents',
      jobs.filter((job) => text(job, 'state') === 'running').length,
      'cyan',
      'bounded live assignments',
    ],
    ['Delivered', tasks.filter((task) => text(task, 'phase') === 'done').length, 'green', 'verified on merged main'],
    [
      'Unstarted deliveries',
      tasks.filter((task) => text(task, 'phase') === 'ready').length,
      'violet',
      'may await dependencies or capacity',
    ],
    ['Pending objectives', pendingObjectives(features).length, 'cyan', 'product requests not yet delivered'],
    [
      'Blocked',
      tasks.filter((task) => text(task, 'phase') === 'blocked' && task['scopeCleanup'] === undefined).length +
        features.filter((feature) => text(feature, 'phase') === 'blocked').length,
      '',
      'requires a concrete resolution',
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

/** Keep full objectives reachable behind compact titles. */
const OBJECTIVE_TITLE = 160;

/**
 * Render all unfinished work, followed by a collapsed completed archive.
 *
 * @param objectives - Complete factory feature snapshot.
 * @param actions - Operator retry controls.
 * @returns Queue body and truthful unfinished total.
 */
export function objectiveQueue(objectives: Data[], actions: Actions): { body: HTMLElement; unfinished: number } {
  const body = element('div', 'panel-body');
  if (objectives.length === 0) {
    body.append(
      element('h3', '', 'The next mission starts here'),
      element(
        'p',
        'subtle',
        'Add an objective. Your product owner and lead will prepare small, verifiable deliveries.',
      ),
    );
  }
  const groups = objectiveGroups(objectives);
  const completed = element('details', 'objective-completed');
  completed.dataset['queueKey'] = 'completed';
  const count = groups.find((group) => group.title === 'Completed')?.items.length ?? 0;
  const summary = element('summary', '', `Completed (${String(count)})`);
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
      section.append(objectiveRow(feature, actions));
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
    const summary = element('summary', '', 'Read full objective');
    summary.dataset['queueFocus'] = `objective:${id}`;
    detail.append(summary, element('p', 'subtle', objective));
    row.append(detail);
  }
  if (!isReplaced && text(feature, 'phase') === 'blocked') {
    const retry = element('button', 'small-button', 'Retry resolved request');
    retry.type = 'button';
    retry.addEventListener('click', () => {
      actions.retry(id, true);
    });
    retry.dataset['queueFocus'] = `retry:${id}`;
    row.append(element('p', 'subtle', text(feature, 'error')), retry);
  }
  return row;
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
