/**
 * Checkpoint liveness for one managed assignment. `jobTimeoutMs` is the
 * checkpoint interval rather than a blind deadline: at each checkpoint the
 * unpaid supervisor extends an assignment that showed meaningful progress
 * within the stall window, and stops one that stalled or reached the hard
 * ceiling. Between checkpoints it samples progress signals it already owns.
 *
 * @file
 */
import { HOLD_PREFIX } from './retry-policy.ts';

import type { JobLiveness, LivenessPolicy, LivenessState } from './liveness-schema.ts';

/** Milliseconds in one minute. */
const MINUTE_MS = 60_000;

/** What one sample observed since the previous one. */
export interface ProgressObservation {
  /** Label of the newest meaningful signal, or null when nothing progressed. */
  readonly progress: string | null;
  /** What the provider waits on, when it stopped for a permission or an answer. */
  readonly awaiting: string | null;
}

/** Outcome of one checkpoint. */
export type CheckpointDecision =
  | { readonly action: 'extend'; readonly nextCheckpointAt: number }
  | { readonly action: 'stop'; readonly state: 'stalled' | 'ceiling'; readonly reason: string };

/**
 * The first checkpoint: one interval in, or the ceiling when that is sooner.
 *
 * @param startedAt - Attempt start.
 * @param policy - Effective liveness policy.
 * @returns Absolute checkpoint time.
 */
export function firstCheckpoint(startedAt: number, policy: LivenessPolicy): number {
  return Math.min(startedAt + policy.intervalMs, startedAt + policy.maxMs);
}

/**
 * The stop reason recorded for a stalled assignment.
 *
 * @param quietMs - Time since the last meaningful progress.
 * @returns Reason text, for example `stalled 16 min`.
 */
export function stalledReason(quietMs: number): string {
  return `stalled ${String(Math.max(1, Math.round(quietMs / MINUTE_MS)))} min`;
}

/**
 * Decide one checkpoint: extend by one interval while progress is recent,
 * otherwise stop. The ceiling stops an assignment however productive it is.
 *
 * @param input - Attempt timing and its latest progress.
 * @param input.startedAt - Attempt start.
 * @param input.now - Checkpoint time.
 * @param input.lastProgressAt - Newest meaningful progress (the start when there was none).
 * @param input.policy - Effective liveness policy.
 * @returns Extension with the next checkpoint, or a stop with its reason.
 */
export function checkpointDecision(input: {
  startedAt: number;
  now: number;
  lastProgressAt: number;
  policy: LivenessPolicy;
}): CheckpointDecision {
  const ceilingAt = input.startedAt + input.policy.maxMs;
  if (input.now >= ceilingAt) {
    return { action: 'stop', state: 'ceiling', reason: 'hard ceiling' };
  }
  const quietMs = input.now - input.lastProgressAt;
  return quietMs >= input.policy.stallMs
    ? { action: 'stop', state: 'stalled', reason: stalledReason(quietMs) }
    : { action: 'extend', nextCheckpointAt: Math.min(input.now + input.policy.intervalMs, ceilingAt) };
}

/** Timer function, injectable so tests drive the monitor with a fake clock; returns a cancel function. */
export type LivenessTimers = (callback: () => void, ms: number) => () => void;

/**
 * Real timers. Like the single deadline they replace, they keep the process
 * alive while an attempt runs; the supervisor disposes them when it settles.
 *
 * @param callback - Wake-up.
 * @param ms - Delay.
 * @returns Cancel function.
 */
const SYSTEM_TIMERS: LivenessTimers = (callback, ms) => {
  const timer = setTimeout(callback, ms);
  return () => {
    clearTimeout(timer);
  };
};

/** What the monitor needs from the supervisor. */
export interface LivenessOptions {
  /** Attempt start. */
  readonly startedAt: number;
  /** Effective policy. */
  readonly policy: LivenessPolicy;
  /** Supervisor clock. */
  readonly now: () => number;
  /** Progress sampler; rejections count as no progress. */
  readonly sample: () => Promise<ProgressObservation>;
  /** Persist a changed liveness record. */
  readonly record: (liveness: JobLiveness) => void;
  /** Stop the assignment with its recorded reason. */
  readonly stop: (reason: string) => void;

  /**
   * Whether a productive assignment may be extended; resolves to a refusal
   * reason, or null to extend. Without a gate every productive checkpoint extends.
   */
  readonly gate?: () => Promise<string | null>;
  /** Timers; real ones by default. */
  readonly timers?: LivenessTimers;
}

/** Samples one assignment and applies its checkpoints until stopped or disposed. */
export class LivenessMonitor {
  /** Supervisor callbacks and policy. */
  private readonly options: LivenessOptions;
  /** Timer implementation. */
  private readonly timers: LivenessTimers;
  /** Current record. */
  private current: JobLiveness;
  /** Cancels the pending wake-up. */
  private cancel: (() => void) | null = null;
  /** Whether a sample is in flight. */
  private isChecking = false;
  /** Whether the monitor stopped or was disposed. */
  private isDone = false;

  /**
   * Prepare a monitor; call `start` to begin sampling.
   *
   * @param options - Policy, clock, sampler and supervisor callbacks.
   */
  public constructor(options: LivenessOptions) {
    this.options = options;
    this.timers = options.timers ?? SYSTEM_TIMERS;
    this.current = {
      state: 'idle',
      extensions: 0,
      lastProgressAt: options.startedAt,
      lastSignal: null,
      awaiting: null,
      nextCheckpointAt: firstCheckpoint(options.startedAt, options.policy),
      ceilingAt: options.startedAt + options.policy.maxMs,
      stopReason: null,
    };
  }

