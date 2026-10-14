/**
 * Original isometric MALT illustrations, rendered with native SVG and CSS.
 * Decorative motion is separate from the factual factory metrics.
 *
 * @file
 */

import { records, text, child, number, hasFlag } from './api.js';
import { element } from './worker-ui.js';

import type { Data } from './api.js';

/** Bound DOM work while showing every ordinary pending queue. */
const OBJECTIVE_PREVIEW = 50;

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
/** Bound DOM work while showing every ordinary pending queue. */
const OBJECTIVE_PREVIEW = 50;

/**
 * Keep pending objectives visible ahead of recent completed outcomes.
 *
 * @param objectives - Actual selected project's objectives.
 * @param completedLimit - Number of recent completed outcomes to retain.
 * @returns Bounded, chronological pending work followed by recent completions.
 */
export function objectivePreview(objectives: Data[], completedLimit: number): Data[] {
  const pending = objectives.filter(
    (feature) => text(feature, 'phase') !== 'done' && feature['scopeReplacement'] === undefined,
  );
  const completed = objectives.filter((feature) => text(feature, 'phase') === 'done').slice(-completedLimit);
  return [...pending.slice(0, OBJECTIVE_PREVIEW), ...completed];
}

/**
 * Format an observed reset time.
 *
 * @param milliseconds - Persisted accounting timestamp.
 * @returns Local display time.
 */
function resetLabel(milliseconds: number): string {
  const date = new Date(milliseconds);
  return date.toLocaleString();
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
 * Select objectives to list: pending ones first so older requests stay visible, then recent completions.
 *
 * @param objectives - Product objectives in original order.
 * @param completedLimit - Number of most recent completed objectives to append.
 * @returns Bounded objective list.
 */
export function objectivePreview(objectives: Data[], completedLimit: number): Data[] {
  const completed = objectives.filter((feature) => text(feature, 'phase') === 'done').slice(-completedLimit);
  return [...pendingObjectives(objectives).slice(0, OBJECTIVE_PREVIEW), ...completed];
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

/**
 * Explain quiet dispatch using actual settings and provider accounting.
 *
 * @param factory - Authenticated project factory snapshot.
 * @returns Logical coordinator state and concrete current blockers.
 */
export function dispatchSummary(factory: Data): string[] {
  const messages = [
    hasFlag(factory, 'active')
      ? 'Supervisor enabled. Product owner and lead are scheduled when work is eligible; they do not keep idle model processes running.'
      : 'Factory paused. Start the factory to dispatch queued work.',
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
      messages.push(
        `${provider}: configured scheduling budget exhausted; resets ${resetLabel(number(capacity, 'resetAt'))}. This is separate from subscription quota.`,
      );
    }
    if (number(capacity, 'cooldownUntil') > Date.now()) {
      messages.push(`${provider}: provider cooldown until ${resetLabel(number(capacity, 'cooldownUntil'))}.`);
    }
  }
  const blocked = records(factory['tasks']).filter(
    (task) => text(task, 'phase') === 'blocked' && task['scopeReplacement'] === undefined,
  );
  for (const task of blocked) {
    messages.push(`Issue #${String(number(task, 'issue'))} blocked: ${readableBlocker(text(task, 'error'))}`);
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
    return 'QA cannot inspect the PR because its read-only assignment claim is missing or expired. This is a review-access blocker, not an approval or confirmed code defect. Restore the owned claim and rerun independent QA on the same commits.';
  }
  if (error.includes('truncated:true') || error.includes('essential source remains inaccessible')) {
    return 'QA cannot finish because its read-only tool cannot open large source files. This is an inspection-tool blocker, not a confirmed code defect. Repair source paging, then rerun independent QA on the same commits.';
  }
  const first = error.split('\n', 1)[0] ?? '';
  return first.length > BLOCKER_EXCERPT
    ? `${first.slice(0, BLOCKER_EXCERPT)}… Read the technical details below.`
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
  panel.append(element('h2', '', 'Coordinator & dispatch'));
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
      element('summary', '', `Technical details for issue #${issue}`),
      element('pre', '', text(task, 'error')),
    );
    panel.append(details);
  }
  return panel;
}
