/**
 * A delivery's source diff through the broker and the paired console: every
 * change kind against real Git, bounded patches, refused paths, private paths
 * and operator-or-lead authority.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { startBroker } from '../src/broker.ts';
import { AgentClient, rpc } from '../src/client.ts';
import { command } from '../src/factory/commands.ts';
import { numstatEntry } from '../src/factory/delivery-diff.ts';
import { PATCH_BYTES_MAX, PATCH_LINES_MAX, diffPatchSchema, diffSummarySchema } from '../src/factory/diff-schema.ts';
import { FactoryRepository } from '../src/factory/repository.ts';
import { factoryConfigSchema, taskSchema } from '../src/factory/schema.ts';
import { startWebConsole } from '../src/web/server.ts';

import { brokerUrl, createCleanup, createProject } from './helpers.ts';

import type { MeshConfig } from '../src/config.ts';
import type { DiffFileSummary } from '../src/factory/diff-schema.ts';
import type { TestContext } from 'node:test';

/** Lines in the rename source, enough for Git to detect the rename. */
const RENAME_LINES = 40;
/** Line length of the file whose patch exceeds the byte cap. */
const WIDE_LINE = 600;

/**
 * Write a file inside the fixture repository.
 *
 * @param root - Repository root.
 * @param name - Relative path.
 * @param content - File content.
 */
