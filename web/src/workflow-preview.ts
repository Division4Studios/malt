/**
 * Pipeline preview of one workflow: planning and delivery drawn as execution
 * layers. Steps in one layer may run side by side; the next layer joins them.
 * Layers use the same rule as the server's `stepLayers`. Every label is text,
 * so untrusted titles and ids can never become markup.
 *
 * @file
 */
import { phrase, t, translated } from './i18n.js';
import { element } from './worker-ui.js';
import { badge } from './workflow-dom.js';
import { KIND_LABELS, layerGroups } from './workflow-model.js';

import type { DraftStep, DraftWorkflow, SectionName } from './workflow-model.js';

/** Section headings. */
const SECTION_TITLES: Readonly<Record<SectionName, string>> = translated({
  planning: phrase('Planning'),
  delivery: phrase('Each delivery'),
});

/**
 * Badges that describe a step's special behaviour.
 *
 * @param step - Step to describe.
 * @returns Badge elements, possibly empty.
 */
function stepBadges(step: DraftStep): HTMLElement[] {
  const badges: HTMLElement[] = [];
  if (step.kind === 'approve') {
    badges.push(badge(t('Human approval'), 'gate'));
  }
  if (step.blind) {
    badges.push(badge(t('Blind'), 'blind'));
  }
  if (step.gate) {
    badges.push(badge(t('Approval gate after'), 'gate'));
  }
  if (step.optional) {
    badges.push(badge(t('Optional'), 'optional'));
  }
  if (step.provider !== '') {
    badges.push(badge(t('Provider: {provider}', { provider: step.provider }), 'provider'));
  }
  if (step.profile !== '') {
    badges.push(badge(t('Profile: {profile}', { profile: step.profile })));
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
    return t('You, in the Inbox');
  }
  return step.roles.length === 0 ? t('No seat chosen') : step.roles.join(', ');
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
  const title = element(
    'strong',
    'wf-step-title',
    step.title === '' ? t('(untitled {id})', { id: step.id }) : step.title,
  );
  card.append(kind, title, element('span', 'wf-step-roles', rolesText(step)));
  if (step.inputs !== null) {
    const inputs = step.inputs.length === 0 ? t('nothing') : step.inputs.join(', ');
    card.append(element('span', 'wf-step-roles', t('Reads: {inputs}', { inputs })));
  }
  const badges = stepBadges(step);
  if (flagged.has(step.uid)) {
    badges.push(badge(t('Needs attention'), 'problem'));
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
      ? t('No planning: the objective is the single delivery.')
      : t('{steps, plural, one {# step} other {# steps}} in {layers, plural, one {# layer} other {# layers}}', {
          steps: steps.length,
          layers: groups.length,
        });
  node.append(heading, element('p', 'wf-hint', summary));
  if (steps.length === 0) {
    return node;
  }
  const layers = element('ol', 'wf-layers');
  for (const [index, group] of groups.entries()) {
    const layer = element('li', 'wf-layer');
    const parallel = group.length > 1 ? t(' · {length} run in parallel', { length: group.length }) : '';
    const join = index > 0 ? t(' · after the previous layer') : '';
    layer.append(
      element('p', 'wf-layer-label', t('Layer {value}{parallel}{join}', { value: index + 1, parallel, join })),
    );
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
