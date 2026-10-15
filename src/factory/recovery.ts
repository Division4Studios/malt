/**
 * Exact-request operator recovery preserves objectives, tickets and paid evidence.
 *
 * @file
 */
import { z } from 'zod/v3';

import { run, selectOne } from '../database.ts';
import { MeshError } from '../protocol.ts';

import { factorySchemas, resultSchema } from './schema.ts';

import type { FactoryRepository } from './repository.ts';

/**
 * Resume a blocked planner or admit retained deliveries without new objectives.
 *
 * @param repository - Selected project ledger.
 * @param input - Human decision against the displayed revision.
 * @returns Stable recovery receipt; retries never enqueue another instruction.
 * @throws {MeshError} For changed intent, stale state or an active assignment.
 */
export function recoverObjective(repository: FactoryRepository, input: unknown): { featureId: string } {
  const value = factorySchemas.factory_recover.parse(input);
  repository.store.db.exec('CREATE TABLE IF NOT EXISTS factory_recovery (id TEXT PRIMARY KEY, input TEXT NOT NULL)');
  return repository.store.transaction(() => {
    const prior = selectOne(
      repository.store.db,
      z.object({ input: z.string() }),
      'SELECT input FROM factory_recovery WHERE id=?',
      value.requestId,
    );
    if (prior !== undefined) {
      if (prior.input !== JSON.stringify(value)) {
        throw new MeshError('INVALID_INPUT', 'Recovery identity was reused with different content.');
      }
      return { featureId: value.featureId };
    }
    const feature = repository.features().find((item) => item.id === value.featureId);
    if (
      feature?.phase !== 'blocked' ||
      feature.scopeReplacement !== undefined ||
      feature.updatedAt !== value.expectedUpdatedAt
    ) {
      throw new MeshError('FACTORY_GATED', 'The objective changed. Refresh before deciding how to recover.');
    }
    if (repository.jobs().some((job) => job.state === 'running' && job.featureId === feature.id)) {
      throw new MeshError('FACTORY_GATED', 'Cancel the owned assignment before recovering this objective.');
    }
    if (value.action === 'existing') {
      const queue = repository.objectiveQueue.read();
      repository.objectiveQueue.update({
        expectedRevision: queue.revision,
        order: queue.order,
        focusedFeatureId: feature.id,
        existingOnly: true,
      });
    } else {
      const role = value.action === 'lead' ? 'team-lead' : 'product-owner';
      const handoff =
        feature.productPlan ??
        resultSchema.parse({
          outcome: 'blocked',
          summary: feature.error ?? feature.objective,
          findings: [],
          deliveries: [],
          skillActions: [],
          instructionReceipts: [],
        });
      const instructionId = repository.instruct(
        role,
        null,
        `Recovery for objective ${feature.id}: ${value.note}. Preserve existing tickets and edits. Return your structured result to the supervisor; a live peer session is not required.`,
      );
      repository.instructionLedger.scope(instructionId, feature.id);
      repository.saveFeature({
        ...feature,
        phase: value.action === 'lead' ? 'refining' : 'queued',
        productPlan: value.action === 'lead' ? handoff : null,
        plan: null,
        error: null,
        updatedAt: Math.max(repository.store.now(), feature.updatedAt + 1),
      });
    }
    run(repository.store.db, 'INSERT INTO factory_recovery VALUES(?,?)', value.requestId, JSON.stringify(value));
    repository.store.event('FACTORY_OBJECTIVE_RECOVERED', null, value);
    return { featureId: feature.id };
  });
}
