/**
 * Read-only paging over a project's durable `events` table.
 *
 * Forward (`after`) and recent pages feed live cursors; backward (`before`)
 * pages browse older history and never return a forward cursor.
 *
 * @file
 */

import { eventRowSchema, selectAll } from './database.ts';
import { MeshError } from './protocol.ts';

import type { OperationInput } from './protocol.ts';
import type { DatabaseSync } from 'node:sqlite';
import type { z } from 'zod';

/** One durable event, with its data payload decoded. */
export interface MeshEvent extends Omit<z.output<typeof eventRowSchema>, 'data'> {
  /** The decoded event payload. */
  readonly data: unknown;
}

/** One page of the event log. */
export interface EventPage {
  /** The events on this page, oldest first. */
  readonly events: MeshEvent[];
  /** The `after` value that fetches the next page. */
  readonly nextCursor: number;
}

/** One backward page of the event log; it never carries a forward cursor. */
export interface HistoryPage {
  /** Events with `seq` below the requested cursor, oldest first. */
  readonly events: MeshEvent[];
  /** Whether events older than this page remain. */
  readonly hasMore: boolean;
  /** The `before` value that fetches the next older page. */
  readonly oldestCursor: number;
}

/**
 * Read one page of the durable event log.
 *
 * @param database - The project's open database.
 * @param input - Validated pagination.
 * @returns A forward/recent page with `nextCursor`, or a backward page.
 * @throws {MeshError} INVALID_INPUT when `before` is mixed with another mode.
 */
export function readEvents(database: DatabaseSync, input: OperationInput<'events'>): EventPage | HistoryPage {
  if (input.before !== undefined) {
    if (input.after !== undefined || input.recent !== undefined) {
      throw new MeshError('INVALID_INPUT', 'input: before cannot be combined with after or recent.');
    }
    return readHistory(database, input.before, input.limit);
  }
  const after = input.after ?? 0;
  const rows = selectAll(
    database,
    eventRowSchema,
    input.recent === true
      ? 'SELECT * FROM events WHERE seq > ? ORDER BY seq DESC LIMIT ?'
      : 'SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?',
    after,
    input.limit,
  );
  const events = (input.recent === true ? rows.toReversed() : rows).map((row) => decode(row));
  return { events, nextCursor: events.at(-1)?.seq ?? after };
}

/**
 * Read the page of events immediately older than an exclusive cursor.
 *
 * @param database - The project's open database.
 * @param before - Exclusive upper sequence bound.
 * @param limit - Maximum events returned.
 * @returns Up to `limit` events, oldest first, with one-row lookahead.
 */
function readHistory(database: DatabaseSync, before: number, limit: number): HistoryPage {
  const rows = selectAll(
    database,
    eventRowSchema,
    'SELECT * FROM events WHERE seq < ? ORDER BY seq DESC LIMIT ?',
    before,
    limit + 1,
  );
  const events = rows
    .slice(0, limit)
    .toReversed()
    .map((row) => decode(row));
  return { events, hasMore: rows.length > limit, oldestCursor: events[0]?.seq ?? before };
}

/**
 * Decode an event row that the store itself wrote.
 *
 * @param row - The validated row.
 * @returns The event with its JSON payload decoded.
 */
function decode(row: z.output<typeof eventRowSchema>): MeshEvent {
  return { ...row, data: JSON.parse(row.data) };
}
