/**
 * Operator-entered model prices, stored in the project ledger and fenced by
 * revision so a stale browser tab cannot overwrite newer prices. No prices
 * ship with MALT: subscription plans often make per-token prices meaningless,
 * so an attempt is "unpriced" until the operator enters its model's price.
 *
 * @file
 */
import { z } from 'zod/v3';

import { run, selectOne } from '../database.ts';
import { MeshError } from '../protocol.ts';

import { priceTableSchema, pricesInputSchema } from './telemetry-schema.ts';

import type { Store } from '../store.ts';
import type { ModelPrice, PriceTable, TokenSplit } from './telemetry-schema.ts';

/** Tokens per million, the unit of every entered price. */
const TOKENS_PER_MILLION = 1_000_000;
/** Stored price table row. */
const priceRowSchema = z.object({ revision: z.number().int().nonnegative(), data: z.string(), updated_at: z.number() });

/**
 * Ensure the additive price table exists.
 *
 * @param store - Selected project's SQLite owner.
 */
function ensureTable(store: Store): void {
  store.db.exec(
    'CREATE TABLE IF NOT EXISTS factory_price_table (id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL)',
  );
}

/**
 * Read the current price table; an unsaved table is empty at revision zero.
 *
 * @param store - Selected project's SQLite owner.
 * @returns Validated prices and their revision.
 */
export function readPrices(store: Store): PriceTable {
  ensureTable(store);
  const row = selectOne(
    store.db,
    priceRowSchema,
    'SELECT revision, data, updated_at FROM factory_price_table WHERE id = 1',
  );
  const prices: unknown = row === undefined ? [] : JSON.parse(row.data);
  return priceTableSchema.parse({ revision: row?.revision ?? 0, prices, updatedAt: row?.updated_at ?? null });
}

/**
 * Replace the whole price table when the caller saw the current revision.
 *
 * @param store - Selected project's SQLite owner.
 * @param input - Untrusted complete price list and the revision it was edited from.
 * @returns The saved table at its new revision.
 * @throws {MeshError} When another save happened after the caller's read.
 */
export function savePrices(store: Store, input: unknown): PriceTable {
  const value = pricesInputSchema.parse(input);
  ensureTable(store);
  return store.transaction(() => {
    const current = readPrices(store);
    if (current.revision !== value.expectedRevision) {
      throw new MeshError('INVALID_REVISION', 'The price table changed. Reload it and apply your edits again.');
    }
    const next: PriceTable = {
      revision: current.revision + 1,
      prices: value.prices.toSorted((left, right) => left.model.localeCompare(right.model)),
      updatedAt: store.now(),
    };
    run(
      store.db,
      'INSERT INTO factory_price_table VALUES(1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, data = excluded.data, updated_at = excluded.updated_at',
      next.revision,
      JSON.stringify(next.prices),
      next.updatedAt,
    );
    store.event('FACTORY_PRICES_UPDATED', null, { revision: next.revision, models: next.prices.length });
    return next;
  });
}

/**
 * Estimate an attempt's cost from its token split and an exact model price.
 *
 * @param tokens - Reported token split; any unknown component prevents an estimate.
 * @param price - Operator price for the attempt's model, when one exists.
 * @returns Estimated USD, or null when the model is unpriced or tokens are unknown.
 */
export function estimateCost(tokens: TokenSplit, price: ModelPrice | undefined): number | null {
  if (price === undefined || tokens.input === null || tokens.output === null) {
    return null;
  }
  const weighted =
    tokens.input * price.input +
    (tokens.cacheRead ?? 0) * price.cachedInput +
    (tokens.cacheWrite ?? 0) * price.cacheWrite +
    tokens.output * price.output;
  return weighted / TOKENS_PER_MILLION;
}
