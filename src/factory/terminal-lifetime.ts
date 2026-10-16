/** @file Injectable idle and absolute deadlines; timers exist only for live terminals. */
import { z } from 'zod/v3';

/** One second in milliseconds. */
const SECOND = 1000;
/** Default idle window: five minutes without operator input. */
const IDLE_MS = 300_000;
/** Default maximum duration: thirty minutes. */
const MAX_MS = 1_800_000;
/** Maximum authorized duration: two hours. */
const CEILING_MS = 7_200_000;
/** Bounded local policies, separate from subscription quota. */
export const terminalPolicySchema = z
  .object({
    max: z.number().int().min(0).max(2).default(1),
    idleMs: z.number().int().min(SECOND).max(MAX_MS).default(IDLE_MS),
    maximumMs: z.number().int().min(SECOND).max(CEILING_MS).default(MAX_MS),
  })
  .strict();
/** Scheduling boundary for token-free deadline tests. */
export interface TerminalClock {
  /** Schedule once and return its cancellation function. */
  readonly later: (callback: () => void, ms: number) => () => void;
}
/** Native timers are cancelled when their terminal ends. */
export const terminalClock: TerminalClock = {
  /**
   * Schedule a native one-shot callback.
   *
   * @param callback - Deadline callback.
   * @param ms - Validated delay.
   * @returns Timer cancellation.
   */
  later(callback, ms) {
    const timer = setTimeout(callback, ms);
    return () => {
      clearTimeout(timer);
    };
  },
};
/** Distinct durable timeout reasons. */
export type TerminalTimeout = 'idle timeout' | 'maximum duration';

/** Independent deadlines with idempotent cleanup and first-cause ownership. */
export class TerminalLifetime {
  /** Injectable timer adapter. */
  private readonly clock: TerminalClock;
  /** Bounded idle window. */
  private readonly idleMs: number;
  /** Callback to the owning service. */
  private readonly ended: (reason: TerminalTimeout) => void;
  /** Idle cancellation handle. */
  private idle: (() => void) | null = null;
  /** Absolute cancellation handle. */
  private readonly maximum: () => void;
  /** First terminal cause wins. */
  private isClosed = false;

  /**
   * Start deadlines after explicit native-session admission.
   *
   * @param policy - Validated idle/absolute windows.
   * @param ended - Owner's cancellation callback.
   * @param clock - Native or deterministic clock.
   */
  public constructor(
    policy: z.output<typeof terminalPolicySchema>,
    ended: (reason: TerminalTimeout) => void,
    clock: TerminalClock = terminalClock,
  ) {
    this.clock = clock;
    this.idleMs = policy.idleMs;
    this.ended = ended;
    this.maximum = clock.later(() => {
      this.expire('maximum duration');
    }, policy.maximumMs);
    this.touch();
  }

  /** Accepted input resets only the idle deadline, never the absolute limit. */
  public touch(): void {
    if (this.isClosed) {
      return;
    }
    this.idle?.();
    this.idle = this.clock.later(() => {
      this.expire('idle timeout');
    }, this.idleMs);
  }

  /** Cancel both timers, including after repeated close or native exit. */
  public close(): void {
    this.isClosed = true;
    this.idle?.();
    this.maximum();
  }

  /**
   * Preserve the first timeout cause and retire both timers.
   *
   * @param reason - Distinct timeout reason.
   */
  private expire(reason: TerminalTimeout): void {
    if (this.isClosed) {
      return;
    }
    this.close();
    this.ended(reason);
  }
}
