/** @file Orphan recovery is lease-fenced and keyboard controls cannot amplify supervisor ticks. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { factoryConfigSchema } from '../src/factory/schema.ts';
import { FactoryService } from '../src/factory/service.ts';
import { ProjectGitHub } from '../src/github.ts';
import { ProjectLearning } from '../src/learning.ts';
import { Store } from '../src/store.ts';

import { createCleanup, createProject } from './helpers.ts';

import type { TestContext } from 'node:test';

/**
 * Create a paused factory with real SQLite and no possible inference assignment.
 *
 * @param t - Owns broker/store retirement.
 * @returns Durable service under inspection.
 */
function fixture(t: TestContext): FactoryService {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  const store = new Store(mesh);
  const factory = new FactoryService(
    mesh,
    store,
    {
      github: new ProjectGitHub(mesh),
      learning: new ProjectLearning(mesh),
    },
    { home: mesh.root },
  );
  factory.repository.configure(
    factoryConfigSchema.parse({
      testCommands: [{ file: process.execPath }],
      endToEndCommands: [{ file: process.execPath }],
    }),
  );
  defer(async () => {
    await factory.close();
    store.close();
  });
  return factory;
}

await test('metadata inspection recovers orphan sessions only after acquiring actual ownership', async (t) => {
  const factory = fixture(t);
  const { repository } = factory;
  const id = randomUUID();
  repository.terminals.create({
    id,
    provider: 'codex',
    worktree: 'fixture',
    branch: `malt/terminal/${id}`,
    base: 'a'.repeat(40),
    baseBranch: 'main',
    columns: 80,
    rows: 24,
  });
  repository.terminals.change(id, 'requested', 'starting');
  repository.terminals.change(id, 'starting', 'running');
  assert.equal(repository.lease('another-live-owner'), true);
  await factory.terminalControl('terminal_list', {});
  assert.equal(repository.terminals.get(id)?.state, 'running', 'Another live owner cannot be fenced by a reader.');
  repository.release('another-live-owner');
  await factory.terminalControl('terminal_list', {});
  assert.equal(repository.terminals.get(id)?.state, 'failed');
  assert.equal(repository.terminals.get(id)?.reason, 'broker restarted');
});

await test('repeated input and resize refusals do not start an immediate tick for every request', async (t) => {
  const factory = fixture(t);
  let ticks = 0;
  t.mock.method(factory, 'tick', async () => {
    ticks += 1;
    await Promise.resolve();
  });
  const id = randomUUID();
  for (let count = 0; count < 20; count += 1) {
    await assert.rejects(factory.terminalControl('terminal_input', { id, text: 'q' }), { code: 'NOT_FOUND' });
    await assert.rejects(factory.terminalControl('terminal_resize', { id, columns: 80, rows: 24 }), {
      code: 'NOT_FOUND',
    });
  }
  assert.equal(ticks, 1);
  assert.deepEqual(factory.repository.jobs(), []);
});
