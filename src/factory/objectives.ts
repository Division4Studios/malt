/**
 * Durable idempotent product objectives shared by operator and maintenance queues.
 *
 * @file
 */
import { randomUUID } from 'node:crypto';

import { MeshError } from '../protocol.ts';

import { MAX_OBJECTIVES } from './objective-queue-schema.ts';
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
  return repository.store.transaction(() => {
    const features = repository.features();
    const prior = features.find((feature) => feature.id === id);
    if (prior !== undefined) {
      if (prior.objective !== objective) {
        throw new MeshError('INVALID_INPUT', 'An objective request ID cannot be reused for a changed scope.');
      }
      return { featureId: id };
    }
    if (
      features.filter((feature) => feature.phase !== 'done' && feature.scopeReplacement === undefined).length >=
      MAX_OBJECTIVES
    ) {
      throw new MeshError(
        'FACTORY_GATED',
        'This project has 5,000 unfinished objectives. Complete or supersede existing work before adding more.',
      );
    }
    const now = repository.store.now();
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
    return { featureId: id };
  });
}
