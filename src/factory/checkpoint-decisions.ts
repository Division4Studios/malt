/**
 * Operator continue-or-wait decisions at a checkpoint. A productive attempt
 * that a checkpoint held (no verified quota or machine headroom) or that
 * reached its hard ceiling cannot be suspended by a one-shot CLI, so it stops
 * and asks: its worktree is kept, the attempt records a pending decision with
 * the evidence, and the step is not offered again while the decision waits.
 * `continue` runs the step once more from the preserved worktree, bounded by
 * the granted minutes and without the extension gate; `wait` returns it to the
 * normal retry rules. The operator control that records a decision follows.
 *
 * @file
 */
import { CONTINUE_MIN_MINUTES } from './liveness-schema.ts';

import type { Checkpoint, JobLiveness, LivenessPolicy } from './liveness-schema.ts';
import type { FactoryRepository } from './repository.ts';
import type { StepScope } from './retry-policy.ts';
import type { FactoryJob } from './schema.ts';

/** Milliseconds in one minute. */
const MINUTE_MS = 60_000;

/**
 * Whether a stop at a checkpoint should ask the operator: a held attempt, or
 * one that reached the ceiling while still progressing.
 *
 * @param liveness - Final liveness record.
 * @param policy - Effective policy.
 * @param now - Stop time.
 * @returns True when the stop deserves a decision rather than a plain retry.
 */
export function shouldAskOperator(liveness: JobLiveness, policy: LivenessPolicy, now: number): boolean {
  return liveness.state === 'held' || (liveness.state === 'ceiling' && now - liveness.lastProgressAt < policy.stallMs);
}

/**
 * Record a pending decision on the stopping attempt while its fencing token is current.
 *
 * @param repository - Project ledger.
 * @param job - Stopping attempt.
 * @param liveness - Its final liveness record.
 */
export function askForDecision(repository: FactoryRepository, job: FactoryJob, liveness: JobLiveness): void {
  const current = repository.jobs().find((candidate) => candidate.id === job.id);
  if (current?.state !== 'running' || current.token !== job.token) {
    return;
  }
  const checkpoint: Checkpoint = {
    state: 'pending',
    reason: liveness.stopReason ?? liveness.state,
    lastSignal: liveness.lastSignal,
    lastProgressAt: liveness.lastProgressAt,
    extensions: liveness.extensions,
    askedAt: repository.store.now(),
    minutes: null,
    requestId: null,
    decidedAt: null,
    consumedBy: null,
  };
  repository.saveJob({ ...current, liveness, checkpoint });
  repository.store.event('FACTORY_CHECKPOINT_DECISION', null, {
    jobId: job.id,
    taskId: job.taskId,
    featureId: job.featureId,
    step: job.step,
    reason: checkpoint.reason,
  });
}

/**
 * Whether two attempts ran the same step of the same delivery or objective.
 *
 * @param job - Finished attempt.
 * @param scope - Step being scheduled, or another attempt.
 * @returns True for the same kind, owner, head and step.
 */
export function isSameStep(job: FactoryJob, scope: StepScope): boolean {
  const isOwner =
    scope.taskId === null ? job.taskId === null && job.featureId === scope.featureId : job.taskId === scope.taskId;
  return (
    job.kind === scope.kind &&
    isOwner &&
    (scope.taskId === null || job.head === scope.head) &&
    (job.step === null || scope.step === null || job.step === scope.step)
  );
}

/**
 * The latest finished attempt of a step, which carries any decision for it.
 *
 * @param jobs - Every attempt, oldest first.
 * @param scope - Step being scheduled.
 * @returns Latest finished attempt of that step, if any.
 */
function latestFinished(jobs: readonly FactoryJob[], scope: StepScope): FactoryJob | undefined {
  return jobs.findLast((job) => job.state !== 'running' && isSameStep(job, scope));
}

/**
 * Whether a step waits for the operator's checkpoint decision.
 *
 * @param jobs - Every attempt.
 * @param scope - Step being scheduled.
 * @returns True while its latest attempt's decision is pending.
 */
export function isAwaitingDecision(jobs: readonly FactoryJob[], scope: StepScope): boolean {
  return latestFinished(jobs, scope)?.checkpoint?.state === 'pending';
}

/**
 * Whether the operator granted an unused continuation for a step.
 *
 * @param jobs - Every attempt.
 * @param scope - Step being scheduled.
 * @returns True when its latest attempt carries an unused `continue` decision.
 */
export function hasContinuation(jobs: readonly FactoryJob[], scope: StepScope): boolean {
  const checkpoint = latestFinished(jobs, scope)?.checkpoint;
  return checkpoint?.state === 'continue' && checkpoint.consumedBy === null;
}

/**
 * Use the step's continuation grant for a new attempt: the grant is marked
 * used by this attempt, and the attempt's ceiling becomes the granted minutes
 * from its start with no extension gate.
 *
 * @param repository - Project ledger.
 * @param job - New attempt of the step.
 * @param policy - Its normal policy.
 * @returns The bounded policy when a grant applied, otherwise null.
 */
export function useContinuation(
  repository: FactoryRepository,
  job: FactoryJob,
  policy: LivenessPolicy,
): LivenessPolicy | null {
  return repository.store.transaction(() => {
    const granted = latestFinished(repository.jobs(), job);
    const checkpoint = granted?.checkpoint;
    if (granted === undefined || checkpoint?.state !== 'continue' || checkpoint.consumedBy !== null) {
      return null;
    }
    repository.saveJob({ ...granted, checkpoint: { ...checkpoint, consumedBy: job.id } });
    const maxMs = (checkpoint.minutes ?? CONTINUE_MIN_MINUTES) * MINUTE_MS;
    return { ...policy, maxMs, intervalMs: Math.min(policy.intervalMs, maxMs) };
  });
}
