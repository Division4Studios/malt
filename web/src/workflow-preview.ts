/**
 * Pipeline preview of one workflow: planning and delivery drawn as execution
 * layers. Steps in one layer may run side by side; the next layer joins them.
 * Layers use the same rule as the server's `stepLayers`. Every label is text,
 * so untrusted titles and ids can never become markup.
 *
 * @file
 */
import { element } from './worker-ui.js';
import { badge } from './workflow-dom.js';
import { KIND_LABELS, layerGroups } from './workflow-model.js';

import type { DraftStep, DraftWorkflow, SectionName } from './workflow-model.js';

/** Section headings. */
const SECTION_TITLES: Readonly<Record<SectionName, string>> = { planning: 'Planning', delivery: 'Each delivery' };

/**
 * Plural-aware count.
 *
 * @param count - Quantity.
 * @param noun - Singular noun.
 * @returns Phrase such as "1 step" or "3 steps".
 */
export function countLabel(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * Badges that describe a step's special behaviour.
 *
 * @param step - Step to describe.
 * @returns Badge elements, possibly empty.
 */
function stepBadges(step: DraftStep): HTMLElement[] {
  const badges: HTMLElement[] = [];
  if (step.kind === 'approve') {
    badges.push(badge('Human approval', 'gate'));
  }
  if (step.blind) {
    badges.push(badge('Blind', 'blind'));
  }
  if (step.gate) {
    badges.push(badge('Approval gate after', 'gate'));
  }
  if (step.optional) {
    badges.push(badge('Optional', 'optional'));
  }
  if (step.provider !== '') {
    badges.push(badge(`Provider: ${step.provider}`, 'provider'));
  }
  if (step.profile !== '') {
    badges.push(badge(`Profile: ${step.profile}`));
  }
  return badges;
}

/**
 * Who performs a step, in words.
 *
 * @param step - Step to describe.
 * @returns Seats, or who acts instead.
 */
function rolesText(step: DraftStep): string {
  if (step.kind === 'approve') {
    return 'You, in the Inbox';
  }
  return step.roles.length === 0 ? 'No seat chosen' : step.roles.join(', ');
}

/**
 * One step card.
 *
 * @param step - Step to draw.
 * @param flagged - Steps with browser-detected problems.
 * @returns List item.
 */
function stepCard(step: DraftStep, flagged: ReadonlySet<string>): HTMLLIElement {
  const card = element('li', 'wf-step-card');
  const kind = element('span', 'wf-step-kind', KIND_LABELS[step.kind] ?? step.kind);
  const title = element('strong', 'wf-step-title', step.title === '' ? `(untitled ${step.id})` : step.title);
  card.append(kind, title, element('span', 'wf-step-roles', rolesText(step)));
  if (step.inputs !== null) {
    card.append(
      element('span', 'wf-step-roles', `Reads: ${step.inputs.length === 0 ? 'nothing' : step.inputs.join(', ')}`),
    );
  }
  const badges = stepBadges(step);
  if (flagged.has(step.uid)) {
    badges.push(badge('Needs attention', 'problem'));
    card.classList.add('has-problem');
  }
  if (badges.length > 0) {
    const list = element('span', 'wf-badges');
    list.append(...badges);
    card.append(list);
  }
  return card;
}

/**
 * One section drawn as layers.
 *
 * @param section - Section name.
 * @param steps - Its steps in order.
 * @param flagged - Steps with browser-detected problems.
 * @returns Section element.
 */
function sectionPreview(section: SectionName, steps: readonly DraftStep[], flagged: ReadonlySet<string>): HTMLElement {
  const node = element('section', 'wf-pipeline-section');
  const groups = layerGroups(steps);
  const heading = element('h3', 'wf-pipeline-heading', SECTION_TITLES[section]);
  const summary =
    steps.length === 0
      ? 'No planning: the objective is the single delivery.'
      : `${countLabel(steps.length, 'step')} in ${countLabel(groups.length, 'layer')}`;
  node.append(heading, element('p', 'wf-hint', summary));
  if (steps.length === 0) {
    return node;
  }
  const layers = element('ol', 'wf-layers');
  for (const [index, group] of groups.entries()) {
    const layer = element('li', 'wf-layer');
    const parallel = group.length > 1 ? ` · ${String(group.length)} run in parallel` : '';
    const join = index > 0 ? ' · after the previous layer' : '';
    layer.append(element('p', 'wf-layer-label', `Layer ${String(index + 1)}${parallel}${join}`));
    const cards = element('ul', 'wf-layer-steps');
    cards.append(...group.map((step) => stepCard(step, flagged)));
    layer.append(cards);
    layers.append(layer);
  }
  node.append(layers);
  return node;
}

/**
 * Draw a workflow's planning and delivery pipelines.
 *
 * @param workflow - Workflow to draw.
 * @param flagged - Uids of steps with browser-detected problems.
 * @returns Preview element.
 */
export function pipelinePreview(workflow: DraftWorkflow, flagged: ReadonlySet<string> = new Set()): HTMLElement {
  const node = element('div', 'wf-pipeline');
  node.append(
    sectionPreview('planning', workflow.planning, flagged),
    sectionPreview('delivery', workflow.delivery, flagged),
  );
  return node;
}
