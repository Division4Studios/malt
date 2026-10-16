/** @file Operator-only exact-revision decisions; approved intents remain inert until executed separately. */
import { Buffer } from 'node:buffer';
import { createHash, timingSafeEqual } from 'node:crypto';

import { z } from 'zod/v3';

import { run, selectOne } from '../database.ts';
import { observedIssueSchema } from '../github-issues.ts';
import { MeshError } from '../protocol.ts';

import { areObjectivesCurrent } from './recommendation-objectives.ts';
import { recommendationAddress } from './recommendation-read-schema.ts';

import type { MeshConfig } from '../config.ts';
import type { ObservedIssue } from '../github-issues.ts';
import type { DeliveryRemote } from './remote.ts';
import type { FactoryRepository } from './repository.ts';
import type { RecommendationBody } from './schema.ts';

/** Human decisions have stable operation identities distinct from immutable proposal identities. */
const RATIONALE_MAX = 4000;
/** Exact human request; empty or unbounded rationale is refused. */
export const recommendationDecisionSchema = z
  .object({
    operationId: z.string().uuid(),
    id: recommendationAddress,
    revision: recommendationAddress,
    decision: z.enum(['approve', 'reject']),
    rationale: z.string().trim().min(1).max(RATIONALE_MAX),
  })
  .strict();
/** Minimal persisted outcome; no private prose or credential is returned. */
const resultSchema = z.object({
  operationId: z.string().uuid(),
  id: recommendationAddress,
  revision: recommendationAddress,
  outcome: z.enum(['approved', 'rejected', 'stale']),
});
/** Original request hash refuses a reused operation ID with changed intent. */
const receiptSchema = z.object({ hash: recommendationAddress, result: resultSchema });
/** Existing project-local metadata persistence remains transactional. */
const rowSchema = z.object({ value: z.string() });
/** Memory-only authority; never registered as MCP or serializable broker RPC. */
export type RecommendationOperator = (project: MeshConfig, input: unknown) => Promise<unknown>;
/** One unpaid issue-inspection campaign per selected project; identical clicks share it. */
const IN_FLIGHT = new WeakMap<FactoryRepository, Map<string, Promise<z.output<typeof resultSchema>>>>();

/**
 * Inspect bounded native observations sequentially, stopping on the first stale issue.
 *
 * @param readIssue - Verified issue reader.
 * @param issues - Validated finite proposal references.
 * @yields {ObservedIssue} One native observation; async-generator yield settles before the next read.
 */
async function* issueObservations(
  readIssue: NonNullable<DeliveryRemote['observedIssue']>,
  issues: RecommendationBody['observedIssues'],
): AsyncGenerator<ObservedIssue> {
  for (const observed of issues) {
    yield readIssue(observed.issue);
  }
}

/**
 * Return a prior decision or refuse conflicting reuse before any remote read.
 *
 * @param repository - Authoritative selected-project ledger.
 * @param key - Namespaced operation identity.
 * @param hash - Exact validated request hash.
 * @returns Original recorded result, or null when no decision committed.
 * @throws {MeshError} For an operation identity reused with different intent.
 */
function replay(repository: FactoryRepository, key: string, hash: string): z.output<typeof resultSchema> | null {
  const saved = selectOne(repository.store.db, rowSchema, 'SELECT value FROM metadata WHERE key=?', key);
  if (saved === undefined) {
    return null;
  }
  const receipt = receiptSchema.parse(JSON.parse(saved.value));
  if (!timingSafeEqual(Buffer.from(receipt.hash, 'hex'), Buffer.from(hash, 'hex'))) {
    throw new MeshError('FACTORY_GATED', 'A decision operation identity cannot change its intent.');
  }
  return receipt.result;
}

/**
 * Recheck actual native issue revisions, then atomically decide with a second local revision fence.
 *
 * @param repository - Selected project's durable ledger.
 * @param readIssue - Verified repository observation capability; no mutation authority.
 * @param input - Exact human decision supplied through the paired web boundary only.
 * @returns Original receipt on replay, or current approved/rejected/stale outcome.
 * @throws {MeshError} For unavailable observations, changed state or conflicting decisions.
 */
