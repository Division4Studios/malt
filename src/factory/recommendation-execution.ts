/**
 * Unpaid execution of approved duplicate and consolidation recommendations.
 *
 * An approved record first re-reads every observed issue; any changed revision
 * makes it stale with no mutation. Otherwise it moves to applying and queues
 * ordinary outbox effects with deterministic identities: a marked comment on
 * the survivor carrying the transferred acceptance and dependencies, then a
 * marked comment and a not-planned closure on each retired ticket. The
 * outbox's comment markers and closed-state checks make a lost response safe
 * to retry, so ambiguous results move the record to reconciling until every
 * receipt exists. Permission failures, or effects that keep failing, settle
 * the record as failed with the error; the operator's retry re-queues the same
 * idempotent effects. Revisions are only checked before the first effect,
 * because the record's own comments change each issue's observed revision.
 *
 * @file
 */
import { MeshError } from '../protocol.ts';

import { recommendationRetrySchema } from './recommendation-read-schema.ts';

import type { DeliveryRemote } from './remote.ts';
import type { FactoryRepository } from './repository.ts';
import type { FactoryEffect, Recommendation } from './schema.ts';

/** Attempts one effect may fail before its record settles as failed. */
const MAX_EFFECT_ATTEMPTS = 5;
/** Errors that retrying cannot fix without operator action. */
const PERMISSION_ERROR = /\b(?:401|403|forbidden|not accessible|permission|unauthorized)\b/iv;
/** Recommendation kinds that change remote tickets. */
const EXECUTED_KINDS: ReadonlySet<string> = new Set(['duplicate', 'consolidate']);
/** Characters of a recommendation identity shown in public comments. */
const SHORT_ID = 12;
/** Longest audit reason the ledger accepts. */
const REASON_MAX = 4000;
/** States the executor advances. */
const ACTIVE_STATES: ReadonlySet<string> = new Set(['approved', 'applying', 'reconciling']);

/** What the executor needs from the project: its ledger and the native issue reader. */
export interface ExecutionContext {
  /** Project ledger, outbox and receipts. */
  readonly repository: FactoryRepository;
  /** Remote adapter; only observation is used here, the outbox applies effects. */
  readonly remote: Pick<DeliveryRemote, 'observedIssue'>;
}

/**
 * Whether a record is a remote ticket operation this executor applies.
 *
 * @param record - Current recommendation revision.
 * @returns True for duplicates and consolidations with a survivor.
 */
function isExecutable(record: Recommendation): boolean {
  return EXECUTED_KINDS.has(record.body.kind) && record.body.survivor !== null && record.body.tickets.length > 1;
}

/**
 * The record's effects, in the order they must complete.
 *
 * @param record - Approved duplicate or consolidation.
 * @returns Survivor comment, then each retired ticket's comment and closure.
 */
function plannedEffects(record: Recommendation): Pick<FactoryEffect, 'id' | 'kind' | 'issue' | 'value'>[] {
  const { body } = record;
  const survivor = body.survivor ?? 0;
  const prefix = `recommendation-${record.id}:${record.revision}`;
  const retired = body.tickets.filter((ticket) => ticket !== survivor);
  const verb = body.kind === 'duplicate' ? 'duplicates' : 'is consolidated into';
  const acceptance = body.transferredAcceptance.map((item) => `- ${item}`).join('\n');
  const dependencies = body.transferredDependencies.map((issue) => `#${String(issue)}`).join(', ');
  const retiredList = retired.map((issue) => `#${String(issue)}`).join(', ');
  const name = record.id.slice(0, SHORT_ID);
  const survivorText = [
    `Consolidates ${retiredList} through approved recommendation ${name} (revision ${record.revision.slice(0, SHORT_ID)}).`,
    body.action,
    acceptance === '' ? '' : `Transferred acceptance:\n${acceptance}`,
    dependencies === '' ? '' : `Transferred dependencies: ${dependencies}`,
  ].filter((part) => part !== '');
  return [
    {
      id: `${prefix}:survivor:${String(survivor)}`,
      kind: 'comment',
      issue: survivor,
      value: survivorText.join('\n\n'),
    },
    ...retired.flatMap((issue) => {
      return [
        {
          id: `${prefix}:retired:${String(issue)}:comment`,
          kind: 'comment' as const,
          issue,
          value: `This issue ${verb} #${String(survivor)} by approved recommendation ${name}. ${body.action}`,
        },
        {
          id: `${prefix}:retired:${String(issue)}:close`,
          kind: 'close_not_planned' as const,
          issue,
          value: body.action,
        },
      ];
    }),
  ];
}

/**
 * Re-read every observed issue; any difference, or no reader, keeps the record from executing.
 *
 * @param context - Remote observation capability.
 * @param record - Approved record.
 * @returns `fresh`, `stale` with the changed issue, or `unavailable` without a reader.
 */
async function freshness(
  context: ExecutionContext,
  record: Recommendation,
): Promise<{ state: 'fresh' | 'unavailable' } | { state: 'stale'; issue: number }> {
  const read = context.remote.observedIssue;
  if (read === undefined) {
    return { state: 'unavailable' };
  }
  for (const observed of record.body.observedIssues) {
    // eslint-disable-next-line no-await-in-loop -- Stop at the first changed issue; later reads cannot change the outcome.
    const issue = await read(observed.issue);
    if (!issue.complete || issue.revision !== observed.revision || issue.state !== 'open') {
      return { state: 'stale', issue: observed.issue };
    }
  }
  return { state: 'fresh' };
}

