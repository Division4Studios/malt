/**
 * One-shot cleanup of the coordination backlog that projects collected before
 * messaging was bounded. Run once, by the schema 4 migration:
 *
 * - every unread broadcast sent by an observer identity (including the
 *   supervisor's `factory-system-*` senders) is marked read;
 * - observer session identities and the supervisor's system identities are
 *   retired, and so is every session whose lease expired before the cutoff;
 * - one `BACKLOG_CLEANED` event records the counts.
 *
 * No message or event row is deleted, so the audit trail stays intact (age is
 * retention's job), unread messages from real agents stay unread, and durable
 * identities, observers included, are never retired.
 *
 * @file
 */
import { run } from './database.ts';
import { SYSTEM_RUNTIME } from './identity-retirement.ts';

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
 * @returns Counts of what changed.
 */
export function cleanBacklog(db: DatabaseSync, now: number, expiredMs: number): BacklogCleanup {
  const acknowledged = run(
    db,
    `UPDATE messages SET acknowledged_at = ? WHERE acknowledged_at IS NULL AND type = 'broadcast'
       AND sender IN (SELECT id FROM agents WHERE role = 'observer')`,
    now,
  ).changes;
  const retired = run(
    db,
    `UPDATE agents SET lifetime = 'ended', status = 'STOPPED', status_text = 'Retired by the backlog cleanup'
     WHERE lifetime = 'session' AND (role = 'observer' OR runtime = ? OR last_seen <= ?)`,
    SYSTEM_RUNTIME,
    now - expiredMs,
  ).changes;
  if (acknowledged > 0 || retired > 0) {
    run(
      db,
      "INSERT INTO events(type, actor, data, created_at) VALUES ('BACKLOG_CLEANED', NULL, ?, ?)",
      JSON.stringify({ acknowledged, retired }),
      now,
    );
  }
  return { acknowledged, retired };
}
