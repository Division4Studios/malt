/**
 * Project-local operator queue, fenced against stale browser writes.
 *
 * @file
 */
import { z } from 'zod';

import { run, selectOne } from '../database.ts';
import { MeshError } from '../protocol.ts';

import { objectiveQueueSchema, queueControlSchema } from './objective-queue-schema.ts';

import type { Store } from '../store.ts';
import type { ObjectiveQueueState } from './objective-queue-schema.ts';
import type { Feature } from './schema.ts';

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
  }

  /**
   * Append newly created objectives after the saved order.
   *
   * @param features - Actual project features, including archived ones.
   * @returns Validated effective order and focus.
   */
  public read(features: readonly Feature[]): ObjectiveQueueState {
    const row = selectOne(
      this.store.db,
      z.object({ data: z.string() }),
      'SELECT data FROM factory_objective_queue WHERE id=1',
    );
    const saved =
      row === undefined
        ? { revision: 0, order: [], focusedFeatureId: null }
        : objectiveQueueSchema.parse(JSON.parse(row.data));
    const ids = new Set(features.map((feature) => feature.id));
    const order = saved.order.filter((id) => ids.has(id));
    const known = new Set(order);
    order.push(...features.filter((feature) => !known.has(feature.id)).map((feature) => feature.id));
    const focus = features.find((feature) => feature.id === saved.focusedFeatureId);
    return {
      ...saved,
      order,
      focusedFeatureId:
        focus === undefined || focus.phase === 'done' || focus.scopeReplacement !== undefined ? null : focus.id,
    };
  }

  /**
   * Save one complete order atomically; stale tabs must refresh before retrying.
   *
   * @param features - Current authoritative objective identities.
   * @param input - Untrusted operator control.
   * @returns Committed queue snapshot.
   * @throws {MeshError} For stale, foreign, duplicate or incomplete objective lists.
   */
  public update(features: readonly Feature[], input: unknown): ObjectiveQueueState {
    const value = queueControlSchema.parse(input);
    return this.store.transaction(() => {
      const prior = this.read(features);
      const ids = new Set(value.order);
      const focus = features.find((feature) => feature.id === value.focusedFeatureId);
      if (
        value.expectedRevision !== prior.revision ||
        ids.size !== value.order.length ||
        ids.size !== features.length ||
        features.some((feature) => !ids.has(feature.id))
      ) {
        throw new MeshError('INVALID_INPUT', 'The objective queue changed. Refresh and apply your order again.');
      }
      if (
        value.focusedFeatureId !== null &&
        (focus === undefined || focus.phase === 'done' || focus.scopeReplacement !== undefined)
      ) {
        throw new MeshError('INVALID_INPUT', 'Focus requires an unfinished objective in this project.');
      }
      const next = { revision: prior.revision + 1, order: value.order, focusedFeatureId: value.focusedFeatureId };
      run(
        this.store.db,
        'INSERT INTO factory_objective_queue VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
        JSON.stringify(next),
      );
      this.store.event('FACTORY_QUEUE_UPDATED', null, next);
      return next;
    });
  }
}