/**
 * Queue effects whose predecessors have receipts; each retired closure follows its comment.
 *
 * @param context - Project outbox.
 * @param record - Applying record.
 */
function queueReady(context: ExecutionContext, record: Recommendation): void {
  const { repository } = context;
  for (const effect of plannedEffects(record)) {
    const predecessor = effect.kind === 'close_not_planned' ? effect.id.replace(/:close$/v, ':comment') : null;
    if (!repository.effectCompleted(effect.id) && (predecessor === null || repository.effectCompleted(predecessor))) {
      repository.enqueueEffect({ ...effect, attempts: 0, retryAt: 0, error: null });
    }
  }
}

/**
 * Whether every effect of a record has a receipt.
 *
 * @param context - Project outbox receipts.
 * @param record - Applying or reconciling record.
 * @returns True once the record's ticket changes are all confirmed.
 */
function isApplied(context: ExecutionContext, record: Recommendation): boolean {
  return plannedEffects(record).every((effect) => context.repository.effectCompleted(effect.id));
}

/**
 * Move one record forward from the receipts and errors of its effects.
 *
 * @param context - Project ledger.
 * @param record - Applying or reconciling record.
 */
function settle(context: ExecutionContext, record: Recommendation): void {
  const { repository } = context;
  const fence = { id: record.id, revision: record.revision, state: record.state };
  queueReady(context, record);
  if (isApplied(context, record)) {
    repository.recommendations.transition({
      ...fence,
      next: 'completed',
      reason: 'Every ticket effect has a receipt.',
    });
    return;
  }
  const ids = new Set(plannedEffects(record).map((effect) => effect.id));
  const failing = repository.effects().filter((effect) => ids.has(effect.id) && effect.error !== null);
  const fatal = failing.find(
    (effect) => PERMISSION_ERROR.test(effect.error ?? '') || effect.attempts >= MAX_EFFECT_ATTEMPTS,
  );
  if (fatal !== undefined) {
    const pending = repository.effects().filter((effect) => ids.has(effect.id));
    repository.store.transaction(() => {
      for (const effect of pending) {
        repository.discardEffect(effect.id, `Recommendation ${record.id} failed; the operator can retry it.`);
      }
      repository.recommendations.transition({
        ...fence,
        next: 'failed',
        reason: `Issue #${String(fatal.issue)}: ${fatal.error ?? 'remote effect failed'}`.slice(0, REASON_MAX),
      });
    });
    return;
  }
  if (failing.length > 0 && record.state === 'applying') {
    repository.recommendations.transition({
      ...fence,
      next: 'reconciling',
      reason: `Ambiguous remote result on #${String(failing[0]?.issue ?? 0)}; retrying through comment markers and receipts.`,
    });
  }
}

/**
 * Start fresh approved records and settle applying ones. Rejected, stale and
 * pending records, and kinds without remote ticket operations, are never read
 * or changed.
 *
 * @param context - Project ledger and remote adapter.
 */
export async function advanceRecommendations(context: ExecutionContext): Promise<void> {
  const { repository } = context;
  const records = repository.recommendations
    .current()
    .filter((record) => ACTIVE_STATES.has(record.state) && isExecutable(record));
  for (const record of records) {
    if (record.state !== 'approved') {
      settle(context, record);
      continue;
    }
    // eslint-disable-next-line no-await-in-loop -- Records execute one at a time so remote reads stay serialized.
    const fresh = await freshness(context, record);
    const fence = { id: record.id, revision: record.revision, state: 'approved' as const };
    if (fresh.state === 'stale') {
      repository.recommendations.transition({
        ...fence,
        next: 'stale',
        reason: `Issue #${String(fresh.issue)} changed after approval; nothing was changed. Refresh the proposal.`,
      });
    } else if (fresh.state === 'fresh') {
      repository.store.transaction(() => {
        const applying = repository.recommendations.transition({
          ...fence,
          next: 'applying',
          reason: 'Observed revisions confirmed at execution.',
        });
        queueReady(context, applying);
      });
    }
  }
}

/**
 * Operator retry of a failed record: back to applying, re-queueing its idempotent effects.
 *
 * @param context - Project ledger.
 * @param input - Exact failed revision.
 * @returns The record's new state.
 * @throws {MeshError} When the record is not failed at that revision.
 */
export function retryRecommendation(context: ExecutionContext, input: unknown): { state: string } {
  const request = recommendationRetrySchema.parse(input);
  const record = context.repository.recommendations.get(request.id);
  if (record?.revision !== request.revision || record.state !== 'failed' || !isExecutable(record)) {
    throw new MeshError('FACTORY_GATED', 'Only a failed duplicate or consolidation can be retried at its revision.');
  }
  return context.repository.store.transaction(() => {
    const applying = context.repository.recommendations.transition({
      id: record.id,
      revision: record.revision,
      state: 'failed',
      next: 'applying',
      reason: 'Operator retry.',
    });
    queueReady(context, applying);
    return { state: applying.state };
  });
}
