/**
 * Project-local operator queue, fenced against stale browser writes.
 *
 * @file
 */
import { z } from 'zod/v3';

import { run, selectOne } from '../database.ts';
import { MeshError } from '../protocol.ts';

import { objectiveOrder } from './objective-order.ts';
import { objectiveQueueSchema, queueControlSchema } from './objective-queue-schema.ts';

import type { Store } from '../store.ts';
import type { ObjectiveQueueState } from './objective-queue-schema.ts';

/** One selected project's queue. */
export class ObjectiveQueue {
  /** Shared transaction owner. */
  private readonly store: Store;

  /**
   * Create the additive queue table without touching delivery history.
   *
   * @param store - Selected project's SQLite owner.
   */
  public constructor(store: Store) {
    this.store = store;
    store.db.exec(
      'CREATE TABLE IF NOT EXISTS factory_objective_queue (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL)',
    );
    store.transaction(() => {
      if (
        selectOne(
          store.db,
          z.object({ value: z.string() }),
          "SELECT value FROM metadata WHERE key='factory_queue_ranks_v1'",
        ) !== undefined
      ) {
        return;
      }
      const saved = this.saved();
      if (saved !== null) {
        const snapshot = objectiveOrder(store);
        const ids = new Set(snapshot.features.map((feature) => feature.id));
        const order = [...new Set(saved.order.filter((id) => ids.has(id)))];
        const known = new Set(order);
        for (const feature of snapshot.features) {
          if (!known.has(feature.id)) {
            order.push(feature.id);
          }
        }
        this.writeRanks(order, Math.max(saved.revision, snapshot.orderRevision) + 1);
      }
      run(store.db, "INSERT INTO metadata(key,value) VALUES('factory_queue_ranks_v1','1')");
    });
  }

  /**
   * Inspect the current unfinished order and focus without write locks or file refreshes.
   *
   * @returns Validated effective order and focus.
   */
  public read(): ObjectiveQueueState {
    return this.snapshot().objectiveQueue;
  }

  /**
   * Read ranks, revision and focus in one deferred read-only SQLite snapshot.
   *
   * @returns Consistent status projection backed by the shared rank ledger.
   */
  public snapshot(): ReturnType<typeof objectiveOrder> & { objectiveQueue: ObjectiveQueueState } {
    const isNested = this.store.db.isTransaction;
    if (!isNested) {
      this.store.db.exec('BEGIN');
    }
    try {
      return this.project();
    } finally {
      if (!isNested) {
        this.store.db.exec('ROLLBACK');
      }
    }
  }

  /**
   * Save one complete order atomically; stale tabs must refresh before retrying.
   *
   * @param input - Untrusted operator control.
   * @returns Committed queue snapshot.
   * @throws {MeshError} For stale, foreign, duplicate or incomplete objective lists.
   */
  public update(input: unknown): ObjectiveQueueState {
    const value = queueControlSchema.parse(input);
    return this.store.transaction(() => {
      const { features } = objectiveOrder(this.store);
      const unfinished = features.filter(
        (feature) => feature.phase !== 'done' && feature.scopeReplacement === undefined,
      );
      const prior = this.read();
      const ids = new Set(value.order);
      const focus = features.find((feature) => feature.id === value.focusedFeatureId);
      if (
        value.expectedRevision !== prior.revision ||
        ids.size !== value.order.length ||
        ids.size !== unfinished.length ||
        unfinished.some((feature) => !ids.has(feature.id))
      ) {
        throw new MeshError('INVALID_INPUT', 'The objective queue changed. Refresh and apply your order again.');
      }
      if (
        value.focusedFeatureId !== null &&
        (focus === undefined || focus.phase === 'done' || focus.scopeReplacement !== undefined)
      ) {
        throw new MeshError('INVALID_INPUT', 'Focus requires an unfinished objective in this project.');
      }
      const next = {
        revision: prior.revision + 1,
        order: value.order,
        focusedFeatureId: value.focusedFeatureId,
        existingOnly: value.existingOnly ?? prior.existingOnly,
      };
      this.writeRanks(
        [...value.order, ...features.filter((feature) => !ids.has(feature.id)).map((feature) => feature.id)],
        next.revision,
      );
      run(
        this.store.db,
        'INSERT INTO factory_objective_queue VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
        JSON.stringify(next),
      );
      this.store.event('FACTORY_QUEUE_UPDATED', null, next);
      return next;
    });
  }

  /**
   * Read the shared order and focus inside the caller's SQLite snapshot.
   *
   * @returns Consistent operator state.
   */
  private project(): ReturnType<typeof objectiveOrder> & { objectiveQueue: ObjectiveQueueState } {
    const order = objectiveOrder(this.store);
    const saved = this.saved();
    const unfinished = order.features.filter(
      (feature) => feature.phase !== 'done' && feature.scopeReplacement === undefined,
    );
    const focusedFeatureId = saved?.focusedFeatureId ?? null;
    return {
      ...order,
      objectiveQueue: {
        existingOnly: saved?.existingOnly ?? false,
        revision: order.orderRevision,
        order: unfinished.toSorted((a, b) => (a.rank ?? 0) - (b.rank ?? 0)).map((feature) => feature.id),
        focusedFeatureId: unfinished.some((feature) => feature.id === focusedFeatureId) ? focusedFeatureId : null,
      },
    };
  }

  /**
   * Read retained focus and pre-migration order; ranks remain authoritative after migration.
   *
   * @returns Saved operator intent when present.
   */
  private saved(): ObjectiveQueueState | null {
    const row = selectOne(
      this.store.db,
      z.object({ data: z.string() }),
      'SELECT data FROM factory_objective_queue WHERE id=1',
    );
    return row === undefined ? null : objectiveQueueSchema.parse(JSON.parse(row.data));
  }

  /**
   * Update the same authoritative ranks and revision used by relative moves.
   *
   * @param order - Complete validated project order.
   * @param revision - Next shared revision inside the caller's write transaction.
   */
  private writeRanks(order: readonly string[], revision: number): void {
    for (const [rank, id] of order.entries()) {
      run(this.store.db, "UPDATE factory_features SET data=json_set(data,'$.rank',?) WHERE id=?", rank, id);
    }
    run(this.store.db, 'UPDATE factory_objective_order SET revision=? WHERE id=1', revision);
  }
}
