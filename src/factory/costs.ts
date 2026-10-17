/**
 * Local cost summary for the costs view: totals, a daily series by role in
 * the operator's time zone, breakdowns by role, model, objective and
 * delivery, the most expensive attempts and token totals. Only provider
 * reported costs and operator-priced estimates are summed; unpriced attempts
 * are counted, never assigned an invented price.
 *
 * @file
 */
import { attemptDigest, attemptMetrics } from './attempt-metrics.ts';
import { OBJECTIVE_MAX, attemptContext, attemptsSince, objectiveOf } from './attempts.ts';
import { readPrices } from './price-table.ts';
import { FACTORY_ROLES } from './seats.ts';
import { costsInputSchema } from './telemetry-schema.ts';

import type { MeshConfig } from '../config.ts';
import type { AttemptContext } from './attempts.ts';
import type { FactoryRepository } from './repository.ts';
import type { FactoryJob } from './schema.ts';
import type { AttemptMetrics, CostGroup, CostSummary } from './telemetry-schema.ts';

/** Milliseconds in one nominal day, used only for a generous query lower bound. */
const DAY_MS = 86_400_000;
/** Extra nominal days queried so every zone's first local day is covered. */
const WINDOW_MARGIN_DAYS = 2;
/** Most attempts summarized in one window. */
const ATTEMPTS_MAX = 2000;
/** Stream digests read concurrently. */
const READ_BATCH = 16;
/** Most rows in each breakdown table. */
const GROUPS_MAX = 50;
/** Attempts in the most-expensive list. */
const TOP_MAX = 10;
/** Most unpriced model names reported. */
const UNPRICED_MODELS_MAX = 50;
/** Percent scale. */
const PERCENT = 100;
/** Width of the ISO calendar date prefix. */
const ISO_DATE_LENGTH = 10;
/** Grouping key for attempts outside any objective or delivery. */
const NONE = 'none';

/** One attempt with everything the summary needs. */
interface CostedAttempt {
  /** Attempt record. */
  readonly job: FactoryJob;
  /** Its metrics. */
  readonly metrics: AttemptMetrics;
  /** Local calendar day it started. */
  readonly day: string;
}

/** Mutable breakdown accumulator. */
type GroupTotals = Map<string, CostGroup>;

/**
 * Format a timestamp as a calendar day in a time zone, DST-correct via Intl.
 *
 * @param formatter - Day formatter bound to the operator's zone.
 * @param timestamp - Epoch milliseconds.
 * @returns ISO-style `YYYY-MM-DD` day.
 */
export function calendarDay(formatter: Intl.DateTimeFormat, timestamp: number): string {
  const parts = new Map(formatter.formatToParts(timestamp).map((part) => [part.type, part.value]));
  return `${parts.get('year') ?? ''}-${parts.get('month') ?? ''}-${parts.get('day') ?? ''}`;
}

/**
 * Create a calendar-day formatter for a validated IANA zone.
 *
 * @param timeZone - Operator time zone.
 * @returns Formatter producing numeric year, month and day parts.
 */
export function dayFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
}

/**
 * List the window's calendar days ending today, using pure date arithmetic.
 *
 * @param today - Today's `YYYY-MM-DD` in the operator's zone.
 * @param days - Window length in days.
 * @returns Oldest-first day keys.
 */
export function windowDays(today: string, days: number): string[] {
  const [year = 0, month = 1, day = 1] = today.split('-').map(Number);
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(Date.UTC(year, month - 1, day - (days - 1 - index)));
    return date.toISOString().slice(0, ISO_DATE_LENGTH);
  });
}

/**
 * Order groups by cost, then by attempt count.
 *
 * @param left - First group.
 * @param right - Second group.
 * @returns Negative when the left group ranks first.
 */
function byCost(left: CostGroup, right: CostGroup): number {
  const difference = right.costUsd - left.costUsd;
  return difference === 0 ? right.attempts - left.attempts : difference;
}

/**
 * Add one attempt to a breakdown group.
 *
 * @param groups - Accumulator keyed by group.
 * @param group - Group key and display label.
 * @param attempt - Costed attempt.
 */
function addToGroup(groups: GroupTotals, group: { key: string; label: string }, attempt: CostedAttempt): void {
  const current = groups.get(group.key) ?? { ...group, costUsd: 0, attempts: 0, unpricedAttempts: 0, tokens: 0 };
  groups.set(group.key, {
    ...current,
    costUsd: current.costUsd + (attempt.metrics.cost.usd ?? 0),
    attempts: current.attempts + 1,
    unpricedAttempts: current.unpricedAttempts + (attempt.metrics.cost.source === 'unpriced' ? 1 : 0),
    tokens: current.tokens + (attempt.metrics.tokens.total ?? 0),
  });
}

