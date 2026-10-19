/**
 * What each managed identity was shown of its inbox, so a managed attempt can
 * acknowledge exactly what it consumed. Reading never acknowledges on its own:
 * the store records every message a managed read returned, and the supervisor
 * acknowledges exactly those only when the attempt settles successfully.
 * Unread counts per identity come from one bounded query over the inbox index.
 *
 * @file
 */
import { z } from 'zod/v3';

import { run, selectAll, selectOne } from './database.ts';

import type { DatabaseSync } from 'node:sqlite';

/** Most identities listed with unread messages. */
const UNREAD_LISTED = 50;

/** One identity's unread backlog. */
export interface UnreadCount {
  /** Identity name. */
  readonly name: string;
  /** Role label. */
  readonly role: string;
  /** Runtime label. */
  readonly runtime: string;
  /** Unacknowledged messages. */
  readonly unread: number;
}

/** One unread row. */
const unreadSchema = z.object({ name: z.string(), role: z.string(), runtime: z.string(), unread: z.number() });
/** Runtime label of factory-managed role identities, the only ones whose reads are tracked. */
const MANAGED_RUNTIME = 'factory-managed';

/**
 * Create the additive table of messages each managed identity was shown.
 *
 * @param db - The store's open connection.
 */
export function ensureInboxReads(db: DatabaseSync): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS inbox_shown (agent_id TEXT NOT NULL, seq INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (agent_id, seq))',
  );
}

/**
 * Remember exactly which messages a managed identity's read returned; other
 * identities acknowledge explicitly, so nothing is recorded for them.
 *
 * @param db - The store's open connection, inside its transaction.
 * @param agent - Reading identity.
 * @param page - The page it was shown.
 * @param page.messages - Messages on the page.
 * @param now - Read time.
 * @returns The page unchanged.
 */
export function recordRead<Page extends { readonly messages: readonly { readonly seq: number }[] }>(
  db: DatabaseSync,
  agent: string,
  page: Page,
  now: number,
): Page {
  if (page.messages.length === 0) {
    return page;
  }
  const managed = selectOne(
    db,
    z.object({ id: z.string() }),
    'SELECT id FROM agents WHERE id = ? AND runtime = ?',
    agent,
    MANAGED_RUNTIME,
  );
  if (managed === undefined) {
    return page;
  }
  for (const message of page.messages) {
    run(db, 'INSERT OR IGNORE INTO inbox_shown(agent_id, seq, at) VALUES (?, ?, ?)', agent, message.seq, now);
  }
  return page;
}

/**
 * Settle what an identity was shown: acknowledge exactly those messages after
 * a successful attempt, or leave them unread for the next attempt. Either way
 * the record is cleared.
 *
 * @param db - The store's open connection, inside its transaction.
 * @param agent - The attempt's identity.
 * @param shouldAcknowledge - Whether the attempt succeeded.
 * @param now - Settlement time.
 * @returns How many messages were acknowledged.
 */
export function settleReads(db: DatabaseSync, agent: string, shouldAcknowledge: boolean, now: number): number {
  const acknowledged = shouldAcknowledge
    ? run(
        db,
        `UPDATE messages SET acknowledged_at = ? WHERE recipient = ? AND acknowledged_at IS NULL
           AND seq IN (SELECT seq FROM inbox_shown WHERE agent_id = ?)`,
        now,
        agent,
        agent,
      ).changes
    : 0;
  run(db, 'DELETE FROM inbox_shown WHERE agent_id = ?', agent);
  return acknowledged;
}

/**
 * Identities that still have unread messages, largest backlog first.
 *
 * @param db - The store's open connection.
 * @returns Up to fifty identities with their unread counts.
 */
export function unreadCounts(db: DatabaseSync): UnreadCount[] {
  return selectAll(
    db,
    unreadSchema,
    `SELECT a.name, a.role, a.runtime, COUNT(m.seq) AS unread FROM agents a
     JOIN messages m ON m.recipient = a.id AND m.acknowledged_at IS NULL
     WHERE a.lifetime != 'ended' GROUP BY a.id ORDER BY unread DESC, a.name LIMIT ?`,
    UNREAD_LISTED,
  );
}
