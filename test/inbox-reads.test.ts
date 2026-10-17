/**
 * Managed roles acknowledge what they consumed: a read records what it was
 * shown, a successful attempt acknowledges exactly that, a failed one leaves
 * it unread, and unread counts per identity come from one query.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { run } from '../src/database.ts';
import { FactoryRepository } from '../src/factory/repository.ts';
import { factoryConfigSchema, jobSchema } from '../src/factory/schema.ts';
import { settleReads, unreadCounts } from '../src/inbox-reads.ts';
import { Store } from '../src/store.ts';

import { createCleanup, createProject, registration } from './helpers.ts';

import type { FactoryJob } from '../src/factory/schema.ts';
import type { TestContext } from 'node:test';

process.env['AGENTMESH_LOG_LEVEL'] = 'silent';

/** The first unread page of an inbox. */
const inbox = { unreadOnly: true, after: 0, limit: 50 } as const;

/**
 * A configured ledger whose developer seat has a managed identity.
 *
 * @param t - Owns cleanup.
 * @returns Store, ledger, the managed identity and a lead that sends to it.
 */
function fixture(t: TestContext): {
  store: Store;
  repository: FactoryRepository;
  developer: string;
  lead: string;
} {
  const defer = createCleanup(t);
  const store = new Store(createProject(defer), { messageDedupMs: 0 });
  defer(() => {
    store.close();
  });
  const repository = new FactoryRepository(store);
  repository.configure(
    factoryConfigSchema.parse({
      testCommands: [{ file: process.execPath }],
      endToEndCommands: [{ file: process.execPath }],
    }),
  );
  const developer = store.register({ ...registration('factory-developer-1'), runtime: 'factory-managed' }).id;
  const lead = store.register(registration('claude-lead')).id;
  return { store, repository, developer, lead };
}

/**
 * Store one running developer attempt.
 *
 * @param repository - Ledger.
 * @returns The attempt.
 */
function running(repository: FactoryRepository): FactoryJob {
  const job = jobSchema.parse({
    id: randomUUID(),
    role: 'developer-1',
    provider: 'codex',
    kind: 'develop',
    taskId: null,
    featureId: null,
    head: null,
    base: null,
    step: null,
    token: randomUUID(),
    state: 'running',
    startedAt: 0,
    finishedAt: null,
    expiresAt: 0,
    reservation: 0,
    usageTokens: null,
    pid: null,
    summary: null,
    artifact: '',
  });
  run(
    repository.store.db,
    'INSERT INTO factory_jobs(id, role, state, data) VALUES (?, ?, ?, ?)',
    job.id,
    job.role,
    job.state,
    JSON.stringify(job),
  );
  return job;
}

await test('a successful attempt acknowledges exactly what it was shown', (t) => {
  const { store, repository, developer, lead } = fixture(t);
  store.execute('send_message', { to: 'factory-developer-1', body: 'First' }, lead);
  store.execute('send_message', { to: 'factory-developer-1', body: 'Second' }, lead);
  assert.equal(store.execute('get_messages', inbox, developer).messages.length, 2);
  store.execute('send_message', { to: 'factory-developer-1', body: 'Arrived after the read' }, lead);
  assert.ok(repository.finishJob(running(repository), 0, 'succeeded'));
  const left = store.execute('get_messages', inbox, developer).messages;
  assert.deepEqual(
    left.map((message) => message.body),
    ['Arrived after the read'],
  );
});

await test('a failed attempt leaves what it read unread for the next attempt', (t) => {
  const { store, repository, developer, lead } = fixture(t);
  store.execute('send_message', { to: 'factory-developer-1', body: 'Please fix the test' }, lead);
  store.execute('get_messages', inbox, developer);
  assert.ok(repository.finishJob(running(repository), 0, 'failed'));
  assert.equal(store.execute('get_messages', inbox, developer).messages.length, 1);
  // The mark was cleared, so a later success without reading acknowledges nothing.
  assert.equal(settleReads(store.db, developer, true, 1), 1, 'the read just above set a new mark');
  assert.equal(settleReads(store.db, developer, true, 2), 0);
});

await test('unread counts list identities with a backlog, largest first', (t) => {
  const { store, lead } = fixture(t);
  const other = store.register(registration('codex-2')).id;
  store.execute('send_message', { to: 'factory-developer-1', body: 'One' }, lead);
  store.execute('send_message', { to: 'codex-2', body: 'One' }, lead);
  store.execute('send_message', { to: 'codex-2', body: 'Two' }, lead);
  assert.deepEqual(
    unreadCounts(store.db).map(({ name, unread }) => [name, unread]),
    [
      ['codex-2', 2],
      ['factory-developer-1', 1],
    ],
  );
  const [first] = store.execute('get_messages', inbox, other).messages;
  assert.ok(first !== undefined);
  store.execute('ack_message', { id: first.id }, other);
  assert.equal(unreadCounts(store.db).find(({ name }) => name === 'codex-2')?.unread, 1);
});
