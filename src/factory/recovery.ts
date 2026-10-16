/**
 * Exact-request operator recovery preserves objectives, tickets and paid evidence.
 *
 * @file
 */
import { z } from 'zod/v3';

import { run, selectOne } from '../database.ts';
import { MeshError } from '../protocol.ts';

import { retryFeaturePhase } from './scheduler.ts';
import { factorySchemas, resultSchema } from './schema.ts';

import type { FactoryRepository } from './repository.ts';
import type { FactoryTask, Feature } from './schema.ts';

/**
 * Retry existing blocked scopes without changing their delivery gates.
 *
 * @param repository - Selected project ledger.
 * @param input - Validated retry control.
 * @throws {MeshError} For a nonblocked or superseded scope.
 */
export function retryBlocked(repository: FactoryRepository, input: unknown): void {
  const value = factorySchemas.factory_retry.parse(input);
  if (value.taskId !== undefined) {
    repository.editTask(value.taskId, (task) => {
      if (task.phase !== 'blocked' || task.scopeReplacement !== undefined) {
        throw new MeshError('INVALID_INPUT', 'Only blocked deliveries can be retried.');
      }
      return {
        ...task,
        phase: task.merge === null ? 'development' : 'verifying',
        attempts: 0,
        error: null,
        reviews: [],
        finalReview: null,
      };
    });
  }
  if (value.featureId === undefined) {
    return;
  }
  const feature = repository.features().find((candidate) => candidate.id === value.featureId);
  if (feature?.phase !== 'blocked' || feature.scopeReplacement !== undefined) {
    throw new MeshError('INVALID_INPUT', 'Only blocked product requests can be retried.');
  }
  repository.saveFeature({ ...feature, phase: retryFeaturePhase(feature), error: null });
}

/** Objective phases each recovery action may change. */
const RECOVERABLE: Readonly<Record<string, readonly string[]>> = {
  lead: ['blocked'],
  owner: ['blocked'],
  existing: ['blocked'],
  retire: ['queued', 'active'],
};

/**
 * Resume a blocked planner, admit retained deliveries without new objectives,
 * or retire a finished objective whose parent issue is closed.
 *
 * @param repository - Selected project ledger.
 * @param input - Human decision against the displayed revision.
 * @param closedParent - Parent issue just re-read as closed on GitHub; required only to retire.
 * @returns Stable recovery receipt; retries never enqueue another instruction.
 * @throws {MeshError} For changed intent, stale state or an active assignment.
 */
export function recoverObjective(
  repository: FactoryRepository,
  input: unknown,
  closedParent: number | null = null,
): { featureId: string } {
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
      feature === undefined ||
      !(RECOVERABLE[value.action] ?? []).includes(feature.phase) ||
      feature.scopeReplacement !== undefined ||
      feature.updatedAt !== value.expectedUpdatedAt
    ) {
      throw new MeshError('FACTORY_GATED', 'The objective changed. Refresh before deciding how to recover.');
    }
    const tasks = repository.tasks().filter((task) => task.featureId === feature.id);
    assertUnowned(repository, feature, tasks);
    if (value.action === 'retire') {
      retire(repository, feature, tasks, closedParent);
    } else if (value.action === 'existing') {
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

/**
 * Reject recovery while an assignment owns the objective or one of its deliveries.
 *
 * @param repository - Project ledger.
 * @param feature - Objective under decision.
 * @param tasks - Its deliveries.
 * @throws {MeshError} When a running job owns it.
 */
function assertUnowned(repository: FactoryRepository, feature: Feature, tasks: readonly FactoryTask[]): void {
  const isOwned = repository
    .jobs()
    .some(
      (job) =>
        job.state === 'running' && (job.featureId === feature.id || tasks.some((task) => task.id === job.taskId)),
    );
  if (isOwned) {
    throw new MeshError('FACTORY_GATED', 'Cancel the owned assignment before recovering this objective.');
  }
}

/**
 * Mark a finished objective done in the ledger only; GitHub is never mutated.
 *
 * @param repository - Ledger inside the recovery transaction.
 * @param feature - Current queued or active objective.
 * @param tasks - Its deliveries.
 * @param closedParent - Parent issue re-read as closed.
 * @throws {MeshError} When the parent was not re-read as closed or a delivery is unfinished.
 */
function retire(
  repository: FactoryRepository,
  feature: Feature,
  tasks: readonly FactoryTask[],
  closedParent: number | null,
): void {
  if (feature.parentIssue === null || closedParent !== feature.parentIssue) {
    throw new MeshError('FACTORY_GATED', 'Retirement requires its parent issue to be re-read as closed on GitHub.');
  }
  if (tasks.some((task) => task.phase !== 'done' && task.scopeReplacement === undefined)) {
    throw new MeshError('FACTORY_GATED', 'Adopt or finish every delivery of this objective before retiring it.');
  }
  repository.saveFeature({
    ...feature,
    phase: 'done',
    error: null,
    updatedAt: Math.max(repository.store.now(), feature.updatedAt + 1),
  });
}
