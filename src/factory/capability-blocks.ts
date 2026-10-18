/**
 * Connector capability denials park their scope once: no effect retries and
 * no model assignments until the project's policy changes or a human
 * resolves the blocker. A policy change resumes parked effects under their
 * original identity and restores each parked scope's phase.
 *
 * @file
 */
import { policyRevision } from '../capability-policy.ts';
import { run } from '../database.ts';
import { MeshError } from '../protocol.ts';

import type { FactoryRepository } from './repository.ts';
import type { FactoryEffect, FactoryTask, Feature } from './schema.ts';

/** A task phase a denial can interrupt; the others already stopped dispatch. */
type ParkablePhase = NonNullable<FactoryTask['capabilityBlock']>['phase'];

/** Task phases a denial can interrupt. */
const PARKABLE_TASK_PHASES: ReadonlySet<string> = new Set<ParkablePhase>([
  'ready',
  'development',
  'publishing',
  'review',
  'merge_ready',
  'merging',
  'verifying',
  'closing',
]);

/**
 * Narrow a task phase to one a denial can interrupt.
 *
 * @param phase - Current or remembered phase.
 * @returns Whether parking may record it.
 */
function isParkable(phase: FactoryTask['phase']): phase is ParkablePhase {
  return PARKABLE_TASK_PHASES.has(phase);
}

/**
 * Persist a pending effect's new state under its unchanged identity, so a
 * resume replays the original operation.
 *
 * @param repository - Project outbox.
 * @param effect - Pending effect with an updated error, schedule or park marker.
 */
function replaceEffect(repository: FactoryRepository, effect: FactoryEffect): void {
  repository.store.transaction(() => {
    run(repository.store.db, 'UPDATE factory_effects SET data=? WHERE id=?', JSON.stringify(effect), effect.id);
  });
}

/**
 * Recognize a policy denial from any connector boundary.
 *
 * @param error - Thrown value.
 * @returns Whether it is CAPABILITY_DENIED.
 */
export function isCapabilityDenied(error: unknown): error is MeshError {
  return error instanceof MeshError && error.code === 'CAPABILITY_DENIED';
}

/**
 * Name the denied capability and the human action that releases it.
 *
 * @param denial - Broker or adapter denial naming capability, mode and principal.
 * @returns Durable operator-facing blocker.
 */
function blocker(denial: MeshError): string {
  return `Connector capability denied; parked with no retries or new assignments. ${denial.message} Grant it with capability-set or the console and this resumes automatically, or resolve the blocker with factory_retry.`;
}

/**
 * Park one delivery, keeping its interrupted phase for an automatic resume.
 * An unrelated existing blocker is left untouched.
 *
 * @param repository - Project ledger.
 * @param taskId - Owning delivery.
 * @param denial - Capability denial.
 */
export function parkTask(repository: FactoryRepository, taskId: string, denial: MeshError): void {
  const { phase } = repository.task(taskId);
  // Already parked or otherwise stopped: no edit, so no version bump or new board status.
  if (!isParkable(phase)) {
    return;
  }
  const revision = policyRevision(repository.store);
  repository.editTask(taskId, (task) => {
    return {
      ...task,
      phase: 'blocked',
      error: blocker(denial),
      capabilityBlock: { phase, revision },
    };
  });
}

/**
 * Park one objective whose provisioning or parent effect was denied.
 *
 * @param repository - Project ledger.
 * @param feature - Owning objective.
 * @param denial - Capability denial.
 */
export function parkFeature(repository: FactoryRepository, feature: Feature, denial: MeshError): void {
  const { phase } = feature;
  if (phase !== 'provisioning' && phase !== 'active') {
    return;
  }
  repository.saveFeature({
    ...feature,
    phase: 'blocked',
    error: blocker(denial),
    capabilityBlock: { phase, revision: policyRevision(repository.store) },
    updatedAt: repository.store.now(),
  });
}

/**
 * Hold a denied effect and park the delivery or objective that owns its issue.
 *
 * @param repository - Project ledger and outbox.
 * @param effect - Denied effect.
 * @param denial - Capability denial.
 */
export function parkEffect(repository: FactoryRepository, effect: FactoryEffect, denial: MeshError): void {
  const hold = (pending: FactoryEffect): void => {
    replaceEffect(repository, {
      ...pending,
      error: blocker(denial),
      retryAt: Number.MAX_SAFE_INTEGER,
      capabilityRevision: policyRevision(repository.store),
    });
  };
  hold(effect);
  const task = repository.tasks().find((candidate) => candidate.issue === effect.issue);
  const feature = repository.features().find((candidate) => candidate.parentIssue === effect.issue);
  if (task !== undefined) {
    parkTask(repository, task.id, denial);
  } else if (feature !== undefined) {
    parkFeature(repository, feature, denial);
  }
  // Parking a delivery coalesces its board status into a newer pending effect; hold it too.
  for (const pending of repository.effects()) {
    if (pending.issue === effect.issue && pending.kind === 'status' && pending.capabilityRevision === undefined) {
      hold(pending);
    }
  }
}

/**
 * Resume everything parked at an older policy revision. A capability that is
 * still denied parks again on its next attempt, replacing the same blocker.
 *
 * @param repository - Project ledger and outbox.
 */
export function resumeCapabilityBlocks(repository: FactoryRepository): void {
  const revision = policyRevision(repository.store);
  for (const effect of repository.effects()) {
    if (effect.capabilityRevision !== undefined && effect.capabilityRevision !== revision) {
      replaceEffect(repository, { ...effect, error: null, retryAt: 0, capabilityRevision: undefined });
    }
  }
  for (const task of repository.tasks()) {
    const block = task.capabilityBlock;
    if (block !== undefined && (task.phase !== 'blocked' || block.revision !== revision)) {
      // A human retry already moved the task: only the stale marker goes.
      repository.editTask(task.id, (current) => {
        return {
          ...current,
          ...(current.phase === 'blocked' && { phase: block.phase, error: null }),
          capabilityBlock: undefined,
        };
      });
    }
  }
  for (const feature of repository.features()) {
    const block = feature.capabilityBlock;
    if (block === undefined || (feature.phase === 'blocked' && block.revision === revision)) {
      continue;
    }
    repository.saveFeature({
      ...feature,
      ...(feature.phase === 'blocked' && { phase: block.phase, error: null }),
      capabilityBlock: undefined,
      updatedAt: repository.store.now(),
    });
  }
}
