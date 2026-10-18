/**
 * Provider-typed work keys for factory tasks and effects, kept in side tables
 * so legacy positional writers keep their column counts.
 *
 * @file
 */
import type { Store } from '../store.ts';

/**
 * Record provider-typed work keys in side tables. Triggers key rows written by
 * any code version; the backfill covers rows that predate them.
 *
 * @param store - Project store whose factory tables gain the key tables.
 */
export function expandWorkKeys(store: Store): void {
  store.transaction(() => {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS factory_task_keys (task_id TEXT PRIMARY KEY, tracker_provider TEXT NOT NULL, external_key TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS factory_effect_keys (effect_id TEXT PRIMARY KEY, tracker_provider TEXT NOT NULL, external_key TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS factory_task_key_insert AFTER INSERT ON factory_tasks BEGIN
        INSERT OR IGNORE INTO factory_task_keys VALUES(NEW.id,'github',CAST(NEW.issue AS TEXT));
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