/**
 * Order and bound a breakdown for display.
 *
 * @param groups - Accumulated groups.
 * @returns Most expensive groups first.
 */
function ranked(groups: GroupTotals): CostGroup[] {
  return groups
    .values()
    .toArray()
    .toSorted((left, right) => byCost(left, right))
    .slice(0, GROUPS_MAX);
}

/**
 * Compute breakdowns by role, model, objective and delivery.
 *
 * @param attempts - Costed attempts in the window.
 * @param context - Delivery and objective lookups.
 * @returns Ranked breakdown tables.
 */
function breakdowns(
  attempts: readonly CostedAttempt[],
  context: AttemptContext,
): Pick<CostSummary, 'byRole' | 'byModel' | 'byObjective' | 'byDelivery'> {
  const byRole: GroupTotals = new Map();
  const byModel: GroupTotals = new Map();
  const byObjective: GroupTotals = new Map();
  const byDelivery: GroupTotals = new Map();
  for (const attempt of attempts) {
    const { job, metrics } = attempt;
    addToGroup(byRole, { key: job.role, label: job.role }, attempt);
    const model = `${job.provider}/${metrics.model ?? 'unknown model'}`;
    addToGroup(byModel, { key: model, label: model }, attempt);
    const featureId = objectiveOf(job, context);
    const objective = featureId === null ? undefined : context.features.get(featureId);
    addToGroup(
      byObjective,
      objective === undefined
        ? { key: NONE, label: 'No objective' }
        : { key: objective.id, label: objective.objective.slice(0, OBJECTIVE_MAX) },
      attempt,
    );
    const task = job.taskId === null ? undefined : context.tasks.get(job.taskId);
    addToGroup(
      byDelivery,
      task === undefined
        ? { key: NONE, label: 'Planning and maintenance' }
        : { key: task.id, label: `#${String(task.issue)} ${task.title}` },
      attempt,
    );
  }
  return {
    byRole: ranked(byRole),
    byModel: ranked(byModel),
    byObjective: ranked(byObjective),
    byDelivery: ranked(byDelivery),
  };
}

/**
 * Sum costs, waste and pricing coverage.
 *
 * @param attempts - Costed attempts in the window.
 * @returns Window totals.
 */
function totals(attempts: readonly CostedAttempt[]): CostSummary['totals'] {
  let costUsd = 0;
  let wasteUsd = 0;
  let wasteAttempts = 0;
  const sources = { reported: 0, estimated: 0, unpriced: 0 };
  for (const { job, metrics } of attempts) {
    sources[metrics.cost.source] += 1;
    const usd = metrics.cost.usd ?? 0;
    const isWaste = job.state === 'failed' || job.state === 'interrupted';
    costUsd += usd;
    wasteAttempts += isWaste ? 1 : 0;
    wasteUsd += isWaste ? usd : 0;
  }
  const pricedAttempts = sources.reported + sources.estimated;
  return {
    costUsd,
    attempts: attempts.length,
    pricedAttempts,
    reportedAttempts: sources.reported,
    estimatedAttempts: sources.estimated,
    unpricedAttempts: sources.unpriced,
    averagePerPricedAttempt: pricedAttempts === 0 ? null : costUsd / pricedAttempts,
    wasteUsd,
    wasteAttempts,
  };
}

/**
 * Sum known token components and the cache hit rate.
 *
 * @param attempts - Costed attempts in the window.
 * @returns Token totals; a component no attempt reported stays null.
 */
function tokenTotals(attempts: readonly CostedAttempt[]): CostSummary['tokens'] {
  const sum = (key: keyof AttemptMetrics['tokens']): number | null => {
    let total: number | null = null;
    for (const { metrics } of attempts) {
      const value = metrics.tokens[key];
      total = value === null ? total : (total ?? 0) + value;
    }
    return total;
  };
  const input = sum('input');
  const cacheRead = sum('cacheRead');
  const cacheWrite = sum('cacheWrite');
  const prompt = (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0);
  return {
    input,
    cacheRead,
    cacheWrite,
    output: sum('output'),
    reasoning: sum('reasoning'),
    total: sum('total'),
    cacheHitPercent: cacheRead === null || prompt === 0 ? null : (cacheRead / prompt) * PERCENT,
  };
}

/**
 * Build the daily series by role, including days without attempts.
 *
 * @param days - Oldest-first window days.
 * @param attempts - Costed attempts in the window.
 * @returns One entry per day.
 */
