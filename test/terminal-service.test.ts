/** @file Terminal admission and scratch ownership with real Git and token-free native fixtures. */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { AdmissionPool } from '../src/factory/admission.ts';
import { FactoryRepository } from '../src/factory/repository.ts';
import { factoryConfigSchema } from '../src/factory/schema.ts';
import { startTerminalProcess } from '../src/factory/terminal-process.ts';
import { TerminalService } from '../src/factory/terminals.ts';
import { WorkspaceManager } from '../src/factory/workspaces.ts';
import { Store } from '../src/store.ts';

import { createCleanup, createProject, until } from './helpers.ts';

import type { TerminalProcess } from '../src/factory/terminal-process.ts';

const request = { provider: 'codex' as const, columns: 80, rows: 24 };
const healthy = { freeMemoryMb: 20_000, totalMemoryMb: 32_000, cpuPercent: 0 };

/**
 * Reassemble safe native output independently of arbitrary PTY/redaction chunking.
 *
 * @param service - The actual fixture-backed terminal service.
 * @param id - This test's owned session.
 * @returns Bounded replay text, not assumed line-shaped transport frames.
 */
function replayedText(service: TerminalService, id: string): string {
  return (service.buffer(id)?.readAfter(0) ?? [])
    .filter((frame) => frame.type === 'data')
    .map((frame) => frame.text)
    .join('');
}

await test('terminal service refuses resource/provider/cap gates before any native spawn', async (t) => {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  const store = new Store(mesh);
  defer(() => {
    store.close();
  });
  const repository = new FactoryRepository(store);
  const settings = factoryConfigSchema.parse({
    testCommands: [{ file: 'node' }],
    endToEndCommands: [{ file: 'node' }],
  });
  repository.configure(settings);
  let calls = 0;
  let sample = { ...healthy, cpuPercent: 100 };
  const options = {
    inspectMcp: async () => {
      await Promise.resolve();
      return [];
    },
    pool: new AdmissionPool(),
    resources: () => sample,
    preflight: async () => {
      await Promise.resolve();
      calls += 1;
    },
  };
  const service = new TerminalService(mesh, repository, options);
  assert.equal(service.buffer('foreign'), null);
  assert.deepEqual(repository.terminals.list(), []);
  await assert.rejects(service.start(request), /CPU/v);
  sample = healthy;
  settings.providers.codex.enabled = false;
  repository.configure(settings);
  await assert.rejects(service.start(request), /disabled/v);
  settings.providers.codex.enabled = true;
  settings.terminals.max = 0;
  repository.configure(settings);
  await assert.rejects(service.start(request), /disabled/v);
  assert.equal(calls, 0);
  assert.equal(options.pool.size, 0);
  assert.deepEqual(repository.terminals.list(), []);
  settings.terminals.max = 1;
  settings.providers.codex.concurrency = 1;
  repository.configure(settings);
  sample = { ...healthy, freeMemoryMb: 0 };
  await assert.rejects(service.start(request), /memory/v);
  sample = healthy;
  options.pool.add({ id: 'other-project', provider: 'codex', state: 'running' }, settings);
  await assert.rejects(service.start(request), /concurrency/v);
  options.pool.add({ id: 'another-project', provider: 'claude', state: 'running' }, settings);
  await assert.rejects(service.start(request), /concurrency cap/v);
  options.pool.delete('other-project');
  options.pool.delete('another-project');
  const capacity = repository.capacity('codex', settings);
  repository.saveCapacity({ ...capacity, cooldownUntil: store.now() + 60_000 });
  await assert.rejects(service.start(request), /cooldown/v);
  assert.equal(calls, 0);
});

