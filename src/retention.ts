/**
 * Bounded coordination state. The broker's presence sweep starts a retention
 * pass at most once an hour per project and runs one bounded batch per sweep
 * until the pass is drained, so a backlog never holds the event loop:
 *
 * - acknowledged messages older than the message window are deleted, except
 *   one a kept reply or a worker's open check-in still points at;
 * - unacknowledged messages to ended identities older than the window are
 *   deleted, since nobody can ever read them;
 * - events older than the event window are folded into per-day, per-type
 *   counts (`event_summaries`) and deleted;
 * - idempotency keys and broadcast windows older than the message window are dropped.
 *
 * The reply and check-in references that keep a message are indexed, so each
 * batch's checks stay cheap on a large history.
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

/** One bounded batch of a pass. */
interface RetentionStep extends RetentionResult {
  /** True once nothing old is left for this pass. */
  readonly isDone: boolean;
}

/** The current or last pass per open store: when it began, its windows, and whether batches remain. */
const passes = new WeakMap<Store, { startedAt: number; policy: RetentionPolicy; isDraining: boolean }>();

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
 * Create the additive daily event summary table and the reference indexes retention reads.
 *
 * @param store - Project store.
 */
function ensureRetention(store: Store): void {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS event_summaries (day TEXT NOT NULL, type TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (day, type));
    CREATE INDEX IF NOT EXISTS messages_reply_to ON messages(reply_to);
    CREATE INDEX IF NOT EXISTS coordination_request ON worker_coordination(request_message_id);
  `);
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
           AND NOT EXISTS (SELECT 1 FROM worker_coordination c WHERE c.request_message_id = m.id)
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
 * Run one bounded batch of a pass: messages first, then events, then expired keys.
 *
 * @param store - Project store.
 * @param policy - Retention windows.
 * @param now - When the pass began; every batch of a pass uses the same cutoffs.
 * @returns What the batch removed, and whether the pass is drained.
 */
function retentionStep(store: Store, policy: RetentionPolicy, now: number): RetentionStep {
  const messages = expireMessages(store, now - policy.messageMs);
  if (messages > 0) {
    return { messages, events: 0, isDone: false };
  }
  const events = compactEvents(store, now - policy.eventMs);
  if (events > 0) {
    return { messages: 0, events, isDone: false };
  }
  store.transaction(() => {
    run(store.db, 'DELETE FROM message_idempotency WHERE created_at < ?', now - policy.messageMs);
    run(store.db, 'DELETE FROM broadcast_windows WHERE delivered_at < ?', now - policy.messageMs);
  });
  return { messages: 0, events: 0, isDone: true };
}

/**
 * Apply the policy to one store until nothing old is left.
 *
 * @param store - Project store.
 * @param policy - Retention windows.
 * @returns What was removed.
 */
export function applyRetention(store: Store, policy: RetentionPolicy = retentionPolicy()): RetentionResult {
  ensureRetention(store);
  const now = store.now();
  const removed = { messages: 0, events: 0 };
  for (let isDone = false; !isDone;) {
    const step = retentionStep(store, policy, now);
    removed.messages += step.messages;
    removed.events += step.events;
    ({ isDone } = step);
  }
  return removed;
}

/**
 * Run one batch of retention from the broker's sweep. A pass starts at most once an
 * interval per store and continues one batch per sweep until it is drained.
 *
 * @param store - Project store.
 * @returns What this batch removed, or null when no pass is due or draining.
 */
export function sweepRetention(store: Store): RetentionResult | null {
  const now = store.now();
  const previous = passes.get(store);
  const isDue = previous === undefined || (!previous.isDraining && now - previous.startedAt >= RETENTION_INTERVAL_MS);
  if (isDue) {
    ensureRetention(store);
  } else if (!previous.isDraining) {
    return null;
  }
  const pass = isDue ? { startedAt: now, policy: retentionPolicy() } : previous;
  const { isDone, ...removed } = retentionStep(store, pass.policy, pass.startedAt);
  passes.set(store, { startedAt: pass.startedAt, policy: pass.policy, isDraining: !isDone });
  return removed;
}
