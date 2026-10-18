/**
 * Retry with backoff by failure class. Each settled attempt that did not
 * succeed records why; the scheduler then waits a class-specific delay before
 * offering the same step again, doubling it for consecutive failures of the
 * same class, and stops offering the step once the class cap is reached so
 * no paid turn is spent repeating a failure. A new head, a different step or
 * a success resets the count. Attempts saved before classification keep the
 * previous rule: a failure waits one reconcile interval, an interruption none.
 *
 * @file
 */
import { MeshError } from '../protocol.ts';

import type { ExecutedJob } from './context.ts';
import type { FailureClass } from './liveness-schema.ts';
import type { FactoryJob } from './schema.ts';

/** Thirty seconds. */
const HALF_MINUTE_MS = 30_000;
/** One minute. */
const MINUTE_MS = 60_000;
/** Two minutes. */
const TWO_MINUTES_MS = 120_000;
/** Five minutes. */
const FIVE_MINUTES_MS = 300_000;
/** Ten minutes. */
const TEN_MINUTES_MS = 600_000;
/** Fifteen minutes. */
const FIFTEEN_MINUTES_MS = 900_000;
/** Thirty minutes. */
const THIRTY_MINUTES_MS = 1_800_000;

/** Delay and cap for one failure class; a null base waits one reconcile interval. */
export interface RetryRule {
  /** First delay, or null for the project's reconcile interval. */
  readonly baseMs: number | null;
  /** Longest delay after doubling. */
  readonly maxMs: number;
  /** Consecutive failures after which the step is no longer offered; null never stops. */
  readonly cap: number | null;
}

/** The retry policy, as data. */
export const RETRY_POLICY: Readonly<Record<FailureClass, RetryRule>> = {
  // Provider cooldowns already gate the provider; this spaces repeated limit hits.
  rate_limit: { baseMs: MINUTE_MS, maxMs: FIFTEEN_MINUTES_MS, cap: 6 },
  transient: { baseMs: HALF_MINUTE_MS, maxMs: TEN_MINUTES_MS, cap: 5 },
  stalled: { baseMs: FIVE_MINUTES_MS, maxMs: THIRTY_MINUTES_MS, cap: 3 },
  invalid_output: { baseMs: TWO_MINUTES_MS, maxMs: TEN_MINUTES_MS, cap: 3 },
  // Unpaid gates re-check on the reconcile cadence and never exhaust.
  gate: { baseMs: null, maxMs: TEN_MINUTES_MS, cap: null },
  // Operator, pause and shutdown interruptions retry as soon as work resumes.
  cancelled: { baseMs: 0, maxMs: 0, cap: null },
};

/** Patterns that identify provider limits in failure text. */
const LIMIT_PATTERN = /rate.?limit|usage.?limit|quota|\b429\b/iv;
/** Patterns that identify unusable provider output. */
const OUTPUT_PATTERN =
  /invalid (?:structured )?(?:output|result)|json|no valid provider result|schema|unexpected token/iv;

/** What settlement knows about a finished attempt. */
export interface AttemptFacts {
  /** Fenced process state. */
  readonly state: 'succeeded' | 'failed' | 'interrupted';
  /** Unpaid gate the attempt parked on, if any. */
  readonly waiting: string | null;
  /** Recorded failure or interruption reason. */
  readonly reason: string | null;
  /** Error that failed the attempt, if any. */
  readonly error?: unknown;
  /** Whether a verified provider cooldown is in force. */
  readonly isCoolingDown: boolean;
  /** Whether the provider ran but returned no usable result. */
  readonly isResultMissing: boolean;
  /** Liveness stop reason, when a checkpoint stopped the attempt. */
  readonly stopReason: string | null;
  /** Whether the supervisor is stopping. */
  readonly isStopping: boolean;
}

/**
 * Classify a settled attempt.
 *
 * @param facts - Settlement evidence.
 * @returns Failure class, or null for a success.
 */
export function classifyAttempt(facts: AttemptFacts): FailureClass | null {
  if (facts.state === 'succeeded') {
    return null;
  }
  if (facts.waiting !== null || (facts.error instanceof MeshError && facts.error.code === 'FACTORY_GATED')) {
    return 'gate';
  }
  if (facts.isCoolingDown || LIMIT_PATTERN.test(facts.reason ?? '')) {
    return 'rate_limit';
  }
  if (facts.stopReason !== null) {
    return 'stalled';
  }
  if (facts.state === 'interrupted') {
    return 'cancelled';
  }
  return facts.isResultMissing || OUTPUT_PATTERN.test(facts.reason ?? '') ? 'invalid_output' : 'transient';
}

