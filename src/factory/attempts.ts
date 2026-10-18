/**
 * Attempt listing for the sessions view: filtered, stable cursor pagination
 * over every recorded job (not only the recent status window), each row
 * carrying metrics but never transcript bodies.
 *
 * @file
 */
import { z } from 'zod/v3';

import { MeshError } from '../protocol.ts';

import { metricsFor } from './attempt-metrics.ts';
import { readPrices } from './price-table.ts';
import { jobSchema } from './schema.ts';
import { attemptsInputSchema } from './telemetry-schema.ts';

import type { MeshConfig } from '../config.ts';
import type { FactoryRepository } from './repository.ts';
import type { FactoryJob, FactoryTask, Feature } from './schema.ts';
import type { AttemptFilters, AttemptPage, AttemptRow } from './telemetry-schema.ts';

/** Longest summary excerpt in a listing row. */
const SUMMARY_MAX = 300;
/** Longest objective excerpt shown as an attempt's context. */
export const OBJECTIVE_MAX = 200;
/** One stored job row. */
const jobRowSchema = z.object({ data: z.string() });
/** Start time expression used for ordering and range filters. */
const STARTED = "json_extract(data, '$.startedAt')";

/** Delivery and objective lookups for attempt context. */
export interface AttemptContext {
  /** Deliveries by id. */
  readonly tasks: ReadonlyMap<string, FactoryTask>;
  /** Objectives by id. */
  readonly features: ReadonlyMap<string, Feature>;
}

/**
 * Validate one stored job row.
 *
 * @param row - Untrusted SQLite row.
 * @returns Validated attempt record.
 */
function decodeJob(row: unknown): FactoryJob {
  return jobSchema.parse(JSON.parse(jobRowSchema.parse(row).data));
}

/**
 * Load delivery and objective lookups once per request.
 *
 * @param repository - Selected project ledger.
 * @returns Maps keyed by id.
 */
export function attemptContext(repository: FactoryRepository): AttemptContext {
  return {
    tasks: new Map(repository.tasks().map((task) => [task.id, task])),
    features: new Map(repository.features().map((feature) => [feature.id, feature])),
  };
}

/**
 * Resolve the objective an attempt served, directly or through its delivery.
 *
 * @param job - Attempt record.
 * @param context - Delivery lookups.
 * @returns Objective id, or null for attempts outside any objective.
 */
export function objectiveOf(job: FactoryJob, context: AttemptContext): string | null {
  if (job.featureId !== null) {
    return job.featureId;
  }
  return job.taskId === null ? null : (context.tasks.get(job.taskId)?.featureId ?? null);
}

/**
 * Find one attempt by id in the full job ledger.
 *
 * @param repository - Selected project ledger.
 * @param id - Job identity.
 * @returns Validated attempt.
 * @throws {MeshError} When this project has no such attempt.
 */
export function attemptById(repository: FactoryRepository, id: string): FactoryJob {
  const row = repository.store.db.prepare('SELECT data FROM factory_jobs WHERE id = ?').get(id);
  if (row === undefined) {
    throw new MeshError('NOT_FOUND', 'This project has no attempt with that ID.');
  }
  return decodeJob(row);
}

/**
 * Iterate attempts that started at or after a time, newest first.
 *
 * @param repository - Selected project ledger.
 * @param since - Inclusive lower bound on start time.
 * @returns Lazily validated attempts.
 */
export function attemptsSince(repository: FactoryRepository, since: number): IteratorObject<FactoryJob> {
  const statement = repository.store.db.prepare(
    `SELECT data FROM factory_jobs WHERE ${STARTED} >= ? ORDER BY ${STARTED} DESC, id DESC`,
  );
  return statement.iterate(since).map((row) => decodeJob(row));
}

/**
 * Build the SQL filter for indexed or JSON fields; values are always bound.
 *
 * @param filters - Validated listing filters.
 * @returns WHERE clause and its bound values.
 */
