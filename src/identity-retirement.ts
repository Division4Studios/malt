/**
 * Retire identities nobody can use again, so they stop collecting fan-out.
 *
 * A session identity exists only while its bridge holds the secret; once its
 * lease has been expired for longer than the grace period, no bridge can
 * resume it, so it is ended like a disconnected session. The supervisor's own
 * system identities (`factory-system-*` sessions with `runtime: factory`) are
 * managed by the supervisor instead: it retires its own identity when it
 * releases its own lease and, on start, any registered before it started.
 * Durable identities are never retired, whatever their runtime label.
 *
 * @file
 */
import { idRowSchema, run, selectAll } from './database.ts';

import type { DatabaseSync } from 'node:sqlite';

/** How long after its lease expired a session identity is retired. */
export const SESSION_RETIRE_MS = 3_600_000;
/** Runtime label of the supervisor's own system identities. */
export const SYSTEM_RUNTIME = 'factory';
/** Name prefix of the supervisor's own system identities. */
export const SYSTEM_NAME_PREFIX = 'factory-system-';
/** Matches only the supervisor's own system sessions, never a durable identity with the same runtime label. */
const SYSTEM_SESSION = `lifetime = 'session' AND runtime = '${SYSTEM_RUNTIME}' AND name LIKE '${SYSTEM_NAME_PREFIX}%'`;

/**
 * End every session identity whose lease expired before `cutoff`.
 *
 * @param db - The store's open connection, inside its transaction.
 * @param cutoff - Last-seen time at or before which a session is retired.
 * @param depart - Ends one session identity with its coordination effects.
 * @returns How many identities were retired.
 */
export function retireExpiredSessions(db: DatabaseSync, cutoff: number, depart: (id: string) => unknown): number {
  const expired = selectAll(
    db,
    idRowSchema,
    "SELECT id FROM agents WHERE lifetime = 'session' AND runtime != ? AND last_seen <= ? ORDER BY last_seen",
    SYSTEM_RUNTIME,
    cutoff,
  );
  for (const { id } of expired) {
    depart(id);
  }
  return expired.length;
}

/**
 * End system sessions registered before a supervisor started: leftovers of an
 * earlier broker, never the identity of a supervisor that started later.
 *
 * @param db - The store's open connection, inside its transaction.
 * @param startedAt - When the calling supervisor started.
 * @returns How many identities were retired.
 */
export function retireEarlierSystemIdentities(db: DatabaseSync, startedAt: number): number {
  return run(
    db,
    `UPDATE agents SET lifetime = 'ended', status = 'STOPPED', status_text = 'System identity retired' WHERE ${SYSTEM_SESSION} AND created_at < ?`,
    startedAt,
  ).changes;
}

/**
 * End one supervisor's own system session.
 *
 * @param db - The store's open connection, inside its transaction.
 * @param id - The supervisor's sender.
 * @returns How many identities were retired: one, or none when it was not a live system session.
 */
export function retireSystemIdentity(db: DatabaseSync, id: string): number {
  return run(
    db,
    `UPDATE agents SET lifetime = 'ended', status = 'STOPPED', status_text = 'System identity retired' WHERE ${SYSTEM_SESSION} AND id = ?`,
    id,
  ).changes;
}
