/**
 * DOM-free formatting, grouping and chart geometry shared by the sessions and
 * costs views. Every value comes from validated local telemetry; unknown
 * figures are shown as unknown, never as zero.
 *
 * @file
 */
import { phrase, translated } from './i18n.js';

/** Milliseconds per second. */
const SECOND_MS = 1000;
/** Seconds per minute. */
const MINUTE_S = 60;
/** Minutes per hour. */
const HOUR_M = 60;
/** Thousands separator step for compact token counts. */
const THOUSAND = 1000;
/** One million tokens. */
const MILLION = 1_000_000;
/** Costs under one cent keep extra precision. */
const CENT = 0.01;
/** Decimal places for sub-cent amounts. */
const FINE_DIGITS = 4;
/** Decimal places for compact counts. */
const COMPACT_DIGITS = 1;
/** Percent decimal places. */
const PERCENT_DIGITS = 1;

/** Core roles in fixed categorical order; slot N is the role at index N - 1. */
const CORE_ROLES = [
  'product-owner',
  'team-lead',
  'developer-1',
  'developer-2',
  'qa-1',
  'qa-2',
  'final-tester',
  'learning-steward',
] as const;

/**
 * Every assignment kind an attempt can record, in the broker's `JOB_KINDS`
 * order, with its readable label. A test keeps the keys equal to the broker's
 * list, so filters and labels never drift from it.
 */
export const ATTEMPT_KINDS: Readonly<Record<string, string>> = translated({
  plan: phrase('Specification and plan'),
  refine: phrase('Plan refinement'),
  plan_review: phrase('Plan review'),
  revalidate: phrase('Brief revalidation'),
  develop: phrase('Development'),
  review: phrase('Review'),
  adjudicate: phrase('Fix and rulings'),
  document: phrase('Documentation'),
  regress: phrase('Regression check'),
  final: phrase('Final check'),
  verify: phrase('Merge verification'),
  learn: phrase('Learning research'),
  skill: phrase('Skill review'),
  triage: phrase('Triage'),
});
/** Fixed categorical slot per core role; specialist seats share the neutral "Other" slot. */
export const ROLE_SLOTS: ReadonlyMap<string, number> = new Map(CORE_ROLES.map((role, index) => [role, index + 1]));
/** Series key and label for roles without their own slot. */
export const OTHER_SERIES = 'other';

/**
 * Format a USD amount, keeping unknown distinct from zero.
 *
 * @param usd - Amount, or null when unknown.
 * @returns Display text such as `$1.23`, `$0.0042` or `unpriced`.
 */
export function formatUsd(usd: number | null): string {
  if (usd === null) {
    return 'unpriced';
  }
  return usd > 0 && usd < CENT ? `$${usd.toFixed(FINE_DIGITS)}` : `$${usd.toFixed(2)}`;
}

/**
 * Format an attempt cost with its source.
 *
 * @param usd - Amount, or null when unpriced.
 * @param source - Reported, estimated or unpriced.
 * @returns Display text; estimates are marked with a tilde.
 */
export function formatCost(usd: number | null, source: string): string {
  if (usd === null || source === 'unpriced') {
    return 'unpriced';
  }
  return source === 'estimated' ? `~${formatUsd(usd)}` : formatUsd(usd);
}

/**
 * Format a token count compactly.
 *
 * @param tokens - Count, or null when not reported.
 * @returns Display text such as `950`, `12.4k`, `3.1M` or `—`.
 */
export function formatTokens(tokens: number | null): string {
  if (tokens === null) {
    return '—';
  }
  if (tokens >= MILLION) {
    return `${(tokens / MILLION).toFixed(COMPACT_DIGITS)}M`;
  }
  return tokens >= THOUSAND ? `${(tokens / THOUSAND).toFixed(COMPACT_DIGITS)}k` : String(Math.round(tokens));
}

/**
 * Format a duration.
 *
 * @param milliseconds - Elapsed time, or null when unknown.
 * @returns Display text such as `42s`, `3m 05s` or `1h 02m`.
 */
export function formatDuration(milliseconds: number | null): string {
  if (milliseconds === null) {
    return '—';
  }
  const seconds = Math.floor(milliseconds / SECOND_MS);
  const minutes = Math.floor(seconds / MINUTE_S);
  const hours = Math.floor(minutes / HOUR_M);
  if (hours > 0) {
    return `${String(hours)}h ${String(minutes % HOUR_M).padStart(2, '0')}m`;
  }
  return minutes > 0 ? `${String(minutes)}m ${String(seconds % MINUTE_S).padStart(2, '0')}s` : `${String(seconds)}s`;
}

