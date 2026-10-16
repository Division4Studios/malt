/** @file Metadata migration, ownership fences and restart recovery without any PTY. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { TerminalSessions } from '../src/factory/terminal-sessions.ts';
import { Store } from '../src/store.ts';

import { createCleanup, createProject } from './helpers.ts';

const metadata = {
  provider: 'codex' as const,
  worktree: '/owned/scratch',
  branch: 'malt/terminal/test',
  base: 'a'.repeat(40),
  baseBranch: 'main',
  columns: 80,
  rows: 24,
};

await test('terminal metadata survives additive migration and recovery without content columns', (t) => {
  const defer = createCleanup(t);
  const project = createProject(defer);
  let store = new Store(project);
  defer(() => {
    store.close();
  });
  let sessions = new TerminalSessions(store);
  const first = sessions.create({ ...metadata, id: randomUUID(), base: 'a'.repeat(64) });
  sessions.change(first.id, 'requested', 'starting');
  sessions.change(first.id, 'starting', 'running', { outputBytes: 20 });
  const finished = sessions.create({ ...metadata, id: randomUUID() });
  sessions.change(finished.id, 'requested', 'cancelled', { reason: 'operator cancelled' });
  assert.throws(() => sessions.change(first.id, 'running', 'requested'));
  assert.throws(() => sessions.change(first.id, 'starting', 'running'));
  assert.throws(() => sessions.change(first.id, 'running', 'running', { outputBytes: 1 }));
  store.close();
  store = new Store(project);
  sessions = new TerminalSessions(store);
  assert.equal(sessions.get(first.id)?.state, 'running');
  assert.equal(sessions.recover(), 1);
  assert.equal(sessions.recover(), 0);
  assert.equal(sessions.get(first.id)?.reason, 'broker restarted');
  assert.equal(sessions.get(first.id)?.outputBytes, 20);
  assert.equal(sessions.get(finished.id)?.state, 'cancelled');
  assert.throws(() => sessions.change(first.id, 'failed', 'running'));
  assert.throws(() => sessions.change(first.id, 'failed', 'failed'));
  const columns = store.db
    .prepare('PRAGMA table_info(terminal_sessions)')
    .all()
    .map((row) => row['name']);
  assert.deepEqual(columns, [
    'id',
    'project',
    'provider',
    'worktree',
    'branch',
    'base',
    'baseBranch',
    'state',
    'createdAt',
    'updatedAt',
    'columns',
    'rows',
    'inputBytes',
    'outputBytes',
    'exitCode',
    'reason',
  ]);
  const again = new TerminalSessions(store);
  assert.deepEqual(again.list(), sessions.list());
});

await test('terminal metadata cannot cross verified project identities or accept unknown content', (t) => {
  const defer = createCleanup(t);
  const store = new Store(createProject(defer));
  defer(() => {
    store.close();
  });
  const sessions = new TerminalSessions(store);
  const first = sessions.create({ ...metadata, id: randomUUID() });
  const withContent = { ...metadata, id: randomUUID(), input: 'secret' };
  assert.throws(() => sessions.create(withContent));
  store.db.prepare("UPDATE metadata SET value='foreign-project' WHERE key='project_id'").run();
  const foreign = new TerminalSessions(store);
  assert.equal(foreign.get(first.id), null);
  assert.deepEqual(foreign.list(), []);
  assert.throws(() => foreign.change(first.id, 'requested', 'starting'));
  assert.equal(foreign.recover(), 0);
  assert.equal(sessions.get(first.id)?.state, 'requested');
});