function put(root: string, name: string, content: string | Buffer): void {
  const file = path.join(root, name);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixture writes only inside its temporary project.
  mkdirSync(path.dirname(file), { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixture writes only inside its temporary project.
  writeFileSync(file, content);
}

/**
 * Commit a base and a head that change files in every way the summary reports.
 *
 * @param root - Repository root.
 * @returns Base and head commits.
 */
async function history(root: string): Promise<{ base: string; head: string }> {
  const git = async (...args: string[]): Promise<string> => command('git', args, root);
  await git('init', '--initial-branch=main');
  await git('config', 'user.name', 'Diff fixture');
  await git('config', 'user.email', 'diff@example.invalid');
  await git('config', 'core.autocrlf', 'false');
  const lines = Array.from({ length: RENAME_LINES }, (_, index) => `line ${String(index)}`).join('\n');
  put(root, 'keep.txt', 'one\ntwo\nthree\n');
  put(root, 'remove.txt', 'gone soon\n');
  put(root, 'rename-me.txt', `${lines}\n`);
  put(root, 'bin.dat', Buffer.from([0, 1, 2, 3, 0, 255]));
  put(root, 'tool.sh', 'echo tool\n');
  put(root, '.env.local', 'TOKEN=old\n');
  await git('add', '-A');
  await git('commit', '-m', 'Base');
  const base = await git('rev-parse', 'HEAD');
  put(root, 'keep.txt', 'one\nTWO\nthree\nfour\n');
  rmSync(path.join(root, 'remove.txt'));
  rmSync(path.join(root, 'rename-me.txt'));
  put(root, 'renamed.txt', `${lines}\n`);
  // The renamed-away path becomes a directory holding a private file.
  put(root, 'rename-me.txt/.env', 'TOKEN=hidden\n');
  put(root, 'bin.dat', Buffer.from([0, 9, 9, 9, 0, 255]));
  put(root, 'café.txt', 'accent\n');
  put(root, 'wide.txt', `${Array.from({ length: 1000 }, () => 'x'.repeat(WIDE_LINE)).join('\n')}\n`);
  put(root, 'huge.txt', `${Array.from({ length: PATCH_LINES_MAX + 1 }, (_, index) => String(index)).join('\n')}\n`);
  put(root, '.env.local', 'TOKEN=new\n');
  await git('add', '-A');
  await git('update-index', '--chmod=+x', 'tool.sh');
  await git('commit', '-m', 'Head');
  return { base, head: await git('rev-parse', 'HEAD') };
}

/**
 * Start a broker over a fixture repository with one published delivery.
 *
 * @param t - Owns cleanup.
 * @returns Connected configuration, the delivery and its commits.
 */
async function fixture(t: TestContext): Promise<{
  connected: MeshConfig;
  taskId: string;
  base: string;
  head: string;
  repository: FactoryRepository;
  webUrl: string;
  pairingCode: string;
}> {
  const defer = createCleanup(t);
  const config = createProject(defer);
  const { base, head } = await history(config.root);
  const broker = await startBroker(config, { port: 0 });
  defer(async () => broker.close());
  const connected = { ...config, url: brokerUrl(broker.port) };
  const repository = new FactoryRepository(broker.store);
  const check = { file: process.execPath, args: ['-e', ''] };
  repository.configure(factoryConfigSchema.parse({ testCommands: [check], endToEndCommands: [check] }));
  const task = taskSchema.parse({
    id: randomUUID(),
    featureId: null,
    issue: 7,
    parentIssue: 1,
    key: 'diff',
    title: 'Diffable change',
    description: 'One observable outcome.',
    acceptanceCriteria: ['Observable behavior passes.'],
    dependencies: [],
    phase: 'review',
    developer: 'developer-1',
    branch: 'malt/diff',
    worktree: null,
    head,
    base,
    pr: null,
    prUrl: null,
    merge: null,
    reviews: [],
    feedback: [],
    attempts: 1,
    version: 0,
    error: null,
    updatedAt: Date.now(),
  });
  repository.addTask(task);
  const web = await startWebConsole(connected, 0);
  defer(async () => web.close());
  return { connected, taskId: task.id, base, head, repository, webUrl: web.url, pairingCode: web.pairingCode };
}

/**
 * Find a listed file.
 *
 * @param files - Summary files.
 * @param name - Path.
 * @returns The file.
 */
function listed(files: readonly DiffFileSummary[], name: string): DiffFileSummary {
  const file = files.find((candidate) => candidate.path === name);
  assert.ok(file !== undefined, `${name} is listed`);
  return file;
}

await test('the summary reports every change kind and hides private paths', async (t) => {
  const { connected, taskId, base, head } = await fixture(t);
  const summary = diffSummarySchema.parse(await rpc(connected, 'factory_delivery_diff', { taskId }));
  assert.ok(summary.state === 'ready');
  assert.equal(summary.base, base);
  assert.equal(summary.head, head);
  assert.deepEqual(
    new Set(summary.files.map((file) => file.path)),
    new Set(['bin.dat', 'café.txt', 'huge.txt', 'keep.txt', 'remove.txt', 'renamed.txt', 'tool.sh', 'wide.txt']),
  );
  assert.equal(summary.privateChanges, 2);
  assert.equal(summary.isTruncated, false);
  const keep = listed(summary.files, 'keep.txt');
  assert.deepEqual([keep.status, keep.additions, keep.deletions, keep.isBinary], ['modified', 2, 1, false]);
  assert.equal(listed(summary.files, 'remove.txt').status, 'deleted');
  assert.equal(listed(summary.files, 'remove.txt').headMode, '000000');
  const renamed = listed(summary.files, 'renamed.txt');
  assert.equal(renamed.status, 'renamed');
  assert.equal(renamed.oldPath, 'rename-me.txt');
  assert.equal(renamed.similarity, 100);
  const binary = listed(summary.files, 'bin.dat');
  assert.equal(binary.isBinary, true);
  assert.equal(binary.additions, null);
  const tool = listed(summary.files, 'tool.sh');
  assert.equal(tool.baseMode, '100644');
  assert.equal(tool.headMode, '100755');
  assert.equal(listed(summary.files, 'café.txt').status, 'added');
  assert.equal(summary.totals.files, summary.files.length);
});

await test('patches are generated per listed path, bounded and refused for anything else', async (t) => {
  const { connected, taskId } = await fixture(t);
  const read = async (file: string): Promise<ReturnType<typeof diffPatchSchema.parse>> =>
    diffPatchSchema.parse(await rpc(connected, 'factory_delivery_diff', { taskId, path: file }));
  const keep = await read('keep.txt');
  assert.ok(keep.state === 'ready');
  assert.match(keep.patch, /^diff --git a\/keep\.txt b\/keep\.txt$/mv);
  assert.match(keep.patch, /^\+TWO$/mv);
  assert.equal(keep.isTruncated, false);
  const renamed = await read('renamed.txt');
  assert.ok(renamed.state === 'ready');
  assert.match(renamed.patch, /^rename from rename-me\.txt$/mv);
  assert.doesNotMatch(renamed.patch, /hidden|\.env/v, 'a directory under the old path is not part of the pair');
  const accent = await read('café.txt');
  assert.ok(accent.state === 'ready');
  assert.match(accent.patch, /^\+accent$/mv);
  const binary = await read('bin.dat');
  assert.ok(binary.state === 'ready');
  assert.match(binary.patch, /Binary files/v);
  const wide = await read('wide.txt');
  assert.ok(wide.state === 'ready');
  assert.equal(wide.isTruncated, true);
  assert.ok(wide.patch.length <= PATCH_BYTES_MAX);
  assert.ok(wide.patch.endsWith('\n'), 'cut at a line boundary');
  assert.ok((wide.bytes ?? 0) > PATCH_BYTES_MAX);
  const huge = await read('huge.txt');
  assert.ok(huge.state === 'ready');
  assert.deepEqual(
    { patch: huge.patch, isTruncated: huge.isTruncated, bytes: huge.bytes },
    {
      patch: '',
      isTruncated: true,
      bytes: null,
    },
  );
  for (const refused of ['.env.local', 'missing.txt', '../keep.txt', 'rename-me.txt', '*.txt']) {
    const result = await read(refused);
    assert.equal(result.state, 'unavailable', `${refused} is refused`);
  }
  await assert.rejects(rpc(connected, 'factory_delivery_diff', { taskId, path: 'x'.repeat(5000) }), {
    code: 'INVALID_INPUT',
  });
});

await test('unpublished deliveries explain why, and only the operator or lead may read diffs', async (t) => {
  const { connected, taskId, repository, webUrl, pairingCode } = await fixture(t);
  const task = repository.task(taskId);
  const draft = taskSchema.parse({ ...task, id: randomUUID(), issue: 8, key: 'draft', head: null, base: null });
  repository.addTask(draft);
  const unpublished = diffSummarySchema.parse(await rpc(connected, 'factory_delivery_diff', { taskId: draft.id }));
  assert.deepEqual(unpublished, {
    taskId: draft.id,
    state: 'unavailable',
    reason: 'This delivery has no published source yet.',
  });
  const missing = taskSchema.parse({ ...task, id: randomUUID(), issue: 9, key: 'missing', head: 'f'.repeat(40) });
  repository.addTask(missing);
  const absent = diffSummarySchema.parse(await rpc(connected, 'factory_delivery_diff', { taskId: missing.id }));
  assert.equal(absent.state, 'unavailable');
  const worker = new AgentClient(connected, { name: 'worker', role: 'worker' });
  await worker.connect();
  t.after(async () => worker.close());
  await assert.rejects(worker.call('factory_delivery_diff', { taskId }), { code: 'NOT_ORCHESTRATOR' });

  const paired = await fetch(`${webUrl}/api/pair`, {
    method: 'POST',
    headers: { Origin: webUrl, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: pairingCode }),
  });
  assert.equal(paired.status, 200);
  const headers = {
    Origin: webUrl,
    Cookie: (paired.headers.get('set-cookie') ?? '').split(';', 1)[0] ?? '',
    Connection: 'close',
  };
  const route = `${webUrl}/api/delivery-diff?project=home&taskId=${taskId}`;
  const summary = diffSummarySchema.parse(await (await fetch(route, { headers })).json());
  assert.equal(summary.state, 'ready');
  const patch = diffPatchSchema.parse(
    await (await fetch(`${route}&path=${encodeURIComponent('keep.txt')}`, { headers })).json(),
  );
  assert.equal(patch.state, 'ready');
  const repeated = await fetch(`${route}&taskId=${taskId}`, { headers });
  assert.equal(repeated.status, 400);
  const unknown = await fetch(`${route}&extra=1`, { headers });
  assert.equal(unknown.status, 400);
});

await test('numstat paths keep leading tabs; an empty path marks a rename', () => {
  assert.deepEqual(numstatEntry('1\t2\t\tfirst'), { added: '1', deleted: '2', path: '\tfirst' });
  assert.deepEqual(numstatEntry('3\t0\tsrc/a\tb.ts'), { added: '3', deleted: '0', path: 'src/a\tb.ts' });
  assert.deepEqual(numstatEntry('-\t-\t'), { added: '-', deleted: '-', path: '' });
});
