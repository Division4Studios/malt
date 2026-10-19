/**
 * Idempotent message sends and the same-sender broadcast window.
 *
 * A sender may name a request with an `idempotencyKey`: the first delivery's
 * result is stored under (sender, operation, key) with a fingerprint of the
 * request, so a retry returns that result and stores nothing new, while
 * reusing the key for a different request is refused. A broadcast whose body
 * exactly matches the same sender's previous broadcast, delivered less than
 * the window ago, collapses into that original and reports how many repeats
 * were collapsed. Both tables are additive and live in the store's database
 * and transaction.
 *
 * @file
 */
import { createHash } from 'node:crypto';

import { z } from 'zod/v3';

import { run, selectOne } from './database.ts';
import { MeshError } from './protocol.ts';

import type { DatabaseSync } from 'node:sqlite';

/** Window in which an identical broadcast from the same sender collapses. */
export const DEFAULT_MESSAGE_DEDUP_MS = 60_000;
/** Environment variable that overrides the broadcast window, in milliseconds. */
const DEDUP_VARIABLE = 'AGENTMESH_MESSAGE_DEDUP_MS';

/** One delivered message, as returned to the sender. */
const sentSchema = z.object({ id: z.string(), seq: z.number().int(), recipient: z.string() }).strict();
/** A broadcast's deliveries, with collapse details once repeats were folded in. */
const broadcastSchema = z
  .object({
    messages: z.array(sentSchema),
    collapsed: z.literal(true).optional(),
    repeats: z.number().int().nonnegative().optional(),
  })
  .strict();
/** A stored idempotent result. */
const keyedRowSchema = z.object({ fingerprint: z.string(), result: z.string() });
/** The sender's latest delivered broadcast. */
const windowRowSchema = z.object({
  body_hash: z.string(),
  result: z.string(),
  delivered_at: z.number(),
  repeats: z.number(),
});

/** One delivered message. */
export type SentResult = z.output<typeof sentSchema>;
/** A broadcast result. */
export type BroadcastDelivery = z.output<typeof broadcastSchema>;

/** Operations that accept an idempotency key, with the schema of their stored result. */
const RESULT_SCHEMAS = { send_message: sentSchema, broadcast: broadcastSchema } as const;

/** One keyed request. */
export interface KeyedRequest<Operation extends keyof typeof RESULT_SCHEMAS> {
  /** Authenticated sender. */
  readonly sender: string;
  /** Operation the key names. */
  readonly operation: Operation;
  /** Validated request, including its optional `idempotencyKey`. */
  readonly input: { readonly idempotencyKey?: string | undefined };
  /** Current time. */
  readonly now: number;
}

/**
 * Create the additive deduplication tables.
 *
 * @param db - The store's open connection.
 */
export function ensureDedupTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS message_idempotency (
      sender TEXT NOT NULL, operation TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL,
      result TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (sender, operation, key)
    );
    CREATE TABLE IF NOT EXISTS broadcast_windows (
      sender TEXT PRIMARY KEY, body_hash TEXT NOT NULL, result TEXT NOT NULL,
      delivered_at INTEGER NOT NULL, repeats INTEGER NOT NULL
    );
  `);
}

/**
 * The broadcast window from `AGENTMESH_MESSAGE_DEDUP_MS`, or the default.
 *
 * @param value - Raw variable value; defaults to the environment.
 * @returns Window in milliseconds; 0 turns collapsing off.
 * @throws {Error} When the variable is set to anything but a non-negative integer.
 */
export function messageDedupWindow(value: string | undefined = process.env[DEDUP_VARIABLE]): number {
  if (value === undefined || value === '') {
    return DEFAULT_MESSAGE_DEDUP_MS;
  }
  if (!/^\d+$/v.test(value)) {
    throw new Error(`${DEDUP_VARIABLE} must be a whole number of milliseconds.`);
  }
  return Number(value);
}

/**
 * A stable digest of a value's JSON form.
 *
 * @param value - Request or body.
 * @returns Hex SHA-256.
 */
function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * Deliver a request at most once per idempotency key.
 *
 * @param db - The store's open connection, inside its transaction.
 * @param request - Sender, operation, validated input and time.
 * @param deliver - Performs the delivery when the key is new or absent.
 * @returns The original result for a retry, otherwise the new delivery.
 * @throws {MeshError} IDEMPOTENCY_CONFLICT when the key already names a different request.
 */
export function sendOnce<Operation extends keyof typeof RESULT_SCHEMAS>(
  db: DatabaseSync,
  request: KeyedRequest<Operation>,
  deliver: () => z.output<(typeof RESULT_SCHEMAS)[Operation]>,
): z.output<(typeof RESULT_SCHEMAS)[Operation]> {
  const { idempotencyKey: key, ...fields } = request.input;
  if (key === undefined) {
    return deliver();
  }
  const fingerprint = digest(fields);
  const stored = selectOne(
    db,
    keyedRowSchema,
    'SELECT fingerprint, result FROM message_idempotency WHERE sender = ? AND operation = ? AND key = ?',
    request.sender,
    request.operation,
    key,
  );
  if (stored !== undefined) {
    if (stored.fingerprint !== fingerprint) {
      throw new MeshError('IDEMPOTENCY_CONFLICT', 'This idempotency key was already used for a different request.');
    }
    return RESULT_SCHEMAS[request.operation].parse(JSON.parse(stored.result));
  }
  const result = deliver();
  run(
    db,
    'INSERT INTO message_idempotency(sender, operation, key, fingerprint, result, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    request.sender,
    request.operation,
    key,
    fingerprint,
    JSON.stringify(result),
    request.now,
  );
  return result;
}

/**
 * Deliver a broadcast, or fold an identical repeat inside the window into the original.
 *
 * @param db - The store's open connection, inside its transaction.
 * @param request - Sender, body, time and window.
 * @param request.sender - Authenticated sender.
 * @param request.body - Text sent to every recipient.
 * @param request.now - Current time.
 * @param request.windowMs - Collapse window; 0 always delivers.
 * @param deliver - Delivers to every recipient.
 * @returns The original deliveries with the repeat count, or the new deliveries.
 */
export function broadcastOnce(
  db: DatabaseSync,
  request: { readonly sender: string; readonly body: string; readonly now: number; readonly windowMs: number },
  deliver: () => BroadcastDelivery,
): BroadcastDelivery {
  const bodyHash = digest(request.body);
  const previous = selectOne(
    db,
    windowRowSchema,
    'SELECT body_hash, result, delivered_at, repeats FROM broadcast_windows WHERE sender = ?',
    request.sender,
  );
  if (previous?.body_hash === bodyHash && request.now - previous.delivered_at < request.windowMs) {
    const repeats = previous.repeats + 1;
    run(db, 'UPDATE broadcast_windows SET repeats = ? WHERE sender = ?', repeats, request.sender);
    const original = broadcastSchema.parse(JSON.parse(previous.result));
    return { messages: original.messages, collapsed: true, repeats };
  }
  const result = deliver();
  run(
    db,
    `INSERT INTO broadcast_windows(sender, body_hash, result, delivered_at, repeats) VALUES (?, ?, ?, ?, 0)
     ON CONFLICT(sender) DO UPDATE SET body_hash = excluded.body_hash, result = excluded.result,
       delivered_at = excluded.delivered_at, repeats = 0`,
    request.sender,
    bodyHash,
    JSON.stringify(result),
    request.now,
  );
  return result;
}
