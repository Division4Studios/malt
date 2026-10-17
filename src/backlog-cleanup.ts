/**
 * One-shot cleanup of the coordination backlog that projects collected before
 * messaging was bounded. Run once, by the schema 4 migration:
 *
 * - every unread broadcast sent by an observer identity (including the
 *   supervisor's `factory-system-*` senders) is marked read;
 * - observer session identities and the supervisor's system identities are
 *   retired, and so is every session whose lease expired before the cutoff,
 *   each through the normal departure path;
 * - one `BACKLOG_CLEANED` event records the counts, even when they are zero,
 *   for every project that already had agents.
 *
 * No message or event row is deleted, so the audit trail stays intact (age is
 * retention's job), unread messages from real agents stay unread, and durable
 * identities, observers included, are never retired.
 *
 * @file
 */
import { idRowSchema, run, selectAll, selectCount } from './database.ts';
import { SYSTEM_NAME_PREFIX, SYSTEM_RUNTIME } from './identity-retirement.ts';

import type { DatabaseSync } from 'node:sqlite';

/** What the cleanup changed. */
export interface BacklogCleanup {
  /** Observer broadcasts marked read. */
  readonly acknowledged: number;
  /** Identities retired. */
  readonly retired: number;
}

/**
 * Clean the backlog inside the migration's transaction.
 *
 * @param db - The store's open connection.
 * @param now - Migration time.
 * @param expiredMs - How long a session's lease must have been silent to be retired.
 * @param depart - Ends one session through the normal departure path, so its
 *   pending check-in is withdrawn and assigned work is reported to the lead.
 * @returns Counts of what changed.
 */
export function cleanBacklog(
  db: DatabaseSync,
  now: number,
  expiredMs: number,
  depart: (id: string) => unknown,
): BacklogCleanup {
  const acknowledged = run(
    db,
    `UPDATE messages SET acknowledged_at = ? WHERE acknowledged_at IS NULL AND type = 'broadcast'
       AND sender IN (SELECT id FROM agents WHERE role = 'observer')`,
    now,
  ).changes;
  const retiring = selectAll(
    db,
    idRowSchema,
    `SELECT id FROM agents WHERE lifetime = 'session'
       AND (role = 'observer' OR (runtime = ? AND name LIKE ?) OR last_seen <= ?) ORDER BY created_at`,
    SYSTEM_RUNTIME,
    `${SYSTEM_NAME_PREFIX}%`,
    now - expiredMs,
  );
  for (const { id } of retiring) {
    depart(id);
  }
  // Every upgraded project records its audit entry, even with nothing to clean; a brand-new database has nothing to audit.
  if (selectCount(db, 'SELECT COUNT(*) AS count FROM agents') > 0) {
    run(
      db,
      "INSERT INTO events(type, actor, data, created_at) VALUES ('BACKLOG_CLEANED', NULL, ?, ?)",
      JSON.stringify({ acknowledged, retired: retiring.length }),
      now,
    );
  }
  return { acknowledged, retired: retiring.length };
}
