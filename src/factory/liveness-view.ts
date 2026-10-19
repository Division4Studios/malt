/**
 * Console projections of attempt liveness and retry backoff: what a running
 * attempt is doing now, and when a delivery's failed step may run again.
 *
 * @file
 */
import { retryState } from './retry-policy.ts';

import type { FailureClass, LivenessState } from './liveness-schema.ts';
import type { FactoryJob, FactoryTask } from './schema.ts';

/** A running attempt's liveness as the console shows it. */
export interface LivenessView {
  /** Progressing, idle, awaiting input, stalled or at the ceiling. */
  readonly state: LivenessState;
  /** Newest meaningful signal. */
  readonly lastSignal: string | null;
  /** When it last progressed. */
  readonly lastProgressAt: number;
  /** What it waits on, if anything. */
  readonly awaiting: string | null;
  /** Next checkpoint. */
  readonly nextCheckpointAt: number;
  /** Extensions granted so far. */
  readonly extensions: number;
}

/** A delivery step waiting to retry, or out of retries. */
export interface RetryView {
  /** Why its latest attempts failed. */
  readonly failureClass: FailureClass;
  /** Consecutive failures of that class. */
  readonly failures: number;
  /** When it may run again; null once retries are exhausted. */
  readonly retryAt: number | null;
}

/**
 * Describe a running attempt's liveness.
 *
 * @param job - Running attempt.
 * @returns Liveness, or null before the first record.
 */
export function livenessView(job: FactoryJob): LivenessView | null {
  const { liveness } = job;
  return liveness === undefined
    ? null
    : {
        state: liveness.state,
        lastSignal: liveness.lastSignal,
        lastProgressAt: liveness.lastProgressAt,
        awaiting: liveness.awaiting,
        nextCheckpointAt: liveness.nextCheckpointAt,
        extensions: liveness.extensions,
      };
}

/**
 * Whether a delivery's latest failed step is backing off or out of retries.
 *
 * @param task - Delivery.
 * @param jobs - Every attempt.
 * @param timing - Current time and the reconcile interval.
 * @param timing.now - Current time.
 * @param timing.reconcileMs - Project reconcile interval.
 * @returns Retry state while it delays the step, otherwise null.
 */
export function retryView(
  task: FactoryTask,
  jobs: readonly FactoryJob[],
  timing: { now: number; reconcileMs: number },
): RetryView | null {
  const latest = jobs.findLast((job) => job.taskId === task.id && job.state !== 'running');
  if (latest?.failureClass === undefined) {
    return null;
  }
  const scope = {
    kind: latest.kind,
    taskId: task.id,
    featureId: task.featureId,
    head: task.head,
    step: latest.step,
    since: task.repairsResetAt,
  };
  const state = retryState(jobs, scope, timing.reconcileMs);
  return state !== null && (state.retryAt === null || state.retryAt > timing.now) ? state : null;
}
