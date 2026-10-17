/**
 * Bounded coordination state. The broker's presence sweep applies a retention
 * policy at most once an hour per project, in small transactions:
 *
 * - acknowledged messages older than the message window are deleted, except
 *   one a kept reply still points at;
 * - unacknowledged messages to ended identities older than the window are
 *   deleted, since nobody can ever read them;
 * - events older than the event window are folded into per-day, per-type
 *   counts (`event_summaries`) and deleted;
 * - idempotency keys and broadcast windows older than the message window are dropped.
 *
 * Unread messages to live identities are never deleted. Windows come from
 * `AGENTMESH_MESSAGE_RETENTION_DAYS` (default 14) and
 * `AGENTMESH_EVENT_RETENTION_DAYS` (default 30).
 *
 * @file
 */
import { run } from './database.ts';

import type { Store } from './store.ts';

/** One day. */
const DAY_MS = 86_400_000;
/** Default message retention, in days. */
export const DEFAULT_MESSAGE_RETENTION_DAYS = 14;
/** Default event retention, in days. */
export const DEFAULT_EVENT_RETENTION_DAYS = 30;
/** Rows removed per statement, so no transaction holds the database for long. */
export const RETENTION_BATCH = 500;
/** Shortest time between two retention passes for one project. */
export const RETENTION_INTERVAL_MS = 3_600_000;

/** Retention windows, in milliseconds. */
export interface RetentionPolicy {
  /** Age after which acknowledged messages (and unreachable ones) are deleted. */
  readonly messageMs: number;
  /** Age after which events are compacted into daily counts. */
  readonly eventMs: number;
}

/** What one pass removed. */
export interface RetentionResult {
  /** Messages deleted. */
  readonly messages: number;
  /** Events folded into daily counts. */
  readonly events: number;
}

/** Last pass per open store. */
const lastPass = new WeakMap<Store, number>();

/**
 * Read a whole number of days from the environment.
 *
 * @param name - Variable name.
 * @param fallback - Default days.
 * @returns Window in milliseconds.
 * @throws {Error} When the variable is set to anything but a positive whole number.
 */
function days(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value === '') {
    return fallback * DAY_MS;
  }
  if (!/^[1-9]\d*$/v.test(value)) {
    throw new Error(`${name} must be a whole number of days.`);
  }
  return Number(value) * DAY_MS;
}

/**
 * The policy from the environment, or the defaults.
 *
 * @returns Retention windows.
 */
export function retentionPolicy(): RetentionPolicy {
  return {
    messageMs: days('AGENTMESH_MESSAGE_RETENTION_DAYS', DEFAULT_MESSAGE_RETENTION_DAYS),
    eventMs: days('AGENTMESH_EVENT_RETENTION_DAYS', DEFAULT_EVENT_RETENTION_DAYS),
  };
}

/**
 * Create the additive daily event summary table.
 *
 * @param store - Project store.
 */
function ensureSummaries(store: Store): void {
  store.db.exec(
    'CREATE TABLE IF NOT EXISTS event_summaries (day TEXT NOT NULL, type TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (day, type))',
  );
}

/**
 * Delete one batch of messages nobody needs any more.
 *
 * @param store - Project store.
 * @param cutoff - Messages created or acknowledged before this go.
 * @returns Messages deleted.
 */
function expireMessages(store: Store, cutoff: number): number {
  return store.transaction(() => {
    return run(
      store.db,
      `DELETE FROM messages WHERE seq IN (
         SELECT m.seq FROM messages m JOIN agents a ON a.id = m.recipient
         WHERE ((m.acknowledged_at IS NOT NULL AND m.acknowledged_at < ?) OR (a.lifetime = 'ended' AND m.created_at < ?))
           AND NOT EXISTS (SELECT 1 FROM messages r WHERE r.reply_to = m.id)
         ORDER BY m.seq LIMIT ?)`,
      cutoff,
      cutoff,
      RETENTION_BATCH,
    ).changes;
  });
}

/**
 * Fold one batch of old events into daily counts.
 *
 * @param store - Project store.
 * @param cutoff - Events created before this are compacted.
 * @returns Events compacted.
 */
function compactEvents(store: Store, cutoff: number): number {
  return store.transaction(() => {
    const window = `SELECT seq, type, created_at FROM events WHERE created_at < ? ORDER BY seq LIMIT ${String(RETENTION_BATCH)}`;
    run(
      store.db,
      `INSERT INTO event_summaries(day, type, count)
       SELECT date(created_at / 1000, 'unixepoch'), type, COUNT(*) FROM (${window}) WHERE true GROUP BY 1, 2
       ON CONFLICT(day, type) DO UPDATE SET count = count + excluded.count`,
      cutoff,
    );
    return run(store.db, `DELETE FROM events WHERE seq IN (SELECT seq FROM (${window}))`, cutoff).changes;
  });
}

/**
 * Apply the policy to one store until nothing old is left.
 *
 * @param store - Project store.
 * @param policy - Retention windows.
 * @returns What was removed.
 */
export function applyRetention(store: Store, policy: RetentionPolicy = retentionPolicy()): RetentionResult {
  ensureSummaries(store);
  const now = store.now();
  let messages = 0;
  for (let removed = expireMessages(store, now - policy.messageMs); removed > 0;) {
    messages += removed;
    removed = expireMessages(store, now - policy.messageMs);
  }
  let events = 0;
  for (let removed = compactEvents(store, now - policy.eventMs); removed > 0;) {
    events += removed;
    removed = compactEvents(store, now - policy.eventMs);
  }
  store.transaction(() => {
    run(store.db, 'DELETE FROM message_idempotency WHERE created_at < ?', now - policy.messageMs);
    run(store.db, 'DELETE FROM broadcast_windows WHERE delivered_at < ?', now - policy.messageMs);
  });
  return { messages, events };
}

/**
 * Apply retention from the broker's sweep at most once an interval per store.
 *
 * @param store - Project store.
 * @returns What was removed, or null when the pass was not due.
 */
export function sweepRetention(store: Store): RetentionResult | null {
  const now = store.now();
  const previous = lastPass.get(store);
  if (previous !== undefined && now - previous < RETENTION_INTERVAL_MS) {
    return null;
  }
  lastPass.set(store, now);
  return applyRetention(store);
}