/**
 * Classify a settling attempt from the supervisor's own evidence.
 *
 * @param attempt - Fenced state, execution, reason and error.
 * @param attempt.state - Fenced process state.
 * @param attempt.execution - Provider and check result, if any ran.
 * @param attempt.reason - Recorded failure or interruption reason.
 * @param attempt.error - Error that failed the attempt, if any.
 * @param context - Settlement time, liveness stop and supervisor state.
 * @param context.now - Settlement time.
 * @param context.stopReason - Liveness checkpoint stop, if one stopped the attempt.
 * @param context.isStopping - Whether the supervisor is stopping.
 * @returns Failure class, or null for a success.
 */
export function classifySettlement(
  attempt: { state: AttemptFacts['state']; execution: ExecutedJob | null; reason: string | null; error: unknown },
  context: { now: number; stopReason: string | null; isStopping: boolean },
): FailureClass | null {
  const completion = attempt.execution?.completion ?? null;
  return classifyAttempt({
    state: attempt.state,
    waiting: attempt.execution?.waiting ?? null,
    reason: attempt.reason,
    error: attempt.error,
    isCoolingDown: (completion?.cooldownUntil ?? 0) > context.now,
    isResultMissing: completion !== null && completion.result === null,
    stopReason: context.stopReason,
    isStopping: context.isStopping,
  });
}

/** Scope of one schedulable step. */
export interface StepScope {
  /** Assignment kind. */
  readonly kind: FactoryJob['kind'];
  /** Delivery, absent for planning. */
  readonly taskId: string | null;
  /** Objective, used for planning steps. */
  readonly featureId: string | null;
  /** Source head, for delivery steps. */
  readonly head: string | null;
  /** Workflow step. */
  readonly step: string | null;
}

/** Retry state of one step. */
export interface RetryState {
  /** Class of the latest consecutive failures. */
  readonly failureClass: FailureClass;
  /** Consecutive failures of that class. */
  readonly failures: number;
  /** When the step may run again; null once retries are exhausted. */
  readonly retryAt: number | null;
}

/**
 * Whether a finished attempt belongs to a step scope.
 *
 * @param job - Attempt.
 * @param scope - Step being scheduled.
 * @returns True for the same kind, delivery or objective, head and step.
 */
function isSameScope(job: FactoryJob, scope: StepScope): boolean {
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
 * The retry state of a step from its finished attempts, newest last.
 *
 * @param jobs - Every attempt.
 * @param scope - Step being scheduled.
 * @param reconcileMs - Project reconcile interval.
 * @returns Retry state, or null when the step may run now.
 */
export function retryState(jobs: readonly FactoryJob[], scope: StepScope, reconcileMs: number): RetryState | null {
  const finished = jobs.filter((job) => job.state !== 'running' && isSameScope(job, scope));
  const latest = finished.at(-1);
  if (latest === undefined || latest.state === 'succeeded') {
    return null;
  }
  const failureClass = latest.failureClass ?? null;
  const finishedAt = latest.finishedAt ?? latest.startedAt;
  if (failureClass === null) {
    // Attempts saved before classification: a failure waits one reconcile interval.
    return latest.state === 'failed'
      ? { failureClass: 'transient', failures: 1, retryAt: finishedAt + reconcileMs }
      : null;
  }
  let failures = 0;
  for (const job of finished.toReversed()) {
    if (job.state === 'succeeded' || job.failureClass !== failureClass) {
      break;
    }
    failures += 1;
  }
  const rule = RETRY_POLICY[failureClass];
  if (rule.cap !== null && failures >= rule.cap) {
    return { failureClass, failures, retryAt: null };
  }
  const base = rule.baseMs ?? reconcileMs;
  const delay = rule.baseMs === null ? base : Math.min(base * 2 ** (failures - 1), rule.maxMs);
  return { failureClass, failures, retryAt: finishedAt + delay };
}

/**
 * Whether a step must wait before it is offered again.
 *
 * @param jobs - Every attempt.
 * @param scope - Step being scheduled.
 * @param timing - Current time and the reconcile interval.
 * @param timing.now - Current time.
 * @param timing.reconcileMs - Project reconcile interval.
 * @returns True while backing off or once retries are exhausted.
 */
export function isBackingOff(
  jobs: readonly FactoryJob[],
  scope: StepScope,
  timing: { now: number; reconcileMs: number },
): boolean {
  const state = retryState(jobs, scope, timing.reconcileMs);
  return state !== null && (state.retryAt === null || state.retryAt > timing.now);
}
