/**
 * Checkpoint liveness for one managed assignment. `jobTimeoutMs` is the
 * checkpoint interval rather than a blind deadline: at each checkpoint the
 * unpaid supervisor extends an assignment that showed meaningful progress
 * within the stall window, and stops one that stalled or reached the hard
 * ceiling. Between checkpoints it samples progress signals it already owns.
 *
 * @file
 */
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

/** An observation with no progress and no input wait. */
const NO_PROGRESS: ProgressObservation = { progress: null, awaiting: null };

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
      this.checkpoint();
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
   * Take one sample, waiting no later than the next checkpoint, so a sampler
   * that hangs cannot hold off checkpoints or the hard ceiling.
   *
   * @returns What the sampler saw, or no progress when it failed or was too slow.
   */
  private async observation(): Promise<ProgressObservation> {
    const budget = Math.max(0, this.current.nextCheckpointAt - this.options.now());
    const late = Promise.withResolvers<ProgressObservation>();
    const cancel = this.timers(() => {
      late.resolve(NO_PROGRESS);
    }, budget);
    try {
      return await Promise.race([this.sampled(), late.promise]);
    } finally {
      cancel();
    }
  }

  /**
   * Take one sample; a failed sample counts as no progress.
   *
   * @returns What the sampler saw, or no progress when sampling failed.
   */
  private async sampled(): Promise<ProgressObservation> {
    try {
      return await this.options.sample();
    } catch {
      return NO_PROGRESS;
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

  /** Apply the due checkpoint. */
  private checkpoint(): void {
    const decision = checkpointDecision({
      startedAt: this.options.startedAt,
      now: this.options.now(),
      lastProgressAt: this.current.lastProgressAt,
      policy: this.options.policy,
    });
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
    this.update({ ...this.current, state: decision.state, stopReason: reason });
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
