/**
 * Native quota windows are observations, distinct from scheduling budgets.
 *
 * @file
 */
import { z } from 'zod';

/** Time conversion for native Unix-second reset deadlines. */
const SECOND_MS = 1000;
/** Maximum normalized quota percentage. */
const PERCENT_MAX = 100;
/** Observation cadence and display freshness ceiling; never an admission allowance. */
export const QUOTA_REFRESH_MS = 300_000;
/** Bound supported window collections independently of native payload size. */
const MAX_WINDOWS = 16;
/** Maximum safe native window identifier length. */
const MAX_WINDOW_ID = 64;
/** Persist only normalized subscription fields, never credit or account payloads. */
export const subscriptionWindowSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(MAX_WINDOW_ID)
    .regex(/^[\w\-]+$/v),
  usedPercent: z.number().finite().min(0).max(PERCENT_MAX),
  resetAt: z.number().int().nonnegative().safe().nullable(),
  observedAt: z.number().int().nonnegative().safe(),
  source: z.enum(['codex-app-server', 'claude-stream']),
  freshness: z.enum(['current', 'stale']).optional(),
});
/** Shared bounded persisted observation collection. */
export const subscriptionWindowsSchema = z.array(subscriptionWindowSchema).max(MAX_WINDOWS);
/** One independently observed subscription window. */
export type SubscriptionWindow = z.output<typeof subscriptionWindowSchema>;

/**
 * Age observations without resetting usage or deriving freshness from accounting.
 *
 * @param window - Verified observation.
 * @param now - Snapshot wall time.
 * @returns Display freshness only; stale is never available quota.
 */
export function windowFreshness(window: SubscriptionWindow, now = Date.now()): 'current' | 'stale' {
  return now < window.observedAt ||
    now - window.observedAt >= QUOTA_REFRESH_MS ||
    (window.resetAt !== null && window.resetAt <= now)
    ? 'stale'
    : 'current';
}
/** One native Codex subscription window. */
const windowSchema = z.object({
  usedPercent: z.number().finite().nonnegative(),
  resetsAt: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER / SECOND_MS)
    .nullable(),
});
/** Default Codex account bucket; additional buckets are not guessed as models. */
const bucketSchema = z.object({ primary: windowSchema.nullable(), secondary: windowSchema.nullable() });
/** Supported account/rateLimits/read response. */
const accountSchema = z.object({ rateLimits: bucketSchema.nullable().optional() });
/** One native Claude utilization fraction and reset deadline. */
const claudeWindowSchema = z.object({
  utilization: z.number().nonnegative(),
  resetsAt: z.number().int().nonnegative(),
});
/** Supported stream telemetry, including current unified subscription windows. */
const claudeInfoSchema = z.object({
  utilization: z.number().nonnegative().optional(),
  resetsAt: z.number().int().nonnegative().optional(),
  unifiedWindows: z.record(claudeWindowSchema).optional(),
});
/** Validated native percentage window. */
type NativeWindow = z.output<typeof windowSchema>;
/** One bounded, credential-free native observation. */
export const quotaReadingSchema = z.object({
  usedPercent: z.number().min(0).max(PERCENT_MAX),
  resetAt: z.number().nullable(),
});
/** Verified default account quota. */
export type QuotaReading = z.output<typeof quotaReadingSchema>;
/** Metadata helper output includes only verified Codex windows and the legacy scalar. */
export const quotaObservationSchema = quotaReadingSchema.extend({
  usedPercent: quotaReadingSchema.shape.usedPercent.nullable(),
  windows: subscriptionWindowsSchema.min(1).refine((windows) => {
    return (
      windows.length <= 2 &&
      windows.every((window, index) => {
        return (
          window.source === 'codex-app-server' &&
          (window.id === 'primary' || window.id === 'secondary') &&
          windows.findIndex((other) => other.id === window.id) === index
        );
      })
    );
  }),
});
/** Metadata observation shared across projects with its original timestamps. */
export type QuotaObservation = z.output<typeof quotaObservationSchema>;

/**
 * Retain both reported windows while preserving the existing scalar selection.
 *
 * @param input - Supported account response, not an API or credit balance.
 * @param now - Actual observation time.
 * @returns Allowlisted telemetry, or unknown on malformed/absent observations.
 */
export function accountObservation(input: unknown, now = Date.now()): QuotaObservation | null {
  const parsed = accountSchema.safeParse(input);
  if (!parsed.success || parsed.data.rateLimits === null || parsed.data.rateLimits === undefined) {
    return null;
  }
  const reading = accountQuota(input, now);
  const windows: SubscriptionWindow[] = [];
  for (const id of ['primary', 'secondary'] as const) {
    const window = parsed.data.rateLimits[id];
    if (window !== null) {
      windows.push({
        id,
        usedPercent: Math.min(PERCENT_MAX, window.usedPercent),
        resetAt: window.resetsAt === null ? null : window.resetsAt * SECOND_MS,
        observedAt: now,
        source: 'codex-app-server',
      });
    }
  }
  return windows.length === 0
    ? null
    : { usedPercent: reading?.usedPercent ?? null, resetAt: reading?.resetAt ?? null, windows };
}

/**
 * Normalize the most restrictive unexpired default account window.
 *
 * @param input - Unknown supported native response.
 * @param now - Current wall time for expired-window fencing.
 * @returns Verified usage, absent when no current window is available.
 */
export function accountQuota(input: unknown, now = Date.now()): QuotaReading | null {
  const result = accountSchema.safeParse(input);
  return !result.success || result.data.rateLimits === null || result.data.rateLimits === undefined
    ? null
    : restrictiveQuota([result.data.rateLimits.primary, result.data.rateLimits.secondary], now);
}

/**
 * Decode supported Claude stream quota without inferring usage from prose.
 *
 * @param input - Native rate_limit_info.
 * @param now - Current wall time.
 * @returns Most restrictive current reported window, otherwise unknown.
 */
export function claudeQuota(input: unknown, now = Date.now()): QuotaReading | null {
  const result = claudeInfoSchema.safeParse(input);
  if (!result.success) {
    return null;
  }
  const windows: NativeWindow[] = Object.values(result.data.unifiedWindows ?? {}).map((window) => {
    return {
      usedPercent: window.utilization * PERCENT_MAX,
      resetsAt: window.resetsAt,
    };
  });
  if (result.data.utilization !== undefined) {
    windows.push({ usedPercent: result.data.utilization * PERCENT_MAX, resetsAt: result.data.resetsAt ?? null });
  }
  return restrictiveQuota(windows, now);
}

/**
 * Select only current observations and normalize a reached limit to 100%.
 *
 * @param input - Validated supported windows.
 * @param now - Current wall time.
 * @returns Conservative observed percentage and its own reset deadline.
 */
function restrictiveQuota(input: (NativeWindow | null)[], now: number): QuotaReading | null {
  const windows = input
    .filter(
      (window): window is NativeWindow =>
        window !== null && (window.resetsAt === null || window.resetsAt * SECOND_MS > now),
    )
    .toSorted((left, right) => {
      const difference = right.usedPercent - left.usedPercent;
      return difference === 0 ? (right.resetsAt ?? 0) - (left.resetsAt ?? 0) : difference;
    });
  const selected = windows[0];
  return selected === undefined
    ? null
    : {
        usedPercent: Math.min(PERCENT_MAX, selected.usedPercent),
        resetAt: selected.resetsAt === null ? null : selected.resetsAt * SECOND_MS,
      };
}
