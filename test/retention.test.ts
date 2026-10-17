/**
 * Retention keeps coordination state bounded: a long soak on a fake clock
 * stays within fixed row counts, acknowledged messages and old events go,
 * unread messages to live identities and referenced reply targets stay, and
 * the sweep runs at most once an interval.
 *
 * @file
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { z } from 'zod/v3';

import { selectCount, selectOne } from '../src/database.ts';
import { applyRetention, RETENTION_INTERVAL_MS, retentionPolicy, sweepRetention } from '../src/retention.ts';
import { Store } from '../src/store.ts';

import { createCleanup, createProject, registration } from './helpers.ts';

import type { TestContext } from 'node:test';

process.env['AGENTMESH_LOG_LEVEL'] = 'silent';

/** One day. */
const DAY = 86_400_000;
/** A short policy so the soak covers many windows. */
const POLICY = { messageMs: 2 * DAY, eventMs: 3 * DAY };
/** A row's id. */
const idSchema = z.object({ id: z.string() });
/** The first unread page of an inbox. */
const inbox = { unreadOnly: true, after: 0, limit: 100 } as const;

/**
 * A store on a controllable clock with a lead and a worker.
 *
 * @param t - Owns cleanup.
 * @returns Store, clock and agent ids.
 */
function fixture(t: TestContext): { store: Store; clock: { now: number }; lead: string; worker: string } {
  const defer = createCleanup(t);
  const clock = { now: 10 * DAY };
  const store = new Store(createProject(defer), { now: () => clock.now, messageDedupMs: 0 });
  defer(() => {
    store.close();
  });
  const lead = store.register(registration('claude-lead')).id;
  const worker = store.register(registration('codex-1')).id;
  return { store, clock, lead, worker };
}

/**
 * Count rows in a table.
 *
 * @param store - Project store to count in.
 * @param table - Table name from this test.
 * @returns Row count.
 */
function rows(store: Store, table: 'messages' | 'events' | 'event_summaries'): number {
  return selectCount(store.db, `SELECT COUNT(*) AS count FROM ${table}`);
}

/**
 * Pages in the database file.
 *
 * @param store - Project store to measure.
 * @returns SQLite page count.
 */
function pageCount(store: Store): number {
  return selectOne(store.db, z.object({ page_count: z.number() }), 'PRAGMA page_count')?.page_count ?? 0;
}

await test('a long soak stays bounded while unread work and reply chains survive', (t) => {
  const { store, clock, lead, worker } = fixture(t);
  const keep = store.execute('send_message', { to: 'codex-1', body: 'Unread forever' }, lead);
  const question = store.execute('send_message', { to: 'codex-1', body: 'Question?' }, lead);
  store.execute('reply', { id: question.id, body: 'Answer.' }, worker);
  store.execute('ack_message', { id: question.id }, worker);
  const peaks = { messages: 0, events: 0 };
  const pages = { settled: 0 };
  for (let day = 0; day < 30; day += 1) {
    for (let index = 0; index < 60; index += 1) {
      const sent = store.execute('send_message', { to: 'codex-1', body: `Update ${String(index)}` }, lead);
      store.execute('ack_message', { id: sent.id }, worker);
    }
    clock.now += DAY;
    applyRetention(store, POLICY);
    peaks.messages = Math.max(peaks.messages, rows(store, 'messages'));
    peaks.events = Math.max(peaks.events, rows(store, 'events'));
    if (day === 9) {
      pages.settled = pageCount(store);
    }
  }
  // Freed pages are reused, so the database file stops growing once the windows are full.
  assert.ok(pageCount(store) <= pages.settled * 1.25, `mesh.db stayed bounded (${String(pageCount(store))} pages)`);
  // Two days of acknowledged traffic plus the kept rows; three days of events.
  assert.ok(peaks.messages <= 3 * 60 + 3, `messages stayed bounded (${String(peaks.messages)})`);
  assert.ok(peaks.events <= 4 * 130, `events stayed bounded (${String(peaks.events)})`);
  const unread = store.execute('get_messages', inbox, worker).messages.map((message) => message.id);
  assert.ok(unread.includes(keep.id), 'unread messages to a live identity are never deleted');
  const parent = selectOne(store.db, idSchema, 'SELECT id FROM messages WHERE id = ?', question.id);
  assert.ok(parent !== undefined, 'a message a kept reply points at stays');
  assert.ok(rows(store, 'event_summaries') > 0, 'old events are kept as daily counts');
});

await test('messages to ended identities go after the window; the sweep runs once an interval', (t) => {
  const { store, clock, lead } = fixture(t);
  const session = store.register({ ...registration('session-1'), ephemeral: true });
  store.execute('send_message', { to: 'session-1', body: 'Too late' }, lead);
  store.execute('disconnect', {}, session.id);
  store.execute('broadcast', { body: 'Keyed', idempotencyKey: 'k1' }, lead);
  clock.now += 3 * DAY;
  assert.ok(applyRetention(store, POLICY).messages >= 1);
  assert.equal(selectCount(store.db, 'SELECT COUNT(*) AS count FROM message_idempotency'), 0);
  assert.notEqual(sweepRetention(store), null);
  assert.equal(sweepRetention(store), null, 'not due again yet');
  clock.now += RETENTION_INTERVAL_MS;
  assert.notEqual(sweepRetention(store), null);
});

await test('a message a worker check-in still references survives retention', (t) => {
  const { store, clock, lead, worker } = fixture(t);
  const request = store.execute('send_message', { to: 'claude-lead', body: 'Work request' }, worker);
  store.execute('ack_message', { id: request.id }, lead);
  store.db
    .prepare("UPDATE worker_coordination SET request_message_id = ?, phase = 'IDLE_APPROVED' WHERE agent_id = ?")
    .run(request.id, worker);
  clock.now += 3 * DAY;
  assert.doesNotThrow(() => applyRetention(store, POLICY));
  const kept = selectOne(store.db, idSchema, 'SELECT id FROM messages WHERE id = ?', request.id);
  assert.ok(kept !== undefined, 'the referenced work request stays');
});

await test('the windows read their environment variables', () => {
  process.env['AGENTMESH_MESSAGE_RETENTION_DAYS'] = '7';
  process.env['AGENTMESH_EVENT_RETENTION_DAYS'] = '';
  assert.deepEqual(retentionPolicy(), { messageMs: 7 * DAY, eventMs: 30 * DAY });
  process.env['AGENTMESH_MESSAGE_RETENTION_DAYS'] = '0';
  assert.throws(() => retentionPolicy(), /whole number of days/v);
  delete process.env['AGENTMESH_MESSAGE_RETENTION_DAYS'];
  delete process.env['AGENTMESH_EVENT_RETENTION_DAYS'];
});