await test('operator terminal uses a fetched owned scratch tree and releases broker occupancy after close', async (t) => {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  const settings = factoryConfigSchema.parse({
    testCommands: [{ file: 'node' }],
    endToEndCommands: [{ file: 'node' }],
  });
  const workspaces = new WorkspaceManager(mesh, settings);
  await workspaces.git(['init', '--initial-branch=main']);
  await workspaces.git(['config', 'user.name', 'Terminal fixture']);
  await workspaces.git(['config', 'user.email', 'terminal@example.invalid']);
  await workspaces.git(['add', '.']);
  await workspaces.git(['commit', '-m', 'Fixture baseline']);
  const origin = path.join(mesh.directory, 'origin.git');
  await workspaces.git(['init', '--bare', origin]);
  await workspaces.git(['remote', 'add', 'origin', origin]);
  await workspaces.git(['push', '-u', 'origin', 'main']);
  const store = new Store(mesh);
  defer(() => {
    store.close();
  });
  const repository = new FactoryRepository(store);
  repository.configure(settings);
  const pool = new AdmissionPool();
  const handles: TerminalProcess[] = [];
  const service = new TerminalService(mesh, repository, {
    inspectMcp: async () => {
      await Promise.resolve();
      return [];
    },
    pool,
    resources: () => healthy,
    preflight: async () => {
      await Promise.resolve();
    },
    spawn(spec) {
      const owned = startTerminalProcess({ ...spec, fixture: true });
      handles.push(owned);
      return owned;
    },
  });
  const session = await service.start(request);
  defer(async () => service.close(session.id));
  assert.notEqual(session.worktree, mesh.root);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Inspect only this test-owned scratch worktree.
  assert.equal(existsSync(path.join(session.worktree, '.malt')), false);
  assert.equal(pool.size, 1);
  await assert.rejects(service.start(request), /cap/v);
  const native = handles[0];
  assert.ok(native !== undefined);
  await until(() => repository.terminals.get(session.id)?.state === 'running', 30_000);
  const text = `${'hello'.repeat(100)}\r`;
  await service.control('terminal_input', { id: session.id, text });
  await until(() => replayedText(service, session.id).includes('ECHO'), 10_000);
  await service.control('terminal_resize', { id: session.id, columns: 100, rows: 30 });
  await service.control('terminal_input', { id: session.id, text: `size\r${' '.repeat(600)}\r` });
  await until(() => replayedText(service, session.id).includes('SIZE 100 30'), 10_000);
  await assert.rejects(service.control('terminal_input', { id: session.id, text: 'x'.repeat(16_385) }));
  await assert.rejects(service.control('terminal_input', { id: session.id, text: '日'.repeat(6000) }), {
    code: 'TOO_LARGE',
  });
  await assert.rejects(service.control('terminal_resize', { id: session.id, columns: 501, rows: 30 }));
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Deliberate operator edit in this test-owned scratch worktree.
  writeFileSync(path.join(session.worktree, 'retained.txt'), 'Keep this edit.');
  const closed = await service.close(session.id);
  assert.equal(closed.state, 'exited');
  assert.equal(closed.reason, 'operator closed');
  assert.ok(closed.inputBytes >= Buffer.byteLength(text));
  assert.equal(closed.columns, 100);
  assert.equal(closed.rows, 30);
  await assert.rejects(service.control('terminal_input', { id: session.id, text: 'after close' }), {
    code: 'FACTORY_GATED',
  });
  assert.ok(closed.outputBytes > 0);
  assert.equal(pool.size, 0);
  const artifacts = ['terminal-launch.json', 'owned-launch.json'];
  if (process.platform === 'win32') {
    artifacts.push('pty-job.json', 'resources.json');
  }
  const files = [
    mesh.database,
    `${mesh.database}-wal`,
    ...artifacts.map((file) => path.join(mesh.directory, 'terminals', session.id, file)),
  ];
  const marker = Buffer.from(text.trim());
  for (const file of files) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Inspect only this test's database and fixed owned metadata filenames.
    if (!existsSync(file)) {
      continue;
    }

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Raw operator input must never enter these test-owned durable artifacts.
    const durable = readFileSync(file);
    assert.ok(!durable.includes(marker));
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- The test-created edit must survive owned-process retirement.
  assert.equal(existsSync(path.join(session.worktree, 'retained.txt')), true);
  assert.equal(await workspaces.git(['status', '--porcelain']), '');
});
