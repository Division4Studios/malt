/** @file `.malt` backups snapshot live databases, skip worktrees, and restore only with the broker stopped. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { promisify } from 'node:util';

import { BACKUP_MANIFEST, backupProject, restoreProject } from '../src/backup.ts';
import { startBroker } from '../src/broker.ts';
import { STATE_DIRECTORY_NAME } from '../src/config.ts';
import { Store } from '../src/store.ts';

import { CLI_PATH, brokerUrl, createCleanup, createProject, registration, updateConfig } from './helpers.ts';

import type { Defer } from './helpers.ts';

/** Run a child process without a shell. */
const run = promisify(execFile);
/** SQLite write-ahead side files. */
const SIDE_FILE = /-(?:shm|wal)$/v;

/**
 * A new, empty folder removed after the test.
 *
 * @param defer - Cleanup registration.
 * @returns Folder path.
 */
function scratch(defer: Defer): string {
  const folder = mkdtempSync(path.join(tmpdir(), 'malt-backup-'));
  defer(() => {
    rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return folder;
}

/**
 * Write one fixture file, creating its folder.
 *
 * @param root - Folder the file belongs under.
 * @param parts - Path segments of the file below `root`.
 */
function fixture(root: string, ...parts: string[]): void {
  const file = path.join(root, ...parts);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixture files under this test's own temporary project.
  mkdirSync(path.dirname(file), { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixture files under this test's own temporary project.
  writeFileSync(file, `${parts.join('/')}\n`);
}

/**
 * Whether a path exists below a folder.
 *
 * @param root - Folder.
 * @param parts - Path segments below it.
 * @returns True when it exists.
 */
function hasPath(root: string, ...parts: string[]): boolean {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Paths under this test's own temporary folders.
  return existsSync(path.join(root, ...parts));
}

/**
 * Names of the agents registered in one database file.
 *
 * @param database - SQLite file.
 * @returns Agent names in order.
 */
function agentNames(database: string): string[] {
  using db = new DatabaseSync(database, { readOnly: true });
  return db
    .prepare('SELECT name FROM agents ORDER BY name')
    .all()
    .map((row) => String(row['name']));
}

await test('a backup snapshots the live database, copies files, skips worktrees and restores with .malt moved aside', async (t) => {
  const defer = createCleanup(t);
  const config = createProject(defer);
  const store = new Store(config);
  store.register(registration('codex-1'));
  fixture(config.directory, 'factory', 'jobs', 'artifact.json');
  fixture(config.directory, 'worktrees', 'delivery', 'file.txt');
  fixture(config.directory, 'cache', 'blob');
  const folder = path.join(scratch(defer), 'before-upgrade');
  // Taken while the store is open, as it would be under a running broker.
  const manifest = await backupProject(config, folder, 1000);
  store.register(registration('claude-1'));
  store.close();
  const copied = path.join(folder, STATE_DIRECTORY_NAME);
  assert.deepEqual(manifest.databases, ['state/mesh.db']);
  assert.ok(hasPath(copied, 'factory', 'jobs', 'artifact.json'));
  assert.equal(hasPath(copied, 'worktrees'), false, 'owned worktrees stay out of backups');
  assert.equal(hasPath(copied, 'cache'), false);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- This test's own backup folder.
  assert.ok(readdirSync(path.join(copied, 'state')).every((name) => !SIDE_FILE.test(name)));
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- This test's own backup folder.
  const recorded: unknown = JSON.parse(readFileSync(path.join(folder, BACKUP_MANIFEST), 'utf8'));
  assert.deepEqual(recorded, manifest);
  assert.deepEqual(agentNames(config.database), ['claude-1', 'codex-1']);

  await assert.rejects(backupProject(config, folder), { code: 'INVALID_INPUT' }, 'a backup never overwrites another');
  await assert.rejects(
    backupProject(config, path.join(config.directory, 'backups', 'inside')),
    { code: 'INVALID_INPUT' },
    'a backup never lands inside the folder it copies',
  );
  fixture(config.directory, 'old-backup', 'malt-backup.json');
  fixture(config.directory, 'old-backup', '.malt', 'config.json');
  await assert.rejects(
    restoreProject(config.root, path.join(config.directory, 'old-backup'), { isRunning: false, now: 2000 }),
    /outside/v,
    'a restore source inside .malt is refused before anything moves',
  );
  assert.ok(hasPath(config.directory, 'state', 'mesh.db'), 'the refused restore left .malt in place');
  await assert.rejects(restoreProject(config.root, folder, { isRunning: true, now: 2000 }), { code: 'FACTORY_GATED' });
  await assert.rejects(restoreProject(config.root, config.root, { isRunning: false, now: 2000 }), {
    code: 'INVALID_INPUT',
  });

  const previous = await restoreProject(config.root, folder, { isRunning: false, now: Date.UTC(2026, 9, 17, 1, 2, 3) });
  assert.equal(previous, `${config.directory}.before-restore-2026-10-17T01-02-03-000Z`);
  assert.deepEqual(agentNames(config.database), ['codex-1'], 'the restored database is the snapshot');
  assert.deepEqual(agentNames(path.join(previous, 'state', 'mesh.db')), ['claude-1', 'codex-1']);
  assert.ok(hasPath(previous, 'worktrees', 'delivery', 'file.txt'), 'the moved-aside .malt is intact');
});

await test('the CLI backs up through --dir and refuses to restore while the broker answers', async (t) => {
  const defer = createCleanup(t);
  const created = createProject(defer);
  const broker = await startBroker(created, { port: 0 });
  defer(async () => broker.close());
  const config = updateConfig(created, { url: brokerUrl(broker.port) });
  const folder = path.join(scratch(defer), 'snapshot');
  const backup = await run(process.execPath, [CLI_PATH, 'backup', '--project', config.root, '--dir', folder]);
  assert.match(backup.stdout, /"state\/mesh\.db"/v);
  await assert.rejects(
    run(process.execPath, [CLI_PATH, 'restore', '--project', config.root, '--dir', folder]),
    (error: unknown) => Error.isError(error) && 'stderr' in error && String(error.stderr).includes('FACTORY_GATED'),
  );
  await assert.rejects(run(process.execPath, [CLI_PATH, 'backup', '--project', config.root]), /needs --dir/v);
});
