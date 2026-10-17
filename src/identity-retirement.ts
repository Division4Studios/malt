/**
 * Retire identities nobody can use again, so they stop collecting fan-out.
 *
 * A session identity exists only while its bridge holds the secret; once its
 * lease has been expired for longer than the grace period, no bridge can
 * resume it, so it is ended like a disconnected session. The supervisor's own
 * system identities (`runtime: factory`) are managed by the supervisor
 * instead: it retires its identity when it releases its lease and, on start,
 * any left behind by an earlier broker. Durable identities are never retired.
 *
 * @file
 */
import { idRowSchema, run, selectAll } from './database.ts';

import type { DatabaseSync } from 'node:sqlite';

/** How long after its lease expired a session identity is retired. */
export const SESSION_RETIRE_MS = 3_600_000;
/** Runtime label of the supervisor's own system identities. */
export const SYSTEM_RUNTIME = 'factory';

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
 * End the supervisor's system identities, except one still in use.
 *
 * @param db - The store's open connection, inside its transaction.
 * @param keep - System identity to keep, if any.
 * @returns How many identities were retired.
 */
export function retireSystemIdentities(db: DatabaseSync, keep: string | null = null): number {
  const { changes } = run(
    db,
    "UPDATE agents SET lifetime = 'ended', status = 'STOPPED', status_text = 'System identity retired' WHERE runtime = ? AND lifetime != 'ended' AND id != ?",
    SYSTEM_RUNTIME,
    keep ?? '',
  );
  return changes;
}
