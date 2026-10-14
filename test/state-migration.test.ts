/**
 * Rebranding preserves real Git worktrees, dirty edits, operational paths and
 * SQLite messages. No provider or GitHub request is made by these tests.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { z } from 'zod';

import { loadConfig, loadIdentity } from '../src/config.ts';
import { FactoryRepository } from '../src/factory/repository.ts';
import { Store } from '../src/store.ts';

import { createCleanup, createProject, registration } from './helpers.ts';

/**
 * Execute Git without a shell in a disposable test project.
 *
 * @param cwd - Fixture repository/worktree.
 * @param args - Explicit Git arguments.
 * @returns Trimmed command output.
 */
function git(cwd: string, args: string[]): string {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- Fixture-only Git executable, literal argument array and no shell.
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

await test('MALT migration repairs owned worktrees and preserves dirty edits, credentials, messages and artifact paths', (t) => {
  const config = createProject(createCleanup(t));
  const identity = loadIdentity(config, 'worker');
  const store = new Store(config);
  const lead = store.register(registration('lead'));
  const worker = store.register(registration('worker'));
  store.execute('send_message', { to: worker.id, body: 'Retain this message unchanged.' }, lead.id);
  const repository = new FactoryRepository(store);
  assert.deepEqual(repository.jobs(), []);
  const legacy = path.join(config.root, '.mlt');
  const artifact = path.join(legacy, 'factory', 'jobs', 'fixture');
  store.db
    .prepare('INSERT INTO factory_jobs VALUES(?,?,?,?)')
    .run('fixture', 'developer-1', 'succeeded', JSON.stringify({ artifact }));
  store.close();
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixture paths are confined to the disposable project created by this test.
  renameSync(config.directory, legacy);
  git(config.root, ['init', '--quiet']);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixture paths are confined to the disposable project created by this test.
  writeFileSync(path.join(config.root, 'source.txt'), 'initial');
  git(config.root, ['add', 'source.txt']);
  git(config.root, [
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '--quiet',
    '-m',
    'initial',
  ]);
  const oldWorktree = path.join(legacy, 'worktrees', 'fixture');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixture paths are confined to the disposable project created by this test.
  mkdirSync(path.dirname(oldWorktree), { recursive: true });
  git(config.root, ['worktree', 'add', '-b', 'owned-fixture', oldWorktree]);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixture paths are confined to the disposable project created by this test.
  writeFileSync(path.join(oldWorktree, 'source.txt'), 'preserve dirty edit');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixture paths are confined to the disposable project created by this test.
  symlinkSync(legacy, path.join(oldWorktree, '.mlt'), process.platform === 'win32' ? 'junction' : 'dir');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixture paths are confined to the disposable project created by this test.
  mkdirSync(artifact, { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixture paths are confined to the disposable project created by this test.
  writeFileSync(path.join(artifact, 'stdout.log'), 'Original log text .mlt is retained.');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixture paths are confined to the disposable project created by this test.
  writeFileSync(
    path.join(legacy, 'factory', 'worktrees.json'),
    JSON.stringify([{ id: 'fixture', directory: oldWorktree, branch: 'owned-fixture', removed: false }]),
  );
  const migrated = loadConfig(config.root);
  assert.equal(migrated.projectId, config.projectId);
  assert.equal(migrated.token, config.token);
  assert.deepEqual(loadIdentity(migrated, 'worker'), identity);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixture paths are confined to the disposable project created by this test.
  assert.equal(existsSync(legacy), false);
  const worktree = path.join(migrated.directory, 'worktrees', 'fixture');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixture paths are confined to the disposable project created by this test.
  assert.equal(readFileSync(path.join(worktree, 'source.txt'), 'utf8'), 'preserve dirty edit');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixture paths are confined to the disposable project created by this test.
  assert.equal(realpathSync(path.join(worktree, '.malt')), realpathSync(migrated.directory));
  assert.match(git(config.root, ['worktree', 'list', '--porcelain']), /\.malt/v);
  assert.equal(git(worktree, ['branch', '--show-current']), 'owned-fixture');
  assert.equal(
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixture paths are confined to the disposable project created by this test.
    readFileSync(path.join(migrated.directory, 'factory', 'jobs', 'fixture', 'stdout.log'), 'utf8'),
    'Original log text .mlt is retained.',
  );
  using database = new DatabaseSync(migrated.database);
  const row = z
    .object({ data: z.string() })
    .parse(database.prepare('SELECT data FROM factory_jobs WHERE id=?').get('fixture'));
  assert.equal(
    z.object({ artifact: z.string() }).parse(JSON.parse(row.data)).artifact,
    path.join(migrated.directory, 'factory', 'jobs', 'fixture'),
  );
  const resumed = new Store(migrated);
  assert.equal(resumed.execute('get_messages', {}, worker.id).messages[0]?.body, 'Retain this message unchanged.');
  resumed.close();
  assert.equal(loadConfig(config.root).token, config.token);
});

await test('MALT migration refuses conflicting stores and uncheckpointed journals without moving either store', (t) => {
  const config = createProject(createCleanup(t));
  const legacy = path.join(config.root, '.mlt');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixture paths are confined to the disposable project created by this test.
  renameSync(config.directory, legacy);
  const journal = path.join(legacy, 'state', 'mesh.db-wal');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixture paths are confined to the disposable project created by this test.
  writeFileSync(journal, 'unclean');
  assert.throws(() => loadConfig(config.root), /Stop the legacy broker/v);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixture paths are confined to the disposable project created by this test.
  assert.ok(existsSync(journal));
  rmSync(journal);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixture paths are confined to the disposable project created by this test.
  mkdirSync(config.directory);
  assert.throws(() => loadConfig(config.root), /Both .mlt and .malt/v);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixture paths are confined to the disposable project created by this test.
  assert.ok(existsSync(path.join(legacy, 'config.json')));
});
