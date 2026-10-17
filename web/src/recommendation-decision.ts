/**
 * The context a decision on one recommendation revision rests on: its exact
 * revision, tickets, survivor, transferred acceptance and dependencies, and
 * affected assignments, all as text.
 *
 * @file
 */
import { tag } from './console-dom.js';
import { t } from './i18n.js';
import { LANE_LABELS, ticketText } from './recommendations-model.js';
import { element } from './worker-ui.js';

import type { RecommendationDetail } from './recommendations-model.js';

/** Digits of a revision shown to identify it. */
const REVISION_SHOWN = 12;

/**
 * One item per line, or a plain note when there are none.
 *
 * @param items - Text items.
 * @returns Joined text.
 */
function lines(items: readonly string[]): string {
  return items.length === 0 ? t('None') : items.join('\n');
}

/**
 * Everything a decision rests on, as text.
 *
 * @param detail - Open recommendation.
 * @returns Definition list of the decision context.
 */
export function recommendationContext(detail: RecommendationDetail): HTMLElement {
  const list = element('dl', 'recommendation-context');
  const rows: [string, string][] = [
    [t('Revision'), detail.revision.slice(0, REVISION_SHOWN)],
    [t('Tickets'), ticketText(detail.tickets)],
    [t('Survivor'), detail.survivor === null ? t('None') : `#${String(detail.survivor)}`],
    [t('Transferred acceptance'), lines(detail.transferredAcceptance)],
    [t('Transferred dependencies'), ticketText(detail.transferredDependencies)],
    [t('Affected assignments'), lines(detail.affectedAssignments)],
  ];
  for (const [label, value] of rows) {
    list.append(element('dt', 'subtle', label), element('dd', '', value));
  }
  const wrapper = element('div');
  wrapper.append(tag(LANE_LABELS[detail.lane], 'tag-state'), list);
  return wrapper;
}
