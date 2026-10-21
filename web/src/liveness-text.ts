/**
 * Plain text for assignment liveness beyond the delivery card's own liveness
 * line: the recorded stop reason instead of a generic `interrupted`, the quota
 * reading the extension gate trusts or `unknown`, elapsed time, and the
 * manager's progress column. DOM-free, so it is tested directly.
 *
 * @file
 */
import { child, number, text } from './api.js';
import { livenessText, parseLiveness, parseQuota, relativeAge } from './console-model.js';
import { t } from './i18n.js';
import { ago } from './manager-controller.js';
import { formatDuration } from './telemetry-format.js';

import type { Data } from './api.js';
import type { Quota, Stop } from './console-model.js';

/**
 * The quota reading an extension would rest on, or why there is none.
 *
 * @param quota - Quota evidence, or null from an unconfigured factory or an older broker.
 * @param now - Current time.
 * @returns Text such as `quota headroom 60% · read 2m 00s ago`, or that it is stale or unknown.
 */
export function quotaText(quota: Quota | null, now: number): string {
  if (quota?.freshness === 'current' && quota.headroomPercent !== null) {
    const headroom = Math.round(quota.headroomPercent);
    return quota.observedAt === null
      ? t('quota headroom {headroom}%', { headroom })
      : t('quota headroom {headroom}% · read {age}', { headroom, age: relativeAge(quota.observedAt, now) });
  }
  // A stale reading is never available capacity.
  return t(quota?.freshness === 'stale' ? 'quota reading stale, so unknown' : 'quota unknown');
}

/**
 * Time an attempt has run.
 *
 * @param startedAt - Start time; 0 when the broker did not send it.
 * @param now - Current time.
 * @returns Duration such as `12m 30s`, or `—`.
 */
export function elapsedText(startedAt: number, now: number): string {
  return startedAt > 0 ? formatDuration(Math.max(0, now - startedAt)) : '—';
}

/**
 * Why a delivery's latest attempt stopped at a checkpoint.
 *
 * @param stop - Recorded stop.
 * @returns The stop reason, marked when the operator's decision is pending.
 */
export function stopText(stop: Stop): string {
  return stop.isAwaitingDecision
    ? t('{reason} · awaiting your continue-or-wait decision in the Inbox', { reason: stop.reason })
    : stop.reason;
}

/**
 * What became of an attempt: its recorded checkpoint stop reason when one
 * stopped it, marked while a decision is pending, otherwise its state.
 *
 * @param row - Attempt listing row.
 * @returns Text such as `stalled 16 min`, `hard ceiling · awaiting your decision` or `succeeded`.
 */
export function attemptOutcome(row: Data): string {
  const state = text(row, 'state');
  const reason = text(child(row, 'liveness'), 'stopReason');
  if (state === 'running' || reason === '') {
    return state;
  }
  return text(row, 'checkpoint') === 'pending' ? t('{reason} · awaiting your decision', { reason }) : reason;
}

/**
 * Progress evidence for one running assignment in the mission brief.
 *
 * @param job - Running assignment from the brief.
 * @param now - Current time.
 * @returns Recorded liveness (or, before any is recorded, checkpoint and output times), then quota.
 */
export function briefProgress(job: Data, now: number): string {
  const liveness = parseLiveness(job['liveness']);
  const checkpoint = number(job, 'progressAt');
  const activity = number(job, 'activityAt');
  const evidence = (
    liveness === null
      ? [
          checkpoint > 0 ? t('checkpoint {ago}', { ago: ago(checkpoint, now) }) : '',
          activity > 0 ? t('output {ago}', { ago: ago(activity, now) }) : '',
        ]
      : [livenessText(liveness, now)]
  ).filter((part) => part !== '');
  if (job['isPossiblyStalled'] === true) {
    evidence.push(t('possibly stalled'));
  }
  return [
    evidence.length === 0 ? t('no evidence yet') : evidence.join(' · '),
    quotaText(parseQuota(job['quota']), now),
  ].join(' · ');
}
