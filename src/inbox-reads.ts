/**
 * What each identity was last shown of its inbox, so a managed attempt can
 * acknowledge exactly what it consumed. Reading never acknowledges on its own:
 * the store records the newest message sequence a read returned, and the
 * supervisor acknowledges up to it only when the attempt settles successfully.
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

/** A stored read mark. */
const markSchema = z.object({ seq: z.number() });
/** One unread row. */
const unreadSchema = z.object({ name: z.string(), role: z.string(), runtime: z.string(), unread: z.number() });

/**
 * Create the additive read-mark table.
 *
 * @param db - The store's open connection.
 */
export function ensureInboxReads(db: DatabaseSync): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS inbox_reads (agent_id TEXT PRIMARY KEY, seq INTEGER NOT NULL, at INTEGER NOT NULL)',
  );
}

/**
 * Remember the newest message a read returned, keeping the highest mark.
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
  const newest = page.messages.at(-1)?.seq;
  if (newest !== undefined) {
    run(
      db,
      `INSERT INTO inbox_reads(agent_id, seq, at) VALUES (?, ?, ?)
       ON CONFLICT(agent_id) DO UPDATE SET seq = MAX(seq, excluded.seq), at = excluded.at`,
      agent,
      newest,
      now,
    );
  }
  return page;
}

/**
 * Settle what an identity was shown: acknowledge it after a successful attempt,
 * or leave it unread for the next attempt. Either way the mark is cleared.
 *
 * @param db - The store's open connection, inside its transaction.
 * @param agent - The attempt's identity.
 * @param shouldAcknowledge - Whether the attempt succeeded.
 * @param now - Settlement time.
 * @returns How many messages were acknowledged.
 */
export function settleReads(db: DatabaseSync, agent: string, shouldAcknowledge: boolean, now: number): number {
  const mark = selectOne(db, markSchema, 'SELECT seq FROM inbox_reads WHERE agent_id = ?', agent);
  run(db, 'DELETE FROM inbox_reads WHERE agent_id = ?', agent);
  return mark === undefined || !shouldAcknowledge
    ? 0
    : run(
        db,
        'UPDATE messages SET acknowledged_at = ? WHERE recipient = ? AND acknowledged_at IS NULL AND seq <= ?',
        now,
        agent,
        mark.seq,
      ).changes;
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
