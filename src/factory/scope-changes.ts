/**
 * Transactional scope replacement: park obsolete work before new planning can
 * dispatch, retain completed proof and preserve every owned source checkout.
 *
 * @file
 */
import { queueObjective } from './objectives.ts';

import type { FactoryRepository } from './repository.ts';
import type { FactoryTask } from './schema.ts';

/** Keep the full feedback in its durable instruction, with a bounded planning excerpt. */
const FEEDBACK_EXCERPT = 24_000;
/** Bound objective context while keeping the full affected set in the durable event. */
const FROZEN_PREVIEW = 100;

/**
 * Freeze affected unmerged deliveries and their dependent scopes atomically.
 *
 * @param repository - Selected project's authoritative ledger.
 * @param input - Validated operator change and durable instruction identity.
 * @returns Replacement objective identity and stopped task identities.
 */
export function replaceScope(
  repository: FactoryRepository,
  input: { body: string; taskId?: string | undefined; instructionId: string },
): { featureId: string; taskIds: string[] } {
  return repository.store.transaction(() => {
    const tasks = repository.tasks();
    const affected = affectedTasks(tasks, input.taskId);
    const frozen =
      affected.size === 0 ? 'none (retain completed/merged proof)' : [...affected].slice(0, FROZEN_PREVIEW).join(', ');
    const { featureId } = queueObjective(repository, {
      requestId: input.instructionId,
      objective: `Clarify and independently review this operator scope change before implementation: ${input.body.slice(0, FEEDBACK_EXCERPT)}. Full feedback instruction: ${input.instructionId}. Related delivery: ${input.taskId ?? 'project-wide'}. Frozen obsolete deliveries: ${frozen}. Preserve existing edits and evidence; inspect retained worktrees and account for dependencies.`,
    });
    for (const id of affected) {
      repository.editTask(id, (task) => {
        return {
          ...task,
          phase: 'blocked',
          scopeReplacement: featureId,
          reviews: [],
          finalReview: null,
          verifiedMain: null,
          error: `Scope superseded by objective ${featureId}; retained source must be accounted for by product owner and lead.`,
        };
      });
    }
    if (input.taskId === undefined) {
      for (const feature of repository.features()) {
        if (feature.id === featureId || feature.phase === 'done') {
          continue;
        }

        const isMergedPending = tasks.some(
          (task) => task.featureId === feature.id && task.merge !== null && task.phase !== 'done',
        );
        repository.saveFeature({
          ...feature,
          scopeReplacement: featureId,
          phase: isMergedPending ? 'active' : 'blocked',
          error: `Scope superseded by objective ${featureId}.`,
          updatedAt: repository.store.now(),
        });
      }
    }
    repository.store.event('FACTORY_SCOPE_REPLACED', null, {
      featureId,
      taskIds: [...affected],
      instructionId: input.instructionId,
    });
    repository.notify(
      `Scope change ${featureId}: obsolete unmerged scopes are parked; completed proof and merged-main verification are retained. Product owner and lead will plan the replacement.`,
    );
    return { featureId, taskIds: [...affected] };
  });
}

/**
 * Include unmerged dependents transitively, without invalidating delivered proof.
 *
 * @param tasks - Current project deliveries.
 * @param taskId - Optional selected scope; absent means project-wide.
 * @returns All affected unmerged task identities.
 */
function affectedTasks(tasks: FactoryTask[], taskId: string | undefined): Set<string> {
  const affected = new Set(
    tasks
      .filter((task) => task.phase !== 'done' && task.merge === null && (taskId === undefined || task.id === taskId))
      .map((task) => task.id),
  );
  let isAdded = true;
  while (isAdded) {
    isAdded = false;
    for (const task of tasks) {
      if (!(
        task.phase !== 'done' &&
        task.merge === null &&
        !affected.has(task.id) &&
        task.dependencies.some((id) => affected.has(id))
      )) {
        continue;
      }

      affected.add(task.id);
      isAdded = true;
    }
  }

  return affected;
}
