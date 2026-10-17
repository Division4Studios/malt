/**
 * Unpaid execution of approved duplicate and consolidation recommendations:
 * re-read the observed issues (any change makes the record stale), then queue
 * marked survivor and retired-ticket comments and not-planned closures as
 * ordinary outbox effects with deterministic ids. Markers and closed-state
 * checks keep retries idempotent; revisions are only checked before the first
 * effect, because the record's own comments change each issue's revision.
 * Permission errors, or effects that keep failing, settle the record as failed
 * and stop its effects; the operator's retry revalidates and re-queues them.
 * Local deliveries for retired tickets hand their dependents to the survivor
 * and are parked (see recommendation-graph.ts).
 *
 * @file
 */
import { MeshError } from '../protocol.ts';

import { applyTransfer, planTransfer } from './recommendation-graph.ts';
import { advanceGuidance } from './recommendation-guidance.ts';
import { recommendationRetrySchema } from './recommendation-read-schema.ts';

import type { ObservedIssue } from '../github-issues.ts';
import type { ProjectLearning } from '../learning.ts';
import type { DeliveryRemote } from './remote.ts';
import type { FactoryRepository } from './repository.ts';
import type { FactoryEffect, Recommendation } from './schema.ts';

/** Recommendation kinds that change remote tickets. */
const EXECUTED_KINDS: ReadonlySet<string> = new Set(['duplicate', 'consolidate']);
/** Attempts one effect may fail before its record settles as failed. */
const MAX_EFFECT_ATTEMPTS = 5;
/** Errors that retrying cannot fix without operator action. */
const PERMISSION_ERROR = /\b(?:401|403|forbidden|not accessible|permission|unauthorized)\b/iv;
/** Longest audit reason the ledger accepts. */
const REASON_MAX = 4000;
/** Characters of a recommendation identity shown in public comments. */
const SHORT_ID = 12;
/** Read errors that mean the observed issue is gone from the selected repository. */
const MISSING_ISSUE: ReadonlySet<string> = new Set(['NOT_FOUND', 'WRONG_PROJECT']);
/** States the executor advances. */
const ACTIVE_STATES = ['approved', 'applying', 'reconciling'] as const;

/** What the executor needs from the project: its ledger and the native issue reader. */
export interface ExecutionContext {
  /** Project ledger, outbox and receipts. */
  readonly repository: FactoryRepository;
  /** Remote adapter; only observation is used here, the outbox applies effects. */
  readonly remote: Pick<DeliveryRemote, 'observedIssue'>;
  /** Project learning service, for guidance suggestions; they wait without it. */
  readonly learning?: Pick<ProjectLearning, 'execute' | 'skillLibrary'>;
}

/**
 * Whether a record is a remote ticket operation this executor applies.
 *
 * @param record - Current recommendation revision.
 * @returns True for duplicates and consolidations with a survivor.
 */
function isTicketOperation(record: Recommendation): boolean {
  return EXECUTED_KINDS.has(record.body.kind) && record.body.survivor !== null && record.body.tickets.length > 1;
}

/**
 * Whether the executor advances a record: ticket operations and guidance suggestions.
 *
 * @param record - Current recommendation revision.
 * @returns True for records with an executable approved outcome.
 */
function isExecutable(record: Recommendation): boolean {
  return isTicketOperation(record) || record.body.kind === 'guidance_suggestion';
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
 * Read one issue. A missing, transferred or inaccessible issue is permanent
 * evidence; any other failure is retried on the next pass.
 *
 * @param read - Native issue reader.
 * @param number - Issue number.
 * @returns The observation, `missing`, or `unavailable` for a retryable failure.
 */
async function readOne(
  read: NonNullable<DeliveryRemote['observedIssue']>,
  number: number,
): Promise<ObservedIssue | 'missing' | 'unavailable'> {
  try {
    return await read(number);
  } catch (error) {
    return error instanceof MeshError && MISSING_ISSUE.has(error.code) ? 'missing' : 'unavailable';
  }
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
    const issue = await readOne(read, observed.issue);
    if (issue === 'unavailable') {
      return { state: 'unavailable' };
    }
    if (issue === 'missing' || !issue.complete || issue.revision !== observed.revision || issue.state !== 'open') {
      return { state: 'stale', issue: observed.issue };
    }
  }
  return { state: 'fresh' };
}

/**
 * Queue effects whose predecessors have receipts. The survivor comment comes
 * first, so no retired ticket changes before the survivor carries the
 * transferred acceptance; each retired closure then follows its own comment.
 *
 * @param context - Project outbox.
 * @param record - Applying record.
 */
