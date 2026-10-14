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
/** Bound native per-model window counts. */
const MAX_WINDOWS = 32;
/** Bound native window labels. */
const MAX_WINDOW_ID = 80;
/** Minutes in the documented Claude session and weekly windows. */
const FIVE_HOUR_MINUTES = 300;
/** Minutes in a weekly subscription window. */
const WEEK_MINUTES = 10_080;
/** Credential-free per-window observation retained for operator inspection. */
export const subscriptionWindowSchema = z.object({
  id: z.string().min(1).max(MAX_WINDOW_ID),
  minutes: z.number().int().positive().nullable(),
  usedPercent: z.number().min(0).max(PERCENT_MAX),
  resetAt: z.number().nonnegative().nullable(),
});
/** One native Codex subscription window. */
const windowSchema = z.object({
  usedPercent: z.number().nonnegative(),
  resetsAt: z.number().int().nonnegative().nullable(),
  windowDurationMins: z.number().int().positive().nullable().optional(),
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
  windows: z.array(subscriptionWindowSchema).max(MAX_WINDOWS).optional(),
});
/** Verified default account quota. */
export type QuotaReading = z.output<typeof quotaReadingSchema>;
/** One actual observed window, with unknown duration preserved. */
export type SubscriptionWindow = z.output<typeof subscriptionWindowSchema>;

/**
 * Preserve actual account durations rather than assuming a plan has five hours.
 *
 * @param input - Supported native account response.
 * @param now - Observation time.
 * @returns Current named windows, without credentials or account identifiers.
 */
export function accountWindows(input: unknown, now = Date.now()): SubscriptionWindow[] {
  const parsed = accountSchema.safeParse(input);
  const bucket = parsed.success ? parsed.data.rateLimits : null;
  return Object.entries(bucket ?? {}).flatMap(([id, window]) => {
    return window === null || (window.resetsAt !== null && window.resetsAt * SECOND_MS <= now)
      ? []
      : {
          id,
          minutes: window.windowDurationMins ?? null,
          usedPercent: Math.min(PERCENT_MAX, window.usedPercent),
          resetAt: window.resetsAt === null ? null : window.resetsAt * SECOND_MS,
        };
  });
}

/**
 * Retain each supported Claude window instead of just the restrictive one.
 *
 * @param input - Native rate-limit metadata.
 * @param now - Observation time.
 * @returns Current named subscription windows.
 */
export function claudeWindows(input: unknown, now = Date.now()): SubscriptionWindow[] {
  const parsed = claudeInfoSchema.safeParse(input);
  if (!parsed.success) {
    return [];
  }
  return Object.entries(parsed.data.unifiedWindows ?? {})
    .slice(0, MAX_WINDOWS)
    .flatMap(([id, window]) => {
      const minutes = id === 'five_hour' ? FIVE_HOUR_MINUTES : null;
      return window.resetsAt * SECOND_MS <= now || id.length > MAX_WINDOW_ID
        ? []
        : {
            id,
            minutes: id === 'seven_day' ? WEEK_MINUTES : minutes,
            usedPercent: Math.min(PERCENT_MAX, window.utilization * PERCENT_MAX),
            resetAt: window.resetsAt * SECOND_MS,
          };
    });
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
