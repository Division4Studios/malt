/**
 * Durable operator mutation identities survive lost responses and restarts.
 *
 * @file
 */
import { createHash, randomUUID } from 'node:crypto';

import { z } from 'zod/v3';

import { run, selectOne } from '../database.ts';
import { MeshError } from '../protocol.ts';

import type { FactoryRepository } from './repository.ts';
import type { factorySchemas } from './schema.ts';

/** Validated scope-replacement task identities. */
const taskIdsSchema = z.array(z.string().uuid());
/** Scope replacement identity returned by one committed instruction. */
const replacementSchema = z.object({ featureId: z.string().uuid(), taskIds: taskIdsSchema });
/** Exact committed control result, without credential material. */
const decisionSchema = z.object({ instructionId: z.string().uuid(), replacement: replacementSchema.nullable() });
/** Persisted operation fingerprint and validated JSON result. */
const requestSchema = z.object({ fingerprint: z.string(), data: z.string() });
/** One instruction's committed decision. */
type Decision = z.output<typeof decisionSchema>;

/**
 * Commit one instruction or return its prior decision without replaying effects.
 *
 * @param repository - Selected project transaction boundary.
 * @param input - Validated operator intent and optional stable request ID.
 * @param apply - Instruction, scope fencing and notifications in one transaction.
 * @returns Durable decision and whether effects were freshly applied.
 * @throws {MeshError} For changed content under a previously used identity.
 */
export function applyInstructionRequest(
  repository: FactoryRepository,
  input: z.output<typeof factorySchemas.factory_instruct>,
  apply: () => Decision,
): { decision: Decision; isFresh: boolean } {
  const id = input.requestId ?? randomUUID();
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ role: input.role, body: input.body, taskId: input.taskId ?? null, replan: input.replan }))
    .digest('hex');
  return repository.store.transaction(() => {
    const prior = selectOne(
      repository.store.db,
      requestSchema,
      'SELECT fingerprint,data FROM factory_operator_requests WHERE id=?',
      id,
    );
    if (prior !== undefined) {
      if (prior.fingerprint !== fingerprint) {
        throw new MeshError('INVALID_INPUT', 'This instruction request identity already belongs to different content.');
      }
      return { decision: decisionSchema.parse(JSON.parse(prior.data)), isFresh: false };
    }
    const decision = apply();
    run(
      repository.store.db,
      'INSERT INTO factory_operator_requests VALUES(?,?,?,?)',
      id,
      fingerprint,
      JSON.stringify(decision),
      repository.store.now(),
    );
    return { decision, isFresh: true };
  });
}
