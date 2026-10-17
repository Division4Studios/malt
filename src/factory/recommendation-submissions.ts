/** @file Live-claim-fenced product/lead proposals; agents never decide or execute them. */
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import { z } from 'zod/v3';

import { run, selectOne } from '../database.ts';
import { MeshError } from '../protocol.ts';
import { SecretRedactor } from '../secrets.ts';

import { credentialValues } from './authentication.ts';
import { retryRecommendation } from './recommendation-execution.ts';
import { recommendationAddress } from './recommendation-read-schema.ts';
import { factorySchemas, recommendationBodySchema } from './schema.ts';
import { managedSourceJob } from './source-reader.ts';

import type { FactoryContext } from './context.ts';
import type { FactoryRepository } from './repository.ts';
import type { FactoryJob, RecommendationBody } from './schema.ts';

/** Prevent one live role from flooding the human queue. */
const MAX_SUBMISSIONS = 20;
/** Leave room for bounded inline audit/read metadata around proposal content. */
const MAX_BYTES = 131_072;
/** Durable operation identity and original recorded result, not mutable current state. */
const receiptSchema = z.object({
  bodyHash: z.string(),
  result: z.object({ id: z.string(), revision: z.string(), recordedState: z.string(), operationId: z.string() }),
});
/** Project-owned metadata never leaves the broker as credentials. */
const rowSchema = z.object({ value: z.string() });

/**
 * Route recommendation controls without requiring native setup for read-only inspection.
 *
 * @param configured - Lazy validated native context for managed submission only.
 * @param repository - Existing project-owned ledger.
 * @param input - Validated wire payload.
 * @param actorId - Authenticated caller.
 * @returns Existing factory handlers, without an alternate scheduler or state store.
 */
export function recommendationHandlers(
  configured: () => FactoryContext,
  repository: FactoryRepository,
  input: unknown,
  actorId: string | null,
): Record<
  | 'factory_recommendation_propose'
  | 'factory_recommendations'
  | 'factory_recommendation_read'
  | 'factory_recommendation_retry',
  () => unknown
> {
  return {
    factory_recommendation_propose: () => submitRecommendation(configured(), input, actorId),
    factory_recommendations: () => repository.recommendations.inspect(input),
    factory_recommendation_read: () => repository.recommendations.readReceipt(input),
    factory_recommendation_retry: () => retryRecommendation(configured(), input),
  };
}

/**
 * Redact private credentials without changing ticket or assignment identities.
 *
 * @param context - Target project secrets boundary.
 * @param job - Exact current managed claim.
 * @param input - Validated proposal, treated as untrusted evidence.
 * @returns Canonical bounded secret-redacted content.
 * @throws {MeshError} For missing exact observed revisions or excessive content.
 */
function safeProposal(context: FactoryContext, job: FactoryJob, input: RecommendationBody): RecommendationBody {
  const body = recommendationBodySchema.parse(input);
  if (body.observedIssues.some((issue) => !recommendationAddress.safeParse(issue.revision).success)) {
    throw new MeshError('INVALID_INPUT', 'Use exact scoped issue-corpus revisions for every referenced native issue.');
  }
  const redactor = new SecretRedactor([context.mesh.token, job.token, ...credentialValues(process.env)]);
  const safe = recommendationBodySchema.parse({
    ...body,
    action: redactor.redact(body.action),
    evidence: body.evidence.map((item) => redactor.redact(item)),
    transferredAcceptance: body.transferredAcceptance.map((item) => redactor.redact(item)),
    preview: { before: redactor.redact(body.preview.before), after: redactor.redact(body.preview.after) },
  });
  if (Buffer.byteLength(JSON.stringify(safe)) > MAX_BYTES) {
    throw new MeshError('INVALID_INPUT', 'Keep a recommendation within 128 KiB; use focused evidence and references.');
  }
  return safe;
}

/**
 * Accept only the product owner or lead holding this project's current managed claim.
 *
 * @param context - Authoritative target project ledger.
 * @param actorId - Broker-authenticated identity, never a proposal field.
 * @returns Live owned job, without exposing its token.
 * @throws {MeshError} For paused, unmanaged, expired or other-role requests.
 */
function submissionJob(context: FactoryContext, actorId: string | null): FactoryJob {
  const job = managedSourceJob(context, actorId);
  if (!context.repository.active() || !['product-owner', 'team-lead'].includes(job.role)) {
    throw new MeshError(
      'FACTORY_GATED',
      'Only a live managed product-owner or team-lead assignment may submit recommendations.',
    );
  }
  return job;
}

/**
 * Persist a human-queue proposal and provenance in one transaction.
 *
 * @param context - Selected project and existing recommendation ledger.
 * @param input - Stable per-job key and proposal content.
 * @param actorId - Authenticated managed session.
 * @returns Original recorded receipt on replay, never an approval or execution claim.
 * @throws {MeshError} For changed keys, excessive submissions or a stale claim.
 */
export function submitRecommendation(context: FactoryContext, input: unknown, actorId: string | null): unknown {
  const value = factorySchemas.factory_recommendation_propose.parse(input);
  const job = submissionJob(context, actorId);
  const body = safeProposal(context, job, value.proposal);
  const bodyHash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
  const prefix = `factory_recommendation_submission:${job.id}:`;
  const operationId = `${prefix}${value.key}`;
  const { repository } = context;
  return repository.store.transaction(() => {
    const current = submissionJob(context, actorId);
    if (current.id !== job.id || current.token !== job.token) {
      throw new MeshError('FACTORY_GATED', 'This submission no longer owns its original managed claim.');
    }
    const saved = selectOne(repository.store.db, rowSchema, 'SELECT value FROM metadata WHERE key=?', operationId);
    if (saved !== undefined) {
      const receipt = receiptSchema.parse(JSON.parse(saved.value));
      if (receipt.bodyHash !== bodyHash) {
        throw new MeshError('INVALID_INPUT', 'A submission key cannot identify different proposal content.');
      }
      return receipt.result;
    }
    const count = selectOne(
      repository.store.db,
      z.object({ total: z.number() }),
      'SELECT count(*) AS total FROM metadata WHERE substr(key,1,?)=?',
      prefix.length,
      prefix,
    );
    if ((count?.total ?? 0) >= MAX_SUBMISSIONS) {
      throw new MeshError('FACTORY_GATED', 'Recommendation submission limit reached for this managed assignment.');
    }
    let record = repository.recommendations.propose(body);
    if (record.state === 'proposed') {
      record = repository.recommendations.transition({
        id: record.id,
        revision: record.revision,
        state: 'proposed',
        next: 'awaiting_human',
        reason: `${job.role} submitted evidence for human review; no effects authorized.`,
      });
    }
    const result = { id: record.id, revision: record.revision, recordedState: record.state, operationId };
    run(
      repository.store.db,
      'INSERT INTO metadata(key,value) VALUES(?,?)',
      operationId,
      JSON.stringify({ bodyHash, result }),
    );
    repository.store.event('FACTORY_RECOMMENDATION_SUBMITTED', actorId, {
      jobId: job.id,
      role: job.role,
      featureId: job.featureId,
      taskId: job.taskId,
      id: record.id,
      revision: record.revision,
      operationId,
    });
    return result;
  });
}
