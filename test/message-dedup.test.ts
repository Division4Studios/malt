/**
 * Idempotent sends and the same-sender broadcast window: retries return the
 * original delivery, key reuse for a different request is refused, and
 * identical broadcasts inside the window collapse with a repeat count.
 *
 * @file
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_MESSAGE_DEDUP_MS, messageDedupWindow } from '../src/message-dedup.ts';
import { Store } from '../src/store.ts';

import { createCleanup, createProject, registration } from './helpers.ts';

import type { AgentRow } from '../src/database.ts';
import type { TestContext } from 'node:test';

process.env['AGENTMESH_LOG_LEVEL'] = 'silent';

/** The first unread page of an inbox. */
const inbox = { unreadOnly: true, after: 0, limit: 50 } as const;
/** Broadcast window used by these scenarios. */
const WINDOW_MS = 1000;

/** A store, its clock and three registered agents. */
interface Fixture {
  /** Store under test. */
  readonly store: Store;
  /** Mutable clock the store reads. */
  readonly clock: { now: number };
  /** Sender. */
  readonly alice: AgentRow;
  /** Recipient. */
  readonly bob: AgentRow;
  /** Another sender and recipient. */
  readonly carol: AgentRow;
}

/**
 * A store with a controllable clock and three agents.
 *
 * @param t - Owns cleanup.
 * @param windowMs - Broadcast window.
 * @returns The store, the clock and the agents.
 */
function fixture(t: TestContext, windowMs = WINDOW_MS): Fixture {
  const defer = createCleanup(t);
  const clock = { now: 1_000_000 };
  const store = new Store(createProject(defer), { now: () => clock.now, messageDedupMs: windowMs });
  defer(() => {
    store.close();
  });
  const alice = store.register(registration('claude-lead'));
  const bob = store.register(registration('codex-1'));
  const carol = store.register(registration('claude-1'));
  return { store, clock, alice, bob, carol };
}

await test('a retried keyed send returns the original delivery and stores nothing new', (t) => {
  const { store, alice, bob, carol } = fixture(t);
  const request = { to: bob.name, body: 'Schema ready', idempotencyKey: 'handoff-1' };
  const first = store.execute('send_message', request, alice.id);
  const retry = store.execute('send_message', request, alice.id);
  assert.deepEqual(retry, first);
  assert.equal(store.execute('get_messages', inbox, bob.id).messages.length, 1);
  assert.throws(() => store.execute('send_message', { ...request, body: 'Something else' }, alice.id), {
    code: 'IDEMPOTENCY_CONFLICT',
  });
  assert.throws(() => store.execute('send_message', { ...request, to: carol.name }, alice.id), {
    code: 'IDEMPOTENCY_CONFLICT',
  });
  const other = store.execute('send_message', { ...request, to: alice.name }, carol.id);
  assert.notEqual(other.id, first.id, 'keys are scoped to their sender');
  const unkeyed = store.execute('send_message', { to: bob.name, body: 'Schema ready' }, alice.id);
  assert.notEqual(unkeyed.id, first.id, 'a send without a key is always delivered');
  assert.equal(store.execute('get_messages', inbox, bob.id).messages.length, 2);
});

await test('identical broadcasts collapse inside the window and deliver again at its boundary', (t) => {
  const { store, clock, alice, bob, carol } = fixture(t);
  const first = store.execute('broadcast', { body: 'Interface changed.' }, alice.id);
  assert.equal(first.messages.length, 2);
  assert.equal(first.collapsed, undefined);
  clock.now += WINDOW_MS - 1;
  const repeat = store.execute('broadcast', { body: 'Interface changed.' }, alice.id);
  assert.deepEqual(repeat.messages, first.messages);
  assert.equal(repeat.collapsed, true);
  assert.equal(repeat.repeats, 1);
  assert.equal(store.execute('broadcast', { body: 'Interface changed.' }, alice.id).repeats, 2);
  assert.equal(store.execute('get_messages', inbox, bob.id).messages.length, 1);
  clock.now += 1;
  const again = store.execute('broadcast', { body: 'Interface changed.' }, alice.id);
  assert.equal(again.collapsed, undefined, 'the window is measured from the original delivery');
  assert.notDeepEqual(again.messages, first.messages);
  assert.equal(store.execute('get_messages', inbox, bob.id).messages.length, 2);
  const fromCarol = store.execute('broadcast', { body: 'Interface changed.' }, carol.id);
  assert.equal(fromCarol.collapsed, undefined, 'another sender is never collapsed');
  const different = store.execute('broadcast', { body: 'Interface changed again.' }, alice.id);
  assert.equal(different.collapsed, undefined);
});

await test('a keyed broadcast retry returns its original deliveries', (t) => {
  const { store, clock, alice, bob } = fixture(t);
  const first = store.execute('broadcast', { body: 'Release at noon.', idempotencyKey: 'release' }, alice.id);
  clock.now += WINDOW_MS * 10;
  assert.deepEqual(
    store.execute('broadcast', { body: 'Release at noon.', idempotencyKey: 'release' }, alice.id),
    first,
  );
  assert.throws(() => store.execute('broadcast', { body: 'Release at one.', idempotencyKey: 'release' }, alice.id), {
    code: 'IDEMPOTENCY_CONFLICT',
  });
  assert.equal(store.execute('get_messages', inbox, bob.id).messages.length, 1);
});

await test('a zero window always delivers, and the window reads its environment variable', (t) => {
  const { store, alice, bob } = fixture(t, 0);
  store.execute('broadcast', { body: 'Ping' }, alice.id);
  assert.equal(store.execute('broadcast', { body: 'Ping' }, alice.id).collapsed, undefined);
  assert.equal(store.execute('get_messages', inbox, bob.id).messages.length, 2);
  delete process.env['AGENTMESH_MESSAGE_DEDUP_MS'];
  assert.equal(messageDedupWindow(), DEFAULT_MESSAGE_DEDUP_MS);
  assert.equal(messageDedupWindow(''), DEFAULT_MESSAGE_DEDUP_MS);
  assert.equal(messageDedupWindow('5000'), 5000);
  assert.equal(messageDedupWindow('0'), 0);
  assert.throws(() => messageDedupWindow('1.5'), /whole number/v);
  assert.throws(() => messageDedupWindow('-1'), /whole number/v);
});
