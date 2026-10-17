/**
 * USD spend caps. Each settled attempt's local cost (provider reported, or
 * estimated from the operator price table) is recorded once in a spend
 * ledger, so admission can compare spend with caps synchronously, inside the
 * same check that honours delivery holds. A reached cap stops new attempts
 * on its scope; running attempts finish normally. Raising or lifting the cap
 * resumes the scope at once, because the gate is recomputed from the ledger
 * on every check.
 *
 * Unpriced attempts are never counted as free: they are reported per scope,
 * and with the `block` policy a capped scope that has any stops until its
 * model is priced. Changing the price table re-estimates recorded spend.
 *
 * @file
 */

import { z } from 'zod/v3';

import { run, selectAll, selectOne } from '../database.ts';
import { MeshError } from '../protocol.ts';

import { metricsFor } from './attempt-metrics.ts';
import { attemptContext, objectiveOf } from './attempts.ts';
import { readPrices } from './price-table.ts';
import { jobSchema } from './schema.ts';
import { spendCapsInputSchema, spendCapsSchema } from './spend-schema.ts';

import type { MeshConfig } from '../config.ts';
import type { Store } from '../store.ts';
import type { FactoryRepository } from './repository.ts';
import type { SpendCaps, SpendScope } from './spend-schema.ts';

/** Settled attempts priced per refresh, bounding stream reads in one tick. */
const REFRESH_BATCH = 20;
/** Stream reads in flight at once. */
const READ_BATCH = 16;

/** Stored caps row. */
const capsRowSchema = z.object({ revision: z.number().int().nonnegative(), data: z.string() });
/** Stored job row. */
const jobRowSchema = z.object({ data: z.string() });

/** A scope a proposed attempt would spend against. */
export interface SpendTarget {
  /** Delivery, if any. */
  readonly taskId: string | null;
  /** Objective, if any. */
  readonly featureId: string | null;
}

/** Why a scope stops new attempts. */
export interface SpendBlock {
  /** Capped scope. */
  readonly scope: SpendScope;
  /** Objective or delivery id; empty for the project. */
  readonly id: string;
  /** Recorded spend. */
  readonly usd: number;
  /** The cap reached. */
  readonly cap: number;
  /** Whether the cap was reached or unpriced attempts block it. */
  readonly reason: 'cap' | 'unpriced';
  /** Plain explanation for notices and the Inbox. */
  readonly message: string;
}

/** Spend admission decisions computed once from the ledger. */
export interface SpendGate {
  /** Caps revision the decisions use. */
  readonly revision: number;

  /**
   * Why an attempt on a scope may not start.
   *
   * @param target - Delivery and objective the attempt would serve.
   * @returns The first reached cap, or `null` when it may start.
   */
  readonly block: (target: SpendTarget) => SpendBlock | null;
}

/**
 * Ensure the additive spend tables exist.
 *
 * @param store - Selected project's SQLite owner.
 */
function ensureTables(store: Store): void {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS factory_spend (job_id TEXT PRIMARY KEY, task_id TEXT, feature_id TEXT, usd REAL, source TEXT NOT NULL, price_revision INTEGER NOT NULL, at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS factory_spend_by_time ON factory_spend (at);
    CREATE TABLE IF NOT EXISTS factory_spend_caps (id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS factory_spend_notices (key TEXT PRIMARY KEY, at INTEGER NOT NULL);
  `);
}

/**
 * Read the current caps; unsaved caps are empty at revision zero.
 *
 * @param store - Selected project's SQLite owner.
 * @returns Caps and their revision.
 */
export function readCaps(store: Store): { revision: number; caps: SpendCaps } {
  ensureTables(store);
  const row = selectOne(store.db, capsRowSchema, 'SELECT revision, data FROM factory_spend_caps WHERE id = 1');
  return {
    revision: row?.revision ?? 0,
    caps: spendCapsSchema.parse(row === undefined ? {} : JSON.parse(row.data)),
  };
}

/**
 * Handle `factory_spend_caps`: replace the caps when the caller saw the current revision.
 *
 * @param repository - Selected project ledger.
 * @param input - Untrusted complete caps and the revision they were edited from.
 * @returns Saved caps at their new revision.
 * @throws {MeshError} When another save happened after the caller's read.
 */
export function saveCaps(repository: FactoryRepository, input: unknown): { revision: number; caps: SpendCaps } {
  const value = spendCapsInputSchema.parse(input);
  const { store } = repository;
  ensureTables(store);
  const saved = store.transaction(() => {
    const current = readCaps(store);
    if (current.revision !== value.expectedRevision) {
      throw new MeshError('INVALID_REVISION', 'The spend caps changed. Reload them and apply your edits again.');
    }
    const next = { revision: current.revision + 1, caps: value.caps };
    run(
      store.db,
      'INSERT INTO factory_spend_caps VALUES(1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, data = excluded.data, updated_at = excluded.updated_at',
      next.revision,
      JSON.stringify(next.caps),
      store.now(),
    );
    store.event('FACTORY_SPEND_CAPS_UPDATED', null, { revision: next.revision });
    return next;
  });
  repository.notify(`Spend caps saved (revision ${String(saved.revision)}). Scopes within their caps resume.`);
  return saved;
}

/**
 * Record the cost of settled attempts not yet in the spend ledger, and
 * re-estimate those priced under an older price table.
 *
 * @param repository - Selected project ledger.
 * @param mesh - Selected project paths for confined stream reads.
 * @param limit - Most attempts priced in this call.
 * @returns How many attempts were recorded.
 */
export async function refreshSpend(
  repository: FactoryRepository,
  mesh: MeshConfig,
  limit = REFRESH_BATCH,
): Promise<number> {
  const { store } = repository;
  ensureTables(store);
  const prices = readPrices(store);
  const jobs = selectAll(
    store.db,
    jobRowSchema,
    `SELECT j.data FROM factory_jobs j LEFT JOIN factory_spend s ON s.job_id = j.id
     WHERE j.state != 'running' AND (s.job_id IS NULL OR (s.source != 'reported' AND s.price_revision != ?))
     ORDER BY j.rowid LIMIT ?`,
    prices.revision,
    limit,
  ).map((row) => jobSchema.parse(JSON.parse(row.data)));
  if (jobs.length === 0) {
    return 0;
  }
  const now = store.now();
  const metrics: Awaited<ReturnType<typeof metricsFor>>[] = [];
  for (let start = 0; start < jobs.length; start += READ_BATCH) {
    const batch = jobs.slice(start, start + READ_BATCH);
    // eslint-disable-next-line no-await-in-loop -- Batches bound concurrently open stream files.
    metrics.push(...(await Promise.all(batch.map(async (job) => metricsFor(mesh, job, prices, now)))));
  }
  const context = attemptContext(repository);
  store.transaction(() => {
    for (const [index, job] of jobs.entries()) {
      const cost = metrics[index]?.cost ?? { usd: null, source: 'unpriced' as const };
      run(
        store.db,
        'INSERT INTO factory_spend VALUES(?,?,?,?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET usd = excluded.usd, source = excluded.source, price_revision = excluded.price_revision, feature_id = excluded.feature_id',
        job.id,
        job.taskId,
        objectiveOf(job, context),
        cost.usd,
        cost.source,
        prices.revision,
        job.startedAt,
      );
    }
  });
  return jobs.length;
}
