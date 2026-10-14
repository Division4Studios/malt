/**
 * Typed, validated access to the SQLite database.
 *
 * `node:sqlite` returns rows as loosely typed records of SQL values. Rather
 * than assert those records into domain types (an unchecked cast), every query
 * in MALT names a Zod schema describing the row it expects, and the row
 * is validated on the way out. A schema drift between SQL and TypeScript then
 * fails loudly at the query that caused it instead of propagating malformed
 * data through the system.
 *
 * At this project's scale (a handful of agents, small rows) the validation
 * cost is negligible compared with the safety it buys.
 *
 * This module also defines the row schemas for every table, so the shape of
 * the database is documented in one place next to the helpers that read it.
 *
 * @file
 */

import { z } from 'zod';

import { AGENT_LIFETIMES, AGENT_STATES, COORDINATION_PHASES, STORED_MESSAGE_TYPES } from './protocol.ts';

import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

// -----------------------------------------------------------------------------
// Row schemas
// -----------------------------------------------------------------------------

/**
 * The public columns of an agent row: everything except credentials. This is
 * the shape returned to callers by `whoami`, `list_agents` and friends.
 */
export const agentRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: z.string(),
  runtime: z.string(),
  role: z.string(),
  status: z.enum(AGENT_STATES),
  status_text: z.string(),
  lifetime: z.enum(AGENT_LIFETIMES),
  created_at: z.number(),
  last_seen: z.number(),
});

/** A public agent row. */
export type AgentRow = z.output<typeof agentRowSchema>;

/** The column list matching {@link agentRowSchema}, for SELECT statements. */
export const AGENT_PUBLIC_COLUMNS =
  'id, name, provider, runtime, role, status, status_text, lifetime, created_at, last_seen';

/** An agent row including its credential columns; never returned to callers. */
export const agentCredentialRowSchema = agentRowSchema.extend({ secret_hash: z.string(), session_id: z.string() });

/** An agent row including credentials. */
export type AgentCredentialRow = z.output<typeof agentCredentialRowSchema>;

/** A stored message row (before the handoff JSON column is decoded). */
export const messageRowSchema = z.object({
  seq: z.number(),
  id: z.string(),
  sender: z.string(),
  recipient: z.string(),
  type: z.enum(STORED_MESSAGE_TYPES),
  body: z.string(),
  task_id: z.string().nullable(),
  handoff: z.string().nullable(),
  reply_to: z.string().nullable(),
  created_at: z.number(),
  acknowledged_at: z.number().nullable(),
});

/** A stored message row. */
export type MessageRow = z.output<typeof messageRowSchema>;

/** A message row joined with its sender's name, as returned by inbox reads. */
export const inboxRowSchema = messageRowSchema.extend({ sender_name: z.string() });

/** A worker's durable coordination state. */
export const coordinationRowSchema = z.object({
  agent_id: z.string(),
  phase: z.enum(COORDINATION_PHASES),
  request_id: z.string().nullable(),
  request_message_id: z.string().nullable(),
  summary: z.string(),
  instructions: z.string().nullable(),
  decision_note: z.string().nullable(),
  revision: z.number(),
  updated_at: z.number(),
});

/** A coordination row. */
export type CoordinationRow = z.output<typeof coordinationRowSchema>;

/** A row of the durable event log (before the data JSON column is decoded). */
export const eventRowSchema = z.object({
  seq: z.number(),
  type: z.string(),
  actor: z.string().nullable(),
  data: z.string(),
  created_at: z.number(),
});

/** The result row of a `SELECT COUNT(*) AS count` query. */
export const countRowSchema = z.object({ count: z.number() });

/** The result row of a single-column `SELECT value` query. */
export const valueRowSchema = z.object({ value: z.string() });

/** The result row of a `SELECT id` query. */
export const idRowSchema = z.object({ id: z.string() });

/** One row of `pragma_table_info`: a column name. */
export const columnRowSchema = z.object({ name: z.string() });

// -----------------------------------------------------------------------------
// Query helpers
// -----------------------------------------------------------------------------

/**
 * A schema that validates an untyped row into `Row`. The input side is
 * `unknown` because rows arrive from SQLite without static types.
 */
type RowSchema<Row> = z.ZodType<Row, z.ZodTypeDef, unknown>;

/** The outcome of a statement that returns no rows. */
export interface RunResult {
  /** Number of rows inserted, updated or deleted. */
  readonly changes: number;
  /** Row ID of the most recent successful INSERT. */
  readonly lastInsertRowid: number;
}

/**
 * Run a query expected to return at most one row and validate that row.
 *
 * @param database - The open database connection.
 * @param schema - Schema describing the expected row.
 * @param sql - The SQL statement; values must be bound, never interpolated.
 * @param parameters - Positional values bound to `?` placeholders.
 * @returns The validated row, or `undefined` when no row matched.
 * @throws {z.ZodError} When the row does not match the schema.
 */
export function selectOne<Row>(
  database: DatabaseSync,
  schema: RowSchema<Row>,
  sql: string,
  ...parameters: SQLInputValue[]
): Row | undefined {
  const row = database.prepare(sql).get(...parameters);
  return row === undefined ? undefined : schema.parse(row);
}

/**
 * Run a query and validate every returned row.
 *
 * @param database - The open database connection.
 * @param schema - Schema describing each expected row.
 * @param sql - The SQL statement; values must be bound, never interpolated.
 * @param parameters - Positional values bound to `?` placeholders.
 * @returns The validated rows, in query order.
 * @throws {z.ZodError} When any row does not match the schema.
 */
export function selectAll<Row>(
  database: DatabaseSync,
  schema: RowSchema<Row>,
  sql: string,
  ...parameters: SQLInputValue[]
): Row[] {
  return database
    .prepare(sql)
    .all(...parameters)
    .map((row) => schema.parse(row));
}

/**
 * Run a `SELECT COUNT(*) AS count` query and return the count.
 *
 * @param database - The open database connection.
 * @param sql - A query selecting exactly one `count` column.
 * @param parameters - Positional values bound to `?` placeholders.
 * @returns The counted number of rows.
 * @throws {Error} When the query unexpectedly returns no row.
 */
export function selectCount(database: DatabaseSync, sql: string, ...parameters: SQLInputValue[]): number {
  const row = selectOne(database, countRowSchema, sql, ...parameters);
  if (row === undefined) {
    // An aggregate without GROUP BY always yields exactly one row.
    throw new Error('COUNT query returned no row.');
  }
  return row.count;
}

/**
 * Execute a statement that returns no rows (INSERT, UPDATE, DELETE).
 *
 * @param database - The open database connection.
 * @param sql - The SQL statement; values must be bound, never interpolated.
 * @param parameters - Positional values bound to `?` placeholders.
 * @returns The number of changed rows and the last inserted row ID.
 */
export function run(database: DatabaseSync, sql: string, ...parameters: SQLInputValue[]): RunResult {
  const result = database.prepare(sql).run(...parameters);
  // The SQLite module reports these as `number | bigint`; this database never holds
  // enough rows to exceed Number.MAX_SAFE_INTEGER, so conversion is exact.
  return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
}
