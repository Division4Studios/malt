/**
 * Project-local objective order and atomic retry receipts.
 *
 * @file
 */
import { z } from 'zod/v3';

import { run, selectAll, selectOne } from '../database.ts';
import { MeshError } from '../protocol.ts';

import { factorySchemas, featureSchema } from './schema.ts';

import type { Store } from '../store.ts';

/** Validated public move response, retained for exact retries. */
const orderSchema = z.object({ orderRevision: z.number(), features: z.array(featureSchema) });

/**
 * Read the authoritative project order without changing insertion enumeration.
 *
 * @param store - Selected project database.
 * @returns Revision and ranked features.
 */
export function objectiveOrder(store: Store): z.output<typeof orderSchema> {
  const rows = selectAll(
    store.db,
    z.object({ revision: z.number(), data: z.string().nullable() }),
    'SELECT factory_objective_order.revision AS revision, factory_features.data AS data FROM factory_objective_order LEFT JOIN factory_features ON 1=1 WHERE factory_objective_order.id=1 ORDER BY factory_features.rowid',
  );
  return {
    orderRevision: rows[0]?.revision ?? 0,
    // Order views omit frozen workflow copies; rank updates patch stored JSON in place.
    features: rows
      .filter((row) => row.data !== null)
      .map((row) => withoutWorkflow(featureSchema.parse(JSON.parse(row.data ?? '')))),
  };
}

/**
 * An objective without its frozen workflow copy, for views that do not need it.
 *
 * @param feature - Stored objective.
 * @returns Copy without the `workflow` key.
 */
export function withoutWorkflow(feature: z.output<typeof featureSchema>): z.output<typeof featureSchema> {
  const copy = { ...feature };
  delete copy.workflow;
  return copy;
}

/**
 * Find an append position without spreading an unbounded objective list.
 *
 * @param features - Current project objectives.
 * @returns Next unused rank.
 */
export function nextObjectiveRank(features: z.output<typeof featureSchema>[]): number {
  let rank = 0;
  for (const feature of features) {
    rank = Math.max(rank, (feature.rank ?? -1) + 1);
  }
  return rank;
}

/**
 * Retain an existing rank or append a new identity and advance the shared revision.
 * Runs inside the feature writer's transaction, before its feature row is saved.
 *
 * @param store - Selected project's transaction owner.
 * @param id - Feature identity being saved.
 * @returns Rank preserved against stale feature snapshots.
 */
export function rankForFeatureSave(store: Store, id: string): number {
  const { features } = objectiveOrder(store);
  const prior = features.find((feature) => feature.id === id);
  if (prior !== undefined) {
    return prior.rank ?? nextObjectiveRank(features);
  }
  run(store.db, 'UPDATE factory_objective_order SET revision=revision+1 WHERE id=1');
  return nextObjectiveRank(features);
}

/**
 * Upgrade legacy JSON in place, preserving every field and timestamp.
 *
 * @param store - Selected project database.
 */
export function initializeObjectiveOrder(store: Store): void {
  store.transaction(() => {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS factory_objective_order (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
      INSERT OR IGNORE INTO factory_objective_order VALUES(1,0);
      CREATE TABLE IF NOT EXISTS factory_order_requests (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, data TEXT NOT NULL);
    `);
    const { features } = objectiveOrder(store);
    let rank = nextObjectiveRank(features);
    const legacy = features.filter((item) => item.rank === undefined).toSorted((a, b) => a.createdAt - b.createdAt);
    for (const feature of legacy) {
      writeRank(store, feature.id, rank);
      rank += 1;
    }
  });
}

/**
 * Persist only ordering metadata inside the caller's transaction.
 *
 * @param store - Selected database.
 * @param id - Existing objective.
 * @param rank - Zero-based global position.
 */
function writeRank(store: Store, id: string, rank: number): void {
  run(store.db, "UPDATE factory_features SET data=json_set(data,'$.rank',?) WHERE id=?", rank, id);
}

/**
 * Commit a relative move and its idempotency receipt in one transaction.
 *
 * @param store - Selected project database.
 * @param input - Operator input validated before mutation.
 * @returns Original committed response on replay, otherwise the new order.
 * @throws {MeshError} For stale revisions, changed retries or ineligible identities.
 */
export function reorderObjective(store: Store, input: unknown): z.output<typeof orderSchema> {
  const { requestId, ...move } = factorySchemas.factory_reorder_objective.parse(input);
  if ((move.beforeFeatureId === undefined) === (move.afterFeatureId === undefined)) {
    throw new MeshError('INVALID_INPUT', 'Supply exactly one beforeFeatureId or afterFeatureId.');
  }
  const fingerprint = JSON.stringify(move);
  return store.transaction(() => {
    const receipt =
      requestId === undefined
        ? undefined
        : selectOne(
            store.db,
            z.object({ fingerprint: z.string(), data: z.string() }),
            'SELECT fingerprint,data FROM factory_order_requests WHERE id=?',
            requestId,
          );
    if (receipt !== undefined) {
      if (receipt.fingerprint !== fingerprint) {
        throw new MeshError('INVALID_INPUT', 'A reorder request ID cannot be reused for a changed move.');
      }
      return orderSchema.parse(JSON.parse(receipt.data));
    }
    const current = objectiveOrder(store);
    if (current.orderRevision !== move.expectedRevision) {
      throw new MeshError('INVALID_INPUT', 'Objective order changed; refresh before moving again.');
    }
    const anchorId = move.beforeFeatureId ?? move.afterFeatureId;
    const target = current.features.find((feature) => feature.id === move.featureId);
    const anchor = current.features.find((feature) => feature.id === anchorId);
    if (target === undefined || anchor === undefined) {
      throw new MeshError('NOT_FOUND', 'Objective or anchor is not in this project.');
    }
    if (
      target.id === anchor.id ||
      [target, anchor].some((feature) => feature.phase === 'done' || feature.scopeReplacement !== undefined)
    ) {
      throw new MeshError('INVALID_INPUT', 'Move requires distinct unfinished, non-superseded objectives.');
    }
    const ordered = current.features
      .toSorted((a, b) => (a.rank ?? 0) - (b.rank ?? 0))
      .filter((feature) => feature.id !== target.id);
    const index = ordered.findIndex((feature) => feature.id === anchor.id);
    ordered.splice(index + (move.afterFeatureId === undefined ? 0 : 1), 0, target);
    for (const [rank, feature] of ordered.entries()) {
      writeRank(store, feature.id, rank);
    }
    run(store.db, 'UPDATE factory_objective_order SET revision=revision+1 WHERE id=1');
    const result = objectiveOrder(store);
    if (requestId !== undefined) {
      run(store.db, 'INSERT INTO factory_order_requests VALUES(?,?,?)', requestId, fingerprint, JSON.stringify(result));
    }
    store.event('FACTORY_OBJECTIVE_REORDERED', null, { ...move, orderRevision: result.orderRevision });
    return result;
  });
}