function queueReady(context: ExecutionContext, record: Recommendation): void {
  const { repository } = context;
  const [survivor, ...retired] = plannedEffects(record);
  if (survivor === undefined) {
    return;
  }
  if (!repository.effectCompleted(survivor.id)) {
    repository.enqueueEffect({ ...survivor, attempts: 0, retryAt: 0, error: null });
    return;
  }
  for (const effect of retired) {
    const predecessor = effect.kind === 'close_not_planned' ? effect.id.replace(/:close$/v, ':comment') : null;
    if (!repository.effectCompleted(effect.id) && (predecessor === null || repository.effectCompleted(predecessor))) {
      repository.enqueueEffect({ ...effect, attempts: 0, retryAt: 0, error: null });
    }
  }
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
  if (plannedEffects(record).every((effect) => repository.effectCompleted(effect.id))) {
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
 * Start a fresh approved record: move local dependents onto the survivor and
 * park retired deliveries, then queue its ticket effects, all in one
 * transaction. A local plan that no longer holds makes the record stale first.
 *
 * @param context - Project ledger.
 * @param record - Approved record whose observed issues are current.
 */
function start(context: ExecutionContext, record: Recommendation): void {
  const { repository } = context;
  const fence = { id: record.id, revision: record.revision, state: 'approved' as const };
  repository.store.transaction(() => {
    const plan = planTransfer(repository, record);
    if (plan.kind === 'stale') {
      repository.recommendations.transition({ ...fence, next: 'stale', reason: `${plan.reason} Nothing was changed.` });
      return;
    }
    applyTransfer(repository, record, plan);
    const applying = repository.recommendations.transition({
      ...fence,
      next: 'applying',
      reason: 'Observed revisions and local deliveries confirmed at execution.',
    });
    queueReady(context, applying);
  });
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
  const records = repository.recommendations.current(ACTIVE_STATES).filter((record) => isExecutable(record));
  for (const record of records) {
    if (record.state !== 'approved') {
      if (isTicketOperation(record)) {
        settle(context, record);
      } else {
        // eslint-disable-next-line no-await-in-loop -- Bridge steps write the learning library one record at a time.
        await advanceGuidance(context, record);
      }
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
    } else if (fresh.state === 'fresh' && isTicketOperation(record)) {
      start(context, record);
    } else if (fresh.state === 'fresh') {
      repository.recommendations.transition({
        ...fence,
        next: 'applying',
        reason: 'Observed revisions confirmed; proposing a skill candidate.',
      });
    }
  }
}

/**
 * Operator retry of a failed record. With no ticket changed yet it returns to
 * approved, so the next pass revalidates everything; otherwise the tickets no
 * effect touched are re-read first and a changed one keeps the record failed.
 *
 * @param context - Project ledger and native issue reader.
 * @param input - Exact failed revision.
 * @returns The record's new state.
 * @throws {MeshError} When the record is not failed at that revision, or an untouched ticket changed.
 */
export async function retryRecommendation(context: ExecutionContext, input: unknown): Promise<{ state: string }> {
  const { repository } = context;
  const request = recommendationRetrySchema.parse(input);
  const record = repository.recommendations.get(request.id);
  if (record?.revision !== request.revision || record.state !== 'failed' || !isTicketOperation(record)) {
    throw new MeshError('FACTORY_GATED', 'Only a failed duplicate or consolidation can be retried at its revision.');
  }
  const fence = { id: record.id, revision: record.revision, state: 'failed' as const };
  const effects = plannedEffects(record);
  const touched = new Set(
    effects.filter((effect) => repository.effectCompleted(effect.id)).map((effect) => effect.issue),
  );
  if (touched.size === 0) {
    repository.recommendations.transition({ ...fence, next: 'approved', reason: 'Operator retry; revalidating.' });
    return { state: 'approved' };
  }
  const untouched = record.body.observedIssues.filter((observed) => !touched.has(observed.issue));
  const fresh = await freshness(context, { ...record, body: { ...record.body, observedIssues: untouched } });
  if (fresh.state !== 'fresh') {
    throw new MeshError(
      'FACTORY_GATED',
      'An untouched ticket changed or cannot be read; refresh the proposal instead.',
    );
  }
  return repository.store.transaction(() => {
    const applying = repository.recommendations.transition({ ...fence, next: 'applying', reason: 'Operator retry.' });
    queueReady(context, applying);
    return { state: applying.state };
  });
}
