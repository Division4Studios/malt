/**
 * The schema 4 migration cleans the backlog once: observer broadcasts are
 * marked read, dead observer, system and expired session identities are
 * retired, real agents' unread messages stay unread, durable identities are
 * kept and no message or event row is deleted.
 *
 * @file
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { z } from 'zod/v3';

import { selectAll, selectCount } from '../src/database.ts';
import { SYSTEM_RUNTIME } from '../src/identity-retirement.ts';
import { Store } from '../src/store.ts';

import { createCleanup, createProject, registration } from './helpers.ts';

process.env['AGENTMESH_LOG_LEVEL'] = 'silent';

/** One day. */
const DAY = 86_400_000;
/** The first unread page of an inbox. */
const inbox = { unreadOnly: true, after: 0, limit: 100 } as const;
/** One agent's lifetime. */
const lifetimeSchema = z.object({ name: z.string(), lifetime: z.string() });

await test('the backlog is cleaned once without losing audit history', (t) => {
  const defer = createCleanup(t);
  const config = createProject(defer);
  const clock = { now: 10 * DAY };
  const old = new Store(config, { now: () => clock.now, messageDedupMs: 0 });
  const system = old.register({
    ...registration('factory-system-old'),
    ephemeral: true,
    role: 'observer',
    runtime: SYSTEM_RUNTIME,
  });
  old.register({ ...registration('watcher'), role: 'observer' });
  const lead = old.register(registration('claude-lead'));
  const worker = old.register(registration('codex-1'));
  old.register({ ...registration('session-dead'), ephemeral: true });
  for (let index = 0; index < 5; index += 1) {
    old.send(system.id, worker.id, { body: `Notice ${String(index)}`, type: 'broadcast' });
  }
  const real = old.execute('send_message', { to: 'codex-1', body: 'Please review' }, lead.id);
  const before = {
    messages: selectCount(old.db, 'SELECT COUNT(*) AS count FROM messages'),
    events: selectCount(old.db, 'SELECT COUNT(*) AS count FROM events'),
  };
  old.db.exec("UPDATE metadata SET value = '3' WHERE key = 'schema_version'");
  old.close();

  clock.now += 2 * DAY;
  const migrated = new Store(config, { now: () => clock.now, messageDedupMs: 0 });
  defer(() => {
    migrated.close();
  });
  const unread = migrated.execute('get_messages', inbox, worker.id).messages.map((message) => message.id);
  assert.deepEqual(unread, [real.id], 'only the real agent message stays unread');
  const lifetimes = new Map(
    selectAll(migrated.db, lifetimeSchema, 'SELECT name, lifetime FROM agents').map((row) => [row.name, row.lifetime]),
  );
  assert.equal(lifetimes.get('factory-system-old'), 'ended');
  assert.equal(lifetimes.get('session-dead'), 'ended');
  assert.equal(lifetimes.get('watcher'), 'durable', 'durable observers are kept');
  assert.equal(lifetimes.get('codex-1'), 'durable');
  assert.equal(selectCount(migrated.db, 'SELECT COUNT(*) AS count FROM messages'), before.messages);
  assert.ok(selectCount(migrated.db, 'SELECT COUNT(*) AS count FROM events') >= before.events);
  const cleaned = selectAll(
    migrated.db,
    z.object({ data: z.string() }),
    "SELECT data FROM events WHERE type = 'BACKLOG_CLEANED' ORDER BY seq",
  );
  // A new project records an empty cleanup when it is created; the schema 3 upgrade records the real one.
  assert.equal(cleaned.at(-1)?.data, JSON.stringify({ acknowledged: 5, retired: 2 }));

  const left = selectAll(
    migrated.db,
    z.object({ actor: z.string() }),
    "SELECT actor FROM events WHERE type = 'AGENT_LEFT'",
  ).map((row) => row.actor);
  assert.ok(left.length >= 2, 'retired sessions leave through the normal departure path');

  const reopened = new Store(config, { now: () => clock.now, messageDedupMs: 0 });
  defer(() => {
    reopened.close();
  });
  assert.equal(
    selectCount(reopened.db, "SELECT COUNT(*) AS count FROM events WHERE type = 'BACKLOG_CLEANED'"),
    cleaned.length,
    'it runs once per database',
  );
});

await test('a migration with nothing to clean still records its audit event', (t) => {
  const defer = createCleanup(t);
  const config = createProject(defer);
  const store = new Store(config);
  store.db.exec("UPDATE metadata SET value = '3' WHERE key = 'schema_version'");
  store.close();
  const migrated = new Store(config);
  defer(() => {
    migrated.close();
  });
  const cleaned = selectAll(
    migrated.db,
    z.object({ data: z.string() }),
    "SELECT data FROM events WHERE type = 'BACKLOG_CLEANED' ORDER BY seq DESC LIMIT 1",
  );
  assert.deepEqual(
    cleaned.map((row) => row.data),
    [JSON.stringify({ acknowledged: 0, retired: 0 })],
  );
});
