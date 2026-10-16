/** @file Replay bounds, cursor recovery, subscriber cleanup and metadata-only restart. */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { FactoryRepository } from '../src/factory/repository.ts';
import { TerminalBuffer } from '../src/factory/terminal-buffer.ts';
import { TerminalReads } from '../src/factory/terminal-reads.ts';
import { Store } from '../src/store.ts';

import { createCleanup, createProject } from './helpers.ts';

await test('bounded terminal replay resumes without duplicates, reports gaps and never survives restart as content', async (t) => {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  const store = new Store(mesh);
  defer(() => {
    store.close();
  });
  const repository = new FactoryRepository(store);
  const ledger = repository.terminals;
  const id = randomUUID();
  ledger.create({
    id,
    provider: 'codex',
    worktree: mesh.root,
    branch: 'malt/terminal/test',
    base: 'a'.repeat(40),
    baseBranch: 'main',
    columns: 80,
    rows: 24,
  });
  ledger.change(id, 'requested', 'starting');
  ledger.change(id, 'starting', 'running');
  const reads = new TerminalReads(ledger);
  const buffer = new TerminalBuffer(100_000, {});
  reads.attach(id, buffer);
  buffer.write(Buffer.from('x'.repeat(150_000)));
  buffer.finish();
  const first = await reads.read(id, 0, 0);
  assert.equal(first.output[0]?.type, 'truncated');
  assert.ok(
    first.output.reduce((bytes, entry) => bytes + (entry.type === 'data' ? Buffer.byteLength(entry.text) : 0), 0) <=
      65_536,
  );
  const second = await reads.read(id, first.nextCursor, 0);
  assert.ok(second.output.length > 0);
  assert.ok(second.output.every((entry) => entry.sequence > first.nextCursor));
  const all = [...first.output, ...second.output].filter((entry) => entry.type === 'data');
  const unique = new Set(all.map((entry) => entry.sequence));
  assert.equal(unique.size, all.length);
  ledger.change(id, 'running', 'exited');
  reads.finish(id);
  assert.equal((await reads.read(id, second.nextCursor, 0)).output.length, 0);
  const restarted = new TerminalReads(ledger);
  assert.equal((await restarted.read(id, 0, 0)).unavailable, true);
  await assert.rejects(reads.read(randomUUID(), 0, 0), { code: 'NOT_FOUND' });
});

await test('long polls cap subscribers and release them on cancellation, wake, timeout and exit', async (t) => {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  const store = new Store(mesh);
  defer(() => {
    store.close();
  });
  const repository = new FactoryRepository(store);
  const ledger = repository.terminals;
  const id = randomUUID();
  ledger.create({
    id,
    provider: 'codex',
    worktree: mesh.root,
    branch: 'malt/terminal/poll',
    base: 'b'.repeat(40),
    baseBranch: 'main',
    columns: 80,
    rows: 24,
  });
  const reads = new TerminalReads(ledger);
  const buffer = new TerminalBuffer(1024, {});
  reads.attach(id, buffer);
  const cancelled = new AbortController();
  const first = assert.rejects(reads.read(id, 0, 25_000, cancelled.signal), { code: 'WAIT_CANCELLED' });
  const second = reads.read(id, 0, 25_000);
  await assert.rejects(reads.read(id, 0, 25_000), /subscriber cap/v);
  cancelled.abort();
  await first;
  buffer.write(Buffer.from('safe output'.repeat(100)));
  reads.notify(id);
  assert.ok((await second).output.length > 0);
  const tail = (await reads.read(id, 0, 0)).nextCursor;
  const timed = await reads.read(id, tail, 1);
  assert.deepEqual(timed.output, []);
  const final = reads.read(id, tail, 25_000);
  ledger.change(id, 'requested', 'failed', { reason: 'fixture exit' });
  buffer.finish();
  reads.finish(id);
  assert.equal((await final).session.state, 'failed');
});
