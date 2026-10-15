/**
 * Confirm durable Project tracking before spending a delivery model turn.
 *
 * @file
 */
import type { FactoryRepository } from './repository.ts';
import type { FactoryEffect, FactoryJob } from './schema.ts';

/** Stage names are authoritative; provider output cannot choose board states. */
const STAGES = new Map<FactoryJob['kind'], string>([
  ['develop', 'Development'],
  ['review', 'QA / Review'],
  ['final', 'Merge Ready'],
  ['verify', 'Final Verification'],
]);

/**
 * Reattach the current ticket using idempotent, checkpointed status operations.
 *
 * @param input - Live assignment, durable ledger and authenticated remote boundary.
 * @returns Unpaid waiting reason when remote tracking cannot be confirmed.
 */
export async function ensureProjectTracking(input: {
  repository: FactoryRepository;
  job: FactoryJob;
  sync: (effect: FactoryEffect) => Promise<void>;
  signal: AbortSignal;
}): Promise<string | null> {
  const { repository, job, sync, signal } = input;
  const value = STAGES.get(job.kind);
  if (value === undefined || job.taskId === null) {
    return null;
  }
  const task = repository.task(job.taskId);
  const effect: FactoryEffect = {
    id: `project-tracking:${job.id}`,
    kind: 'status',
    issue: task.issue,
    value,
    attempts: 0,
    retryAt: repository.store.now(),
    error: null,
  };
  signal.throwIfAborted();
  repository.enqueueEffect(effect);
  try {
    await sync(effect);
  } catch (error) {
    const reason = Error.isError(error) ? error.message : 'Remote tracking failed.';
    repository.settleEffect(effect, reason);
    repository.discardEffect(
      effect.id,
      'The next unpaid tracking gate retries current state; do not replay an obsolete assignment status.',
    );
    return `Project attachment/status not confirmed; no model turn started. ${reason}`;
  }
  repository.settleEffect(effect, null);
  signal.throwIfAborted();
  return null;
}