/**
 * Format a percentage.
 *
 * @param percent - Value, or null when unknown.
 * @returns Display text such as `61.2%` or `—`.
 */
export function formatPercent(percent: number | null): string {
  return percent === null ? '—' : `${percent.toFixed(PERCENT_DIGITS)}%`;
}

/**
 * Read the browser's IANA time zone.
 *
 * @returns Zone name such as `Europe/Berlin`.
 */
export function browserTimeZone(): string {
  const formatter = new Intl.DateTimeFormat();
  return formatter.resolvedOptions().timeZone;
}

/**
 * Name the calendar day of a timestamp in a time zone.
 *
 * @param timestamp - Epoch milliseconds.
 * @param timeZone - IANA zone; DST is handled by Intl.
 * @returns `YYYY-MM-DD`.
 */
export function calendarDay(timestamp: number, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const parts = new Map(formatter.formatToParts(timestamp).map((part) => [part.type, part.value]));
  return `${parts.get('year') ?? ''}-${parts.get('month') ?? ''}-${parts.get('day') ?? ''}`;
}

/**
 * Group newest-first rows into calendar days, preserving order.
 *
 * @param rows - Rows with a start time, newest first.
 * @param timeZone - Viewer's IANA zone.
 * @returns Day groups in first-seen order.
 */
export function groupByDay<Row extends { readonly startedAt: number }>(
  rows: readonly Row[],
  timeZone: string,
): { day: string; rows: Row[] }[] {
  const groups = Map.groupBy(rows, (row) => calendarDay(row.startedAt, timeZone));
  return groups
    .entries()
    .map(([day, members]) => ({ day, rows: members }))
    .toArray();
}

/**
 * Map a role to its chart series.
 *
 * @param role - Factory role.
 * @returns Series key: the role itself for core roles, otherwise the shared "Other" series.
 */
export function roleSeries(role: string): string {
  return ROLE_SLOTS.has(role) ? role : OTHER_SERIES;
}

/** One stacked bar segment. */
export interface BarSegment {
  /** Series key. */
  readonly series: string;
  /** Segment value in USD. */
  readonly value: number;
  /** Top edge in chart units (0 is the top of the plot). */
  readonly y: number;
  /** Segment height in chart units. */
  readonly height: number;
}

/** One day's stacked bar. */
export interface DayBar {
  /** Calendar day. */
  readonly day: string;
  /** Day total in USD. */
  readonly total: number;
  /** Segments from the baseline upward, in fixed series order. */
  readonly segments: BarSegment[];
}

/**
 * Lay out stacked daily bars by series in fixed slot order.
 *
 * @param daily - Days with per-role USD.
 * @param height - Plot height in chart units.
 * @param gap - Surface gap between stacked segments, in chart units.
 * @returns Bars, the series present and the scale maximum.
 */
export function stackBars(
  daily: readonly { day: string; totalUsd: number; byRole: Readonly<Record<string, number>> }[],
  height: number,
  gap: number,
): { bars: DayBar[]; series: string[]; max: number } {
  const order = [...ROLE_SLOTS.keys(), OTHER_SERIES];
  const present = new Set<string>();
  const totals = daily.map((entry) => {
    const values = new Map<string, number>();
    for (const [role, usd] of Object.entries(entry.byRole)) {
      const series = roleSeries(role);
      values.set(series, (values.get(series) ?? 0) + usd);
    }
    return { entry, values };
  });
  const max = Math.max(0, ...daily.map((entry) => entry.totalUsd));
  const bars = totals.map(({ entry, values }) => {
    let baseline = height;
    const segments: BarSegment[] = [];
    for (const series of order) {
      const value = values.get(series) ?? 0;
      if (max === 0 || value <= 0) {
        continue;
      }
      present.add(series);
      const extent = (value / max) * height;
      const visible = Math.max(extent - gap, 1);
      segments.push({ series, value, y: baseline - visible, height: visible });
      baseline -= extent;
    }
    return { day: entry.day, total: entry.totalUsd, segments };
  });
  return { bars, series: order.filter((series) => present.has(series)), max };
}