function sqlFilter(filters: AttemptFilters): { clause: string; values: (string | number)[] } {
  const clauses: string[] = [];
  const values: (string | number)[] = [];
  const equal = [
    ['role', filters.role],
    ['state', filters.state],
    ["json_extract(data, '$.kind')", filters.kind],
    ["json_extract(data, '$.provider')", filters.provider],
    ["json_extract(data, '$.taskId')", filters.taskId],
  ] as const;
  for (const [column, value] of equal) {
    if (value === undefined) {
      continue;
    }
    clauses.push(`${column} = ?`);
    values.push(value);
  }
  if (filters.featureId !== undefined) {
    clauses.push(
      `(json_extract(data, '$.featureId') = ? OR json_extract(data, '$.taskId') IN (SELECT id FROM factory_tasks WHERE json_extract(data, '$.featureId') = ?))`,
    );
    values.push(filters.featureId, filters.featureId);
  }
  if (filters.since !== undefined) {
    clauses.push(`${STARTED} >= ?`);
    values.push(filters.since);
  }
  if (filters.until !== undefined) {
    clauses.push(`${STARTED} < ?`);
    values.push(filters.until);
  }
  if (filters.cursor !== undefined) {
    const separator = filters.cursor.indexOf(':');
    const started = Number(filters.cursor.slice(0, separator));
    clauses.push(`(${STARTED} < ? OR (${STARTED} = ? AND id < ?))`);
    values.push(started, started, filters.cursor.slice(separator + 1));
  }
  return { clause: clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`, values };
}

/**
 * Match the free-text query against role, kind, summary and delivery title.
 *
 * @param job - Attempt record.
 * @param context - Delivery lookups.
 * @param query - Validated query, absent when not filtering.
 * @returns Whether the attempt matches.
 */
function isQueryMatch(job: FactoryJob, context: AttemptContext, query: string | undefined): boolean {
  if (query === undefined) {
    return true;
  }
  const needle = query.toLowerCase();
  const title = job.taskId === null ? '' : (context.tasks.get(job.taskId)?.title ?? '');
  return [job.role, job.kind, job.summary ?? '', title].some((value) => value.toLowerCase().includes(needle));
}

/**
 * Describe one attempt for a listing row, without transcript content.
 *
 * @param job - Attempt record.
 * @param context - Delivery and objective lookups.
 * @param metrics - Computed attempt metrics.
 * @returns Listing row.
 */
function attemptRow(job: FactoryJob, context: AttemptContext, metrics: AttemptRow['metrics']): AttemptRow {
  const task = job.taskId === null ? undefined : context.tasks.get(job.taskId);
  const featureId = objectiveOf(job, context);
  const objective = featureId === null ? undefined : context.features.get(featureId)?.objective;
  return {
    id: job.id,
    role: job.role,
    kind: job.kind,
    provider: job.provider,
    model: metrics.model,
    tier: job.routing?.tier ?? null,
    effort: job.routing?.effort ?? null,
    state: job.state,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    taskId: job.taskId,
    featureId,
    step: job.step,
    summary: job.summary === null ? null : job.summary.slice(0, SUMMARY_MAX),
    task: task === undefined ? null : { issue: task.issue, title: task.title },
    objective: objective === undefined ? null : objective.slice(0, OBJECTIVE_MAX),
    metrics,
  };
}

/**
 * List attempts newest first with filters and a stable `startedAt:id` cursor.
 *
 * @param repository - Selected project ledger.
 * @param mesh - Selected project paths for confined stream reads.
 * @param input - Untrusted filters, cursor and page size.
 * @returns One page of rows and the cursor for the next page.
 */
export async function listAttempts(
  repository: FactoryRepository,
  mesh: MeshConfig,
  input: unknown,
): Promise<AttemptPage> {
  const filters = attemptsInputSchema.parse(input);
  const context = attemptContext(repository);
  const { clause, values } = sqlFilter(filters);
  const statement = repository.store.db.prepare(
    `SELECT data FROM factory_jobs ${clause} ORDER BY ${STARTED} DESC, id DESC`,
  );
  const page: FactoryJob[] = [];
  let hasMore = false;
  const rows = statement.iterate(...values);
  for (const row of rows) {
    const job = decodeJob(row);
    if (!isQueryMatch(job, context, filters.query)) {
      continue;
    }
    if (page.length === filters.limit) {
      hasMore = true;
      break;
    }
    page.push(job);
  }
  const prices = readPrices(repository.store);
  const now = repository.store.now();
  const attempts = await Promise.all(
    page.map(async (job) => attemptRow(job, context, await metricsFor(mesh, job, prices, now))),
  );
  const last = page.at(-1);
  return {
    attempts,
    nextCursor: hasMore && last !== undefined ? `${String(last.startedAt)}:${last.id}` : null,
    priceRevision: prices.revision,
  };
}
