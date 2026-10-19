/**
 * An objective's append-only progress log, bounded per objective: plan
 * results, merged and verified deliveries, agent check-ins, checklist
 * changes, operator notes and completion. It is read newest first, a page at
 * a time. This module depends only on the database, so any factory module
 * can append to it without import cycles.
 *
 * @file
 */
import { z } from 'zod/v3';

import { run, selectAll, selectOne } from '../database.ts';

import { logEntrySchema, objectiveLogInputSchema } from './objective-goal-schema.ts';

import type { Store } from '../store.ts';
import type { LogKind, LogPage } from './objective-goal-schema.ts';
import type { FactoryRepository } from './repository.ts';

/** Entries kept per objective; older ones are pruned on append. */
const LOG_MAX = 1000;
/** Longest log body. */
const BODY_MAX = 2000;
/** Stored log row. */
const logRowSchema = z.object({
  seq: z.number(),
  at: z.number(),
  kind: z.string(),
  actor: z.string(),
  body: z.string(),
});
/** Count row. */
const countSchema = z.object({ total: z.number().int().nonnegative() });

/**
 * Ensure the additive log table exists.
 *
 * @param store - Selected project's SQLite owner.
 */
function ensureLog(store: Store): void {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS factory_objective_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, feature_id TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL, actor TEXT NOT NULL, body TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS factory_objective_log_by_feature ON factory_objective_log (feature_id, seq);
  `);
}

/**
 * Append one progress log entry, pruning the objective's oldest beyond the bound.
 *
 * @param store - Selected project's SQLite owner; callers may already be in a transaction.
 * @param featureId - Objective, or `null` for work outside any objective (ignored).
 * @param entry - What happened and who did it.
 * @param entry.kind - What kind of event it records.
 * @param entry.actor - `operator`, a factory role or `supervisor`.
 * @param entry.body - Plain description.
 */
export function logObjective(
  store: Store,
  featureId: string | null,
  entry: { kind: LogKind; actor: string; body: string },
): void {
  if (featureId === null) {
    return;
  }
  ensureLog(store);
  run(
    store.db,
    'INSERT INTO factory_objective_log (feature_id, at, kind, actor, body) VALUES (?, ?, ?, ?, ?)',
    featureId,
    store.now(),
    entry.kind,
    entry.actor,
    entry.body.slice(0, BODY_MAX),
  );
  run(
    store.db,
    'DELETE FROM factory_objective_log WHERE feature_id = ? AND seq NOT IN (SELECT seq FROM factory_objective_log WHERE feature_id = ? ORDER BY seq DESC LIMIT ?)',
    featureId,
    featureId,
    LOG_MAX,
  );
}

/**
 * Handle `factory_objective_log`: one page of an objective's log, newest first.
 *
 * @param repository - Selected project ledger.
 * @param input - Untrusted objective, cursor and page size.
 * @returns Entries, total and the cursor of the next older page.
 */
export function readObjectiveLog(repository: FactoryRepository, input: unknown): LogPage {
  const query = objectiveLogInputSchema.parse(input);
  const { store } = repository;
  ensureLog(store);
  const rows = selectAll(
    store.db,
    logRowSchema,
    'SELECT seq, at, kind, actor, body FROM factory_objective_log WHERE feature_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?',
    query.featureId,
    query.before ?? Number.MAX_SAFE_INTEGER,
    query.limit + 1,
  );
  const total =
    selectOne(
      store.db,
      countSchema,
      'SELECT COUNT(*) AS total FROM factory_objective_log WHERE feature_id = ?',
      query.featureId,
    )?.total ?? 0;
  const page = rows.slice(0, query.limit).map((row) => logEntrySchema.parse(row));
  return {
    featureId: query.featureId,
    entries: page,
    total,
    next: rows.length > query.limit ? (page.at(-1)?.seq ?? null) : null,
  };
}
