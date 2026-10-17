/**
 * Observer and system identities receive no fan-out, expired sessions are
 * retired after the grace period, durable identities never are, and the
 * supervisor retires its own system identity with its lease and any earlier
 * broker's leftovers on start.
 *
 * @file
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { z } from 'zod/v3';

import { selectAll } from '../src/database.ts';
import { broadcastFactoryNotice } from '../src/factory/notifications.ts';
import { FactoryRepository } from '../src/factory/repository.ts';
import { SESSION_RETIRE_MS, SYSTEM_RUNTIME } from '../src/identity-retirement.ts';
import { Store } from '../src/store.ts';

import { createCleanup, createProject, registration } from './helpers.ts';

import type { TestContext } from 'node:test';

process.env['AGENTMESH_LOG_LEVEL'] = 'silent';

/** The first unread page of an inbox. */
const inbox = { unreadOnly: true, after: 0, limit: 50 } as const;
/** One agent's lifetime. */
const lifetimeSchema = z.object({ name: z.string(), lifetime: z.string() });

/**
 * A store on a controllable clock.
 *
 * @param t - Owns cleanup.
 * @returns Store and clock.
 */
function fixture(t: TestContext): { store: Store; clock: { now: number }; offlineMs: number } {
  const defer = createCleanup(t);
  const config = createProject(defer);
  const clock = { now: 1_000_000 };
  const store = new Store(config, { now: () => clock.now, messageDedupMs: 0 });
  defer(() => {
    store.close();
  });
  return { store, clock, offlineMs: config.offlineMs };
}

/**
 * Every agent's lifetime by name.
 *
 * @param store - Project store to read.
 * @returns Name to lifetime.
 */
function lifetimes(store: Store): Map<string, string> {
  return new Map(
    selectAll(store.db, lifetimeSchema, 'SELECT name, lifetime FROM agents').map((row) => [row.name, row.lifetime]),
  );
}

await test('observers receive no broadcasts or factory notices', (t) => {
  const { store } = fixture(t);
  const lead = store.register(registration('claude-lead'));
  const worker = store.register(registration('codex-1'));
  const observer = store.register({ ...registration('watcher'), role: 'observer' });
  const sent = store.execute('broadcast', { body: 'Interface changed.' }, lead.id);
  assert.deepEqual(
    sent.messages.map((message) => message.recipient),
    [worker.id],
  );
  broadcastFactoryNotice(store, lead.id, 'Delivery merged.');
  assert.equal(store.execute('get_messages', inbox, observer.id).messages.length, 0);
  assert.equal(store.execute('get_messages', inbox, worker.id).messages.length, 2);
});

await test('expired sessions are retired after the grace period; durable and system identities are not', (t) => {
  const { store, clock, offlineMs } = fixture(t);
  store.register({ ...registration('session-1'), ephemeral: true });
  store.register(registration('durable-1'));
  store.register({ ...registration('factory-system-old'), ephemeral: true, role: 'observer', runtime: SYSTEM_RUNTIME });
  clock.now += offlineMs + SESSION_RETIRE_MS - 1;
  store.expire();
  assert.equal(lifetimes(store).get('session-1'), 'session', 'still inside the grace period');
  clock.now += 1;
  store.expire();
  const after = lifetimes(store);
  assert.equal(after.get('session-1'), 'ended');
  assert.equal(after.get('durable-1'), 'durable');
  assert.equal(after.get('factory-system-old'), 'session', 'the supervisor manages its own identities');
});

await test('the supervisor retires leftover system identities on start and its own with its lease', (t) => {
  const { store } = fixture(t);
  store.register({ ...registration('factory-system-old'), ephemeral: true, role: 'observer', runtime: SYSTEM_RUNTIME });
  const repository = new FactoryRepository(store);
  repository.prepareSender();
  const started = lifetimes(store);
  assert.equal(started.get('factory-system-old'), 'ended');
  const current = [...started].filter(([name, lifetime]) => name.startsWith('factory-system-') && lifetime !== 'ended');
  assert.equal(current.length, 1, 'exactly one live system identity');
  repository.release('owner');
  assert.equal(
    [...lifetimes(store)].filter(([name, lifetime]) => name.startsWith('factory-system-') && lifetime !== 'ended')
      .length,
    0,
  );
  repository.prepareSender();
  const resumed = [...lifetimes(store)].filter(
    ([name, lifetime]) => name.startsWith('factory-system-') && lifetime !== 'ended',
  );
  assert.equal(resumed.length, 1, 'a resumed supervisor prepares a fresh identity');
  assert.notEqual(resumed[0]?.[0], current[0]?.[0]);
});
