/** @file Immutable assignment request evidence; provider execution is not inferred. */
import { child, displayText, text } from './api.js';
import { element } from './worker-ui.js';

import type { Data } from './api.js';

/**
 * Summarize only the recorded job, never today's mutable task/model settings.
 *
 * @param job - Exact public persisted assignment.
 * @returns Plain text mappings suitable for native definition lists and tests.
 */
export function selectionRows(job: Data): [string, string][] {
  const routing = child(job, 'routing');
  const selection = child(routing, 'selection');
  const reviewed = child(routing, 'reviewed');
  const choice = child(reviewed, 'modelChoice');
  const revision = selection['policyRevision'];
  const { effort } = routing;
  return [
    ['Assignment', displayText(text(job, 'id'), 'No assignment was claimed')],
    ['Requested provider', displayText(text(job, 'provider'), 'Unknown')],
    ['Requested model', displayText(text(routing, 'model'), 'CLI default · model unknown')],
    [
      'Requested effort',
      effort === null
        ? 'No native effort override recorded'
        : displayText(text(routing, 'effort'), 'Unknown · historical record has no effort evidence'),
    ],
    ['Enforced capability floor', displayText(text(routing, 'tier'), 'Unknown')],
    ['Policy revision', typeof revision === 'number' ? String(revision) : 'Legacy / not recorded'],
    [
      'Reviewed recommendation',
      Object.keys(reviewed).length === 0
        ? 'Not recorded for this assignment'
        : `${text(reviewed, 'tier')} / ${text(reviewed, 'effort')}; ${displayText(text(choice, 'entryId'), 'stage default')}`,
    ],
    [
      'Reviewed policy revision',
      typeof choice['policyRevision'] === 'number' ? String(choice['policyRevision']) : 'Not recorded / stage default',
    ],
    ['Review rationale', displayText(text(reviewed, 'reason'), 'Not recorded')],
    ['Selection / override reason', displayText(text(routing, 'reason'), 'No routing evidence recorded')],
    [
      'Execution confirmation',
      'Requested CLI arguments only; provider-applied model/effort is not independently confirmed.',
    ],
  ];
}

/**
 * Build a keyboard-operable request-evidence disclosure from immutable job fields.
 *
 * @param job - Historical or current assignment, never a mutable policy lookup.
 * @param gate - Current factory-wide no-launch explanation, if present.
 * @returns Safe native details; hostile rationale remains text.
 */
export function selectionDetails(job: Data, gate: string): HTMLElement {
  const details = element('details', 'panel-body');
  details.dataset['selectionEvidence'] = '';
  details.append(element('summary', '', 'Model selection evidence · requested launch'));
  const list = element('dl');
  for (const [label, value] of selectionRows(job)) {
    list.append(element('dt', 'subtle', label), element('dd', '', value));
  }
  details.append(list);
  if (gate !== '') {
    details.append(element('p', 'subtle', `Current factory admission gate (separate from this recorded job): ${gate}`));
  }
  return details;
}
