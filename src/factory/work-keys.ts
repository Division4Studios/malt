/**
 * Provider-typed work keys for factory tasks and effects, kept in side tables
 * so legacy positional writers keep their column counts.
 *
 * @file
 */
import { z } from 'zod/v3';

import { selectOne } from '../database.ts';

import { parseTrackerKey } from './tracker-key.ts';

import type { Store } from '../store.ts';
import type { TrackerKey } from './tracker-key.ts';

/** A task's typed provider from its JSON record, or GitHub when the record has none. */
const TASK_PROVIDER = `COALESCE(json_extract(NEW.data,'$.trackerKey.provider'),'github')`;
/** The key text matching {@link TASK_PROVIDER}: the record's typed key, or its issue number. */
const TASK_KEY = `COALESCE(json_extract(NEW.data,'$.trackerKey.key'),CAST(NEW.issue AS TEXT))`;

/**
 * Record provider-typed work keys in side tables. Triggers key rows written by
 * any code version, from the record's typed key or, for records without one,
 * its GitHub issue number; the backfill covers rows that predate them. The
 * first insert trigger keyed every task by its number, so it is replaced.
 *
 * @param store - Project store whose factory tables gain the key tables.
 */
export function expandWorkKeys(store: Store): void {
  store.transaction(() => {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS factory_task_keys (task_id TEXT PRIMARY KEY, tracker_provider TEXT NOT NULL, external_key TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS factory_effect_keys (effect_id TEXT PRIMARY KEY, tracker_provider TEXT NOT NULL, external_key TEXT NOT NULL);
      DROP TRIGGER IF EXISTS factory_task_key_insert;
      CREATE TRIGGER factory_task_key_insert AFTER INSERT ON factory_tasks BEGIN
        INSERT OR REPLACE INTO factory_task_keys VALUES(NEW.id,${TASK_PROVIDER},${TASK_KEY});
      END;
      CREATE TRIGGER IF NOT EXISTS factory_task_key_update AFTER UPDATE OF data ON factory_tasks BEGIN
        INSERT OR REPLACE INTO factory_task_keys VALUES(NEW.id,${TASK_PROVIDER},${TASK_KEY});
      END;
      CREATE TRIGGER IF NOT EXISTS factory_task_key_delete AFTER DELETE ON factory_tasks BEGIN
        DELETE FROM factory_task_keys WHERE task_id=OLD.id;
      END;
      CREATE TRIGGER IF NOT EXISTS factory_effect_key_insert AFTER INSERT ON factory_effects BEGIN
        INSERT OR IGNORE INTO factory_effect_keys VALUES(NEW.id,'github',CAST(NEW.issue AS TEXT));
      END;
      CREATE TRIGGER IF NOT EXISTS factory_effect_key_delete AFTER DELETE ON factory_effects BEGIN
        DELETE FROM factory_effect_keys WHERE effect_id=OLD.id;
      END;
      INSERT OR IGNORE INTO factory_task_keys SELECT id,'github',CAST(issue AS TEXT) FROM factory_tasks
        WHERE id NOT IN (SELECT task_id FROM factory_task_keys);
      INSERT OR IGNORE INTO factory_effect_keys SELECT id,'github',CAST(issue AS TEXT) FROM factory_effects
        WHERE id NOT IN (SELECT effect_id FROM factory_effect_keys);
    `);
  });
}

/** One `factory_task_keys` row. */
const keyRowSchema = z.object({ tracker_provider: z.string(), external_key: z.string() });

/**
 * A delivery's typed key from the additive side table the ledger keeps.
 *
 * @param store - Selected project's SQLite owner.
 * @param taskId - Delivery identifier.
 * @returns Typed key, or `null` for an unknown delivery or an unrecognised row.
 */
export function taskTrackerKey(store: Store, taskId: string): TrackerKey | null {
  const row = selectOne(
    store.db,
    keyRowSchema,
    'SELECT tracker_provider, external_key FROM factory_task_keys WHERE task_id=?',
    taskId,
  );
  return row === undefined ? null : parseTrackerKey(row.tracker_provider, row.external_key);
}
