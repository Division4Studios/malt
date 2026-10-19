/** @file Immutable assignment request evidence; provider execution is not inferred. */
import { child, displayText, text } from './api.js';
import { t } from './i18n.js';
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
    [t('Assignment'), displayText(text(job, 'id'), t('No assignment was claimed'))],
    [t('Requested provider'), displayText(text(job, 'provider'), t('Unknown'))],
    [t('Requested model'), displayText(text(routing, 'model'), t('CLI default · model unknown'))],
    [
      t('Requested effort'),
      effort === null
        ? t('No native effort override recorded')
        : displayText(text(routing, 'effort'), t('Unknown · historical record has no effort evidence')),
    ],
    [t('Enforced capability floor'), displayText(text(routing, 'tier'), t('Unknown'))],
    [t('Policy revision'), typeof revision === 'number' ? String(revision) : t('Legacy / not recorded')],
    [
      t('Reviewed recommendation'),
      Object.keys(reviewed).length === 0
        ? t('Not recorded for this assignment')
        : `${text(reviewed, 'tier')} / ${text(reviewed, 'effort')}; ${displayText(text(choice, 'entryId'), 'stage default')}`,
    ],
    [
      t('Reviewed policy revision'),
      typeof choice['policyRevision'] === 'number'
        ? String(choice['policyRevision'])
        : t('Not recorded / stage default'),
    ],
    [t('Review rationale'), displayText(text(reviewed, 'reason'), t('Not recorded'))],
    [t('Selection / override reason'), displayText(text(routing, 'reason'), t('No routing evidence recorded'))],
    [
      t('Execution confirmation'),
      t('Requested CLI arguments only; provider-applied model/effort is not independently confirmed.'),
    ],
  ];
}

/**
 * Build a keyboard-operable request-evidence disclosure from immutable job fields.
 *
 * @param job - Historical or current assignment, never a mutable policy lookup.
 * @param diagnostic - Current supervisor diagnostic, which may include a no-launch gate.
 * @returns Safe native details; hostile rationale remains text.
 */
export function selectionDetails(job: Data, diagnostic: string): HTMLElement {
  const details = element('details', 'panel-body');
  details.dataset['selectionEvidence'] = '';
  details.append(element('summary', '', t('Model selection evidence · requested launch')));
  const list = element('dl');
  for (const [label, value] of selectionRows(job)) {
    list.append(element('dt', 'subtle', label), element('dd', '', value));
  }
  details.append(list);
  if (diagnostic !== '') {
    details.append(
      element(
        'p',
        'subtle',
        t('Current supervisor diagnostic (separate from this recorded job): {diagnostic}', { diagnostic }),
      ),
    );
  }
  return details;
}