  /**
   * The latest liveness record.
   *
   * @returns Current record.
   */
  public get liveness(): JobLiveness {
    return this.current;
  }

  /** Record the initial state and schedule the first sample. */
  public start(): void {
    this.options.record(this.current);
    this.schedule();
  }

  /** Stop sampling; a running assignment settles on its own. */
  public dispose(): void {
    this.isDone = true;
    this.cancel?.();
    this.cancel = null;
  }

  /**
   * Take one sample and, when due, apply the checkpoint. Timers call this; tests may too.
   *
   * @returns Once the sample and any checkpoint are applied.
   */
  public async check(): Promise<void> {
    if (this.isDone || this.isChecking) {
      return;
    }
    this.isChecking = true;
    const observation = await this.observation();
    this.isChecking = false;
    if (this.hasEnded()) {
      return;
    }
    this.observe(observation);
    if (this.options.now() >= this.current.nextCheckpointAt) {
      await this.checkpoint();
    }
    this.schedule();
  }

  /**
   * Whether the monitor stopped or was disposed, read afresh after an await.
   *
   * @returns True once no further checks apply.
   */
  private hasEnded(): boolean {
    return this.isDone;
  }

  /**
   * Take one sample, bounded by the next checkpoint; a failed or late sample counts as no progress.
   *
   * @returns What the sampler saw, or no progress when sampling failed or outlasted the checkpoint.
   */
  private async observation(): Promise<ProgressObservation> {
    const none: ProgressObservation = { progress: null, awaiting: null };
    // A sampler that hangs must never stop the checkpoint, and so the ceiling, from being enforced.
    const budget = Math.max(0, this.current.nextCheckpointAt - this.options.now());
    const cancels: (() => void)[] = [];
    const deadline = new Promise<ProgressObservation>((resolve) => {
      cancels.push(
        this.timers(() => {
          resolve(none);
        }, budget),
      );
    });
    try {
      return await Promise.race([this.options.sample(), deadline]);
    } catch {
      return none;
    } finally {
      for (const cancel of cancels) {
        cancel();
      }
    }
  }

  /**
   * Fold one observation into the record.
   *
   * @param observation - Latest sample.
   */
  private observe(observation: ProgressObservation): void {
    const now = this.options.now();
    const isProgressed = observation.progress !== null;
    const lastProgressAt = isProgressed ? now : this.current.lastProgressAt;
    const lastSignal = isProgressed ? observation.progress : this.current.lastSignal;
    const awaiting = isProgressed ? null : (observation.awaiting ?? this.current.awaiting);
    let state: LivenessState = 'idle';
    if (awaiting !== null) {
      state = 'awaiting_input';
    } else if (lastSignal !== null && now - lastProgressAt < this.options.policy.stallMs) {
      state = 'progressing';
    }
    this.update({ ...this.current, state, lastProgressAt, lastSignal, awaiting });
  }

  /**
   * Apply the due checkpoint.
   *
   * @returns Once the checkpoint is applied.
   */
  private async checkpoint(): Promise<void> {
    const decision = checkpointDecision({
      startedAt: this.options.startedAt,
      now: this.options.now(),
      lastProgressAt: this.current.lastProgressAt,
      policy: this.options.policy,
    });
    const hold = decision.action === 'extend' ? await this.holdReason() : null;
    if (this.hasEnded()) {
      return;
    }
    if (hold !== null) {
      this.end('held', `${HOLD_PREFIX} ${hold}`);
      return;
    }
    if (decision.action === 'extend') {
      this.update({
        ...this.current,
        extensions: this.current.extensions + 1,
        nextCheckpointAt: decision.nextCheckpointAt,
      });
      return;
    }
    const reason =
      decision.state === 'stalled' && this.current.awaiting !== null
        ? `${decision.reason} (awaiting input)`
        : decision.reason;
    this.end(decision.state, reason);
  }

  /**
   * Ask the gate whether a productive assignment may continue; a failed check holds it.
   *
   * @returns Refusal reason, or null to extend.
   */
  private async holdReason(): Promise<string | null> {
    if (this.options.gate === undefined) {
      return null;
    }
    try {
      return await this.options.gate();
    } catch {
      return 'extension safety could not be verified';
    }
  }

  /**
   * Record the final state and stop the assignment.
   *
   * @param state - Stalled, ceiling or held.
   * @param reason - Recorded stop reason.
   */
  private end(state: 'stalled' | 'ceiling' | 'held', reason: string): void {
    this.update({ ...this.current, state, stopReason: reason });
    this.dispose();
    this.options.stop(reason);
  }

  /**
   * Persist a record only when it changed.
   *
   * @param next - Candidate record.
   */
  private update(next: JobLiveness): void {
    if (JSON.stringify(next) === JSON.stringify(this.current)) {
      return;
    }
    this.current = next;
    this.options.record(next);
  }

  /** Wake at the next sample or checkpoint, whichever is sooner. */
  private schedule(): void {
    if (this.isDone) {
      return;
    }
    const now = this.options.now();
    const delay = Math.max(0, Math.min(this.options.policy.sampleMs, this.current.nextCheckpointAt - now));
    this.cancel = this.timers(() => {
      this.cancel = null;
      void this.check();
    }, delay);
  }
}
