/**
 * Durable shapes for assignment liveness and retry classification. Settings
 * are optional so saved configurations parse unchanged; every job field is
 * optional so attempts saved before liveness existed parse unchanged too.
 *
 * @file
 */
import { z } from 'zod/v3';

/** Longest recorded progress signal or stop reason. */
export const LIVENESS_TEXT_MAX = 200;
/** Default quiet period after which an assignment counts as stalled. */
export const DEFAULT_STALL_MS = 900_000;
/** Default hard ceiling on one assignment, however productive. */
export const DEFAULT_MAX_MS = 7_200_000;
/** Default interval between unpaid progress samples. */
export const DEFAULT_SAMPLE_MS = 60_000;
/** Smallest accepted sample interval, so sampling never becomes a busy loop. */
const MIN_SAMPLE_MS = 1000;
/** Full subscription usage. */
const PERCENT_MAX = 100;

/** Optional project liveness policy; `jobTimeoutMs` is the checkpoint interval. */
export const livenessSettingsSchema = z
  .object({
    stallMs: z.number().int().positive().optional(),
    maxMs: z.number().int().positive().optional(),
    sampleMs: z.number().int().min(MIN_SAMPLE_MS).optional(),
    /** Subscription headroom an extension needs, per running attempt sharing the provider. */
    quotaMarginPercent: z.number().min(0).max(PERCENT_MAX).optional(),
  })
  .strict();
/** Saved liveness policy. */
export type LivenessSettings = z.output<typeof livenessSettingsSchema>;

/** What an assignment's latest signals say about it. */
export const LIVENESS_STATES = ['progressing', 'idle', 'awaiting_input', 'stalled', 'ceiling', 'held'] as const;
/** One liveness state. */
export type LivenessState = (typeof LIVENESS_STATES)[number];

/** Liveness of one attempt, refreshed at samples and checkpoints. */
export const jobLivenessSchema = z
  .object({
    state: z.enum(LIVENESS_STATES),
    extensions: z.number().int().nonnegative(),
    lastProgressAt: z.number(),
    lastSignal: z.string().max(LIVENESS_TEXT_MAX).nullable(),
    /** What the provider waits on while it shows no progress, if anything. */
    awaiting: z.string().max(LIVENESS_TEXT_MAX).nullable(),
    nextCheckpointAt: z.number(),
    ceilingAt: z.number(),
    stopReason: z.string().max(LIVENESS_TEXT_MAX).nullable(),
  })
  .strict();
/** Recorded attempt liveness. */
export type JobLiveness = z.output<typeof jobLivenessSchema>;

/** Why an attempt did not succeed, which decides when its step may run again. */
export const FAILURE_CLASSES = [
  'rate_limit',
  'transient',
  'stalled',
  'held',
  'invalid_output',
  'gate',
  'cancelled',
] as const;
/** One failure class. */
export type FailureClass = (typeof FAILURE_CLASSES)[number];
/** Recorded failure class. */
export const failureClassSchema = z.enum(FAILURE_CLASSES);

/** Effective liveness policy with every default applied. */
export interface LivenessPolicy {
  /** Checkpoint interval (`jobTimeoutMs`). */
  readonly intervalMs: number;
  /** Quiet period that counts as stalled. */
  readonly stallMs: number;
  /** Hard ceiling from the attempt's start. */
  readonly maxMs: number;
  /** Sampling interval. */
  readonly sampleMs: number;
}

/**
 * Resolve the effective policy. Without explicit settings an assignment that
 * shows no progress still stops at its first checkpoint, exactly as the old
 * single deadline did; only productive assignments are extended.
 *
 * @param settings - Project configuration fields that shape liveness.
 * @param settings.jobTimeoutMs - Checkpoint interval.
 * @param settings.liveness - Optional explicit policy.
 * @returns Policy with defaults bounded by the interval.
 */
export function livenessPolicy(settings: {
  jobTimeoutMs: number;
  liveness?: LivenessSettings | undefined;
}): LivenessPolicy {
  const intervalMs = settings.jobTimeoutMs;
  const stallMs = settings.liveness?.stallMs ?? Math.min(DEFAULT_STALL_MS, intervalMs);
  const maxMs = settings.liveness?.maxMs ?? Math.max(DEFAULT_MAX_MS, intervalMs);
  const sampleMs = settings.liveness?.sampleMs ?? Math.min(DEFAULT_SAMPLE_MS, intervalMs);
  return { intervalMs, stallMs, maxMs, sampleMs };
}
