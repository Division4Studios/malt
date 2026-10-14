/**
 * Complete semantic product queue, with safe text and native details controls.
 *
 * @file
 */
import { text } from './api.js';
import { objectiveGroups } from './brand-ui.js';
import { element } from './worker-ui.js';

import type { Data } from './api.js';
import type { Actions } from './views.js';
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
