/**
 * The supervisor's in-memory bookkeeping for running pipelines and the attempt
 * evidence it settles.
 *
 * @file
 */
import type { ExecutedJob } from './context.ts';

/** One cancellable pipeline owned by this supervisor. */
export interface Running {
  /** Cancellation kills the owned process tree. */
  readonly controller: AbortController;
  /** Pipeline completion awaited before closing SQLite. */
  readonly promise: Promise<void>;
}
/** Attempt evidence accumulated before settlement. */
export interface AttemptState {
  /** Actual provider/check result. */
  execution: ExecutedJob | null;
  /** Whether inference was launched. */
  isInferred: boolean;
  /** Fenced job outcome. */
  state: 'succeeded' | 'failed' | 'interrupted';
  /** Supervisor-observed failure or cancellation reason for the manager report. */
  reason: string | null;
  /** Error that failed the attempt, used to classify its retry. */
  error: unknown;
  /** The attempt asked the operator a question; its result waits for the answer. */
  isAwaitingAnswer?: boolean;
}
