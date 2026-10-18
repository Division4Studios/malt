/**
 * Deliveries whose current step used every retry of its failure class stop
 * being offered work. Blocking them makes that stop visible and recoverable:
 * the operator fixes the cause and retries the delivery, which also starts
 * the step's retry count afresh.
 *
 * @file
 */
import { retryView } from './liveness-view.ts';

import type { FactoryRepository } from './repository.ts';
import type { FactoryTask } from './schema.ts';

/** Phases in which a delivery's steps are scheduled. */
const SCHEDULED: ReadonlySet<FactoryTask['phase']> = new Set([
  'ready',
  'development',
  'review',
  'merge_ready',
  'verifying',
]);

/**
 * Block each delivery whose current step is out of retries.
 *
 * @param repository - Project ledger.
 * @param reconcileMs - Project reconcile interval.
 */
export function blockExhausted(repository: FactoryRepository, reconcileMs: number): void {
  const jobs = repository.jobs();
  const timing = { now: repository.store.now(), reconcileMs };
  for (const task of repository.tasks()) {
    const isIdle = task.hold === null && jobs.every((job) => job.state !== 'running' || job.taskId !== task.id);
    const retry = isIdle && SCHEDULED.has(task.phase) ? retryView(task, jobs, timing) : null;
    if (retry?.retryAt !== null) {
      continue;
    }
    const failures = `${String(retry.failures)} consecutive ${retry.failureClass.replaceAll('_', ' ')} failures`;
    repository.editTask(task.id, (current) => {
      return {
        ...current,
        phase: 'blocked',
        error: `Stopped after ${failures} of the same step. Fix the cause, then retry the delivery.`,
      };
    });
  }
}
