/**
 * Console projections of attempt liveness and retry backoff: what a running
 * attempt is doing now, why the latest one stopped, and when a delivery's
 * failed step may run again.
 *
 * @file
 */
import { retryState } from './retry-policy.ts';

import type { FailureClass, LivenessState } from './liveness-schema.ts';
import type { FactoryJob, FactoryTask } from './schema.ts';

/** A running attempt's liveness as the console shows it. */
export interface LivenessView {
  /** Progressing, idle, awaiting input, or stopping as stalled, at the ceiling or held. */
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
  /** Why a checkpoint is stopping it, while it stops. */
  readonly stopReason: string | null;
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

/** Why a delivery's latest attempt stopped at a checkpoint. */
export interface StopView {
  /** The stopped attempt. */
  readonly jobId: string;
  /** Recorded stop reason, such as `stalled 16 min` or `hard ceiling`. */
  readonly reason: string;
  /** When it stopped. */
  readonly at: number;
  /** Whether it waits for the operator to continue it or let it wait. */
  readonly isAwaitingDecision: boolean;
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
        stopReason: liveness.stopReason,
      };
}

/**
 * The recorded stop of a delivery's latest settled attempt, instead of a
 * generic `interrupted`.
 *
 * @param task - Delivery.
 * @param jobs - Every attempt, oldest first.
 * @returns Its stop reason and any pending decision, or null when no checkpoint stopped it.
 */
export function stopView(task: FactoryTask, jobs: readonly FactoryJob[]): StopView | null {
  const latest = jobs.findLast((job) => job.taskId === task.id && job.state !== 'running');
  const reason = latest?.liveness?.stopReason ?? null;
  if (latest === undefined || reason === null) {
    return null;
  }
  return {
    jobId: latest.id,
    reason,
    at: latest.finishedAt ?? latest.startedAt,
    isAwaitingDecision: latest.checkpoint?.state === 'pending',
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