async function commitDecision(
  repository: FactoryRepository,
  readIssue: DeliveryRemote['observedIssue'],
  input: unknown,
): Promise<z.output<typeof resultSchema>> {
  const request = recommendationDecisionSchema.parse(input);
  const hash = createHash('sha256').update(JSON.stringify(request)).digest('hex');
  const key = `factory_recommendation_decision:${request.operationId}`;
  const saved = replay(repository, key, hash);
  if (saved !== null) {
    return saved;
  }
  const before = repository.recommendations.get(request.id);
  if (before?.revision !== request.revision) {
    return { operationId: request.operationId, id: request.id, revision: request.revision, outcome: 'stale' };
  }
  if (before.state !== 'awaiting_human' || (readIssue === undefined && before.body.observedIssues.length > 0)) {
    throw new MeshError('FACTORY_GATED', 'An awaiting-human revision and verified issue reader are required.');
  }
  let isFresh = areObjectivesCurrent(repository, before.body.observedObjectives);
  let index = 0;
  const nativeReader =
    readIssue ??
    (() => {
      throw new MeshError('FACTORY_GATED', 'Native issue reader unavailable.');
    });
  const observations = issueObservations(nativeReader, before.body.observedIssues);
  for await (const raw of observations) {
    const issue = observedIssueSchema.parse(raw);
    const observed = before.body.observedIssues.at(index);
    index += 1;
    if (issue.number !== observed?.issue || !issue.complete || issue.revision !== observed.revision) {
      isFresh = false;
      break;
    }
  }
  return repository.store.transaction(() => {
    const prior = replay(repository, key, hash);
    if (prior !== null) {
      return prior;
    }
    const current = repository.recommendations.get(request.id);
    if (current?.revision !== request.revision || current.state !== 'awaiting_human') {
      throw new MeshError(
        'FACTORY_GATED',
        'The recommendation changed while its native issues were inspected. Refresh it.',
      );
    }
    const decision = request.decision === 'approve' ? 'approved' : 'rejected';
    const outcome = isFresh && areObjectivesCurrent(repository, current.body.observedObjectives) ? decision : 'stale';
    repository.recommendations.transition({
      id: request.id,
      revision: request.revision,
      state: 'awaiting_human',
      next: outcome,
      reason: isFresh ? request.rationale : 'Native issue evidence changed or is incomplete; refresh the proposal.',
    });
    const result: z.output<typeof resultSchema> = {
      operationId: request.operationId,
      id: request.id,
      revision: request.revision,
      outcome,
    };
    run(repository.store.db, 'INSERT INTO metadata(key,value) VALUES(?,?)', key, JSON.stringify({ hash, result }));
    if (outcome === 'approved') {
      const intentKey = `factory_recommendation_intent:${request.id}:${request.revision}`;
      run(
        repository.store.db,
        'INSERT INTO metadata(key,value) VALUES(?,?)',
        intentKey,
        JSON.stringify({ ...result, state: 'pending', createdAt: repository.store.now() }),
      );
    }
    repository.store.event('FACTORY_RECOMMENDATION_DECIDED', null, result);
    return result;
  });
}

/**
 * Deduplicate in-flight human clicks without allowing native GitHub process storms.
 *
 * @param repository - Selected project's authoritative ledger.
 * @param readIssue - Verified native read capability.
 * @param input - Exact validated human decision.
 * @returns Original or newly committed inert decision receipt.
 */
export async function decideRecommendation(
  repository: FactoryRepository,
  readIssue: DeliveryRemote['observedIssue'],
  input: unknown,
): Promise<z.output<typeof resultSchema>> {
  const request = recommendationDecisionSchema.parse(input);
  const key = JSON.stringify(request);
  const current = IN_FLIGHT.get(repository);
  const pending = current?.get(key);
  if (pending !== undefined) {
    return pending;
  }
  if (current !== undefined) {
    throw new MeshError('FACTORY_GATED', 'A human decision is being checked for this project. Retry after it settles.');
  }
  const attempt = commitDecision(repository, readIssue, request);
  IN_FLIGHT.set(repository, new Map([[key, attempt]]));
  try {
    return await attempt;
  } finally {
    IN_FLIGHT.delete(repository);
  }
}