function dailySeries(days: readonly string[], attempts: readonly CostedAttempt[]): CostSummary['daily'] {
  const series = new Map(
    days.map((day) => [day, { day, totalUsd: 0, attempts: 0, byRole: new Map<string, number>() }]),
  );
  for (const { job, metrics, day } of attempts) {
    const entry = series.get(day);
    if (entry === undefined) {
      continue;
    }
    const usd = metrics.cost.usd ?? 0;
    entry.totalUsd += usd;
    entry.attempts += 1;
    entry.byRole.set(job.role, (entry.byRole.get(job.role) ?? 0) + usd);
  }
  return series
    .values()
    .map((entry) => ({ ...entry, byRole: Object.fromEntries(entry.byRole) }))
    .toArray();
}

/**
 * Read metrics for the window's attempts in bounded concurrent batches.
 *
 * @param mesh - Selected project.
 * @param jobs - Attempts in the window.
 * @returns Stream digests in the same order.
 */
async function digestsFor(
  mesh: MeshConfig,
  jobs: readonly FactoryJob[],
): Promise<Awaited<ReturnType<typeof attemptDigest>>[]> {
  const results: Awaited<ReturnType<typeof attemptDigest>>[] = [];
  for (let start = 0; start < jobs.length; start += READ_BATCH) {
    const batch = jobs.slice(start, start + READ_BATCH);
    // eslint-disable-next-line no-await-in-loop -- Batches bound concurrently open stream files.
    results.push(...(await Promise.all(batch.map(async (job) => attemptDigest(mesh, job)))));
  }
  return results;
}

/**
 * Summarize local attempt costs for a calendar-day window in the operator's zone.
 *
 * @param repository - Selected project ledger.
 * @param mesh - Selected project paths for confined stream reads.
 * @param input - Untrusted window length and IANA time zone.
 * @returns Totals, daily series, breakdowns, top attempts and token totals.
 */
export async function costSummary(
  repository: FactoryRepository,
  mesh: MeshConfig,
  input: unknown,
): Promise<CostSummary> {
  const { days, timeZone } = costsInputSchema.parse(input);
  const now = repository.store.now();
  const formatter = dayFormatter(timeZone);
  const window = windowDays(calendarDay(formatter, now), days);
  const included = new Set(window);
  const jobs: FactoryJob[] = [];
  let isTruncated = false;
  const candidates = attemptsSince(repository, now - (days + WINDOW_MARGIN_DAYS) * DAY_MS);
  for (const job of candidates) {
    if (job.startedAt > now || !included.has(calendarDay(formatter, job.startedAt))) {
      continue;
    }
    if (jobs.length === ATTEMPTS_MAX) {
      isTruncated = true;
      break;
    }
    jobs.push(job);
  }
  const prices = readPrices(repository.store);
  const digests = await digestsFor(mesh, jobs);
  const attempts = jobs.map((job, index) => {
    const digest = digests[index];
    if (digest === undefined) {
      throw new Error('Attempt digest missing.');
    }
    return { job, metrics: attemptMetrics(job, digest, prices, now), day: calendarDay(formatter, job.startedAt) };
  });
  const context = attemptContext(repository);
  const present = new Set(attempts.map((attempt) => attempt.job.role));
  const unpriced = attempts
    .filter((attempt) => attempt.metrics.cost.source === 'unpriced' && attempt.metrics.model !== null)
    .map((attempt) => attempt.metrics.model ?? '');
  return {
    days,
    timeZone,
    from: window[0] ?? '',
    to: window.at(-1) ?? '',
    generatedAt: now,
    truncated: isTruncated,
    totals: totals(attempts),
    roles: FACTORY_ROLES.filter((role) => present.has(role)),
    daily: dailySeries(window, attempts),
    ...breakdowns(attempts, context),
    topAttempts: attempts
      .filter((attempt) => attempt.metrics.cost.usd !== null)
      .toSorted((left, right) => (right.metrics.cost.usd ?? 0) - (left.metrics.cost.usd ?? 0))
      .slice(0, TOP_MAX)
      .map(({ job, metrics }) => {
        const task = job.taskId === null ? undefined : context.tasks.get(job.taskId);
        return {
          jobId: job.id,
          role: job.role,
          kind: job.kind,
          provider: job.provider,
          model: metrics.model,
          state: job.state,
          startedAt: job.startedAt,
          costUsd: metrics.cost.usd ?? 0,
          costSource: metrics.cost.source,
          delivery: task === undefined ? null : `#${String(task.issue)} ${task.title}`,
        };
      }),
    tokens: tokenTotals(attempts),
    unpricedModels: [...new Set(unpriced)]
      .toSorted((left, right) => left.localeCompare(right))
      .slice(0, UNPRICED_MODELS_MAX),
    prices,
  };
}
