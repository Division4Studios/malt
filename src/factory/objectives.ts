/**
 * Durable idempotent product objectives shared by operator and maintenance queues.
 *
 * @file
 */
import { randomUUID } from 'node:crypto';

import { MeshError } from '../protocol.ts';

import { factorySchemas } from './schema.ts';

import type { FactoryRepository } from './repository.ts';

/**
 * Persist a product objective once, rejecting changed retry intent.
 *
 * @param repository - Selected target project's durable ledger.
 * @param input - Validated or untrusted operator scope.
 * @returns Stable feature identity.
 * @throws {MeshError} If the same request ID denotes a different objective.
 */
export function queueObjective(repository: FactoryRepository, input: unknown): { featureId: string } {
  const { objective, requestId } = factorySchemas.factory_request.parse(input);
  const id = requestId ?? randomUUID();
  const prior = repository.features().find((feature) => feature.id === id);
  if (prior !== undefined) {
    if (prior.objective !== objective) {
      throw new MeshError('INVALID_INPUT', 'An objective request ID cannot be reused for a changed scope.');
    }
    return { featureId: id };
  }
  const now = repository.store.now();
  repository.store.transaction(() => {
    repository.saveFeature({
      id,
      objective,
      phase: 'queued',
      productPlan: null,
      plan: null,
      parentIssue: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    });
    repository.notify(`Product objective queued: ${objective}`);
  });
  return { featureId: id };
}
