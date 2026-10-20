/**
 * The worktree prune control on real temporary Git worktrees: a dry run
 * reports every worktree and snapshot with its owner and touches nothing;
 * removal keeps owned active work, archives a dirty or unreferenced orphan
 * to a ref first, unlinks the junctioned `.malt` without following it, never
 * deletes a branch, and runs `git worktree prune`.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { run } from '../src/database.ts';
import { pruneWorktrees, registrations } from '../src/factory/prune.ts';
import { FactoryRepository } from '../src/factory/repository.ts';
import { factoryConfigSchema, jobSchema } from '../src/factory/schema.ts';
import { MeshError } from '../src/protocol.ts';
import { Store } from '../src/store.ts';

import { fixture } from './delivery-fixture.ts';

import type { Fixture } from './delivery-fixture.ts';
import type { MeshConfig } from '../src/config.ts';
import type { PruneEntry, PruneResult } from '../src/factory/prune.ts';
import type { WorkspaceManager } from '../src/factory/workspaces.ts';
import type { TestContext } from 'node:test';

/** The worktrees of the scene. */
type Name = 'delivery' | 'running' | 'finished' | 'orphan' | 'loose' | 'stale' | 'live' | 'closed' | 'foreign';

/** A project with one worktree of every kind prune must tell apart. */
interface Scene {
  /** What prune needs. */
  readonly context: { mesh: MeshConfig; repository: FactoryRepository; workspaces: WorkspaceManager };
  /** Ledger ids. */
  readonly ids: Readonly<Record<Name, string>>;
  /** Their directories. */
  readonly directories: Readonly<Record<Name, string>>;
  /** A folder under `.malt/worktrees` that neither Git nor the ledger lists. */
  readonly stray: string;
  /** A worktree of another session, outside `.malt/worktrees`. */
  readonly outside: string;
  /** The detached commit no ref holds. */
  readonly loose: string;
  /** A file outside the project that the foreign `.malt` link points to. */
  readonly foreignFile: string;
}

/**
 * Write a file inside a fixture folder.
 *
 * @param directory - Fixture folder.
 * @param name - File name.
 * @param text - Contents.
 */
async function put(directory: string, name: string, text: string): Promise<void> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixture writes only inside its temporary folders.
  await writeFile(path.join(directory, name), text);
}

/**
 * Read a file inside a fixture folder.
 *
 * @param file - Fixture file.
 * @returns Its text.
 */
async function contents(file: string): Promise<string> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixture reads only inside its temporary folders.
  return readFile(file, 'utf8');
}

/**
 * Whether a fixture path exists.
 *
 * @param target - Fixture path.
 * @returns True when it exists.
 */
function isPresent(target: string): boolean {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixture paths only.
  return existsSync(target);
}

/**
 * A temporary folder outside the project, removed with the test.
 *
 * @param delivery - Owns cleanup.
 * @param prefix - Folder name prefix.
 * @returns The folder.
 */
function scratch(delivery: Fixture, prefix: string): string {
  const folder = mkdtempSync(path.join(tmpdir(), prefix));
  delivery.defer(() => {
    rmSync(folder, { recursive: true, force: true });
  });
  return folder;
}

/**
 * The project ledger with the fixture's active delivery and a running review attempt.
 *
 * @param delivery - Repository fixture.
 * @returns The ledger and the review attempt's id.
 */
function ledger(delivery: Fixture): { repository: FactoryRepository; review: string } {
  const store = new Store(delivery.mesh);
  delivery.defer(() => {
    store.close();
  });
  const repository = new FactoryRepository(store);
  repository.configure(
    factoryConfigSchema.parse({
      testCommands: [{ file: process.execPath, args: ['-e', ''] }],
      endToEndCommands: [{ file: process.execPath, args: ['-e', ''] }],
    }),
  );
  repository.addTask(delivery.task);
  const review = jobSchema.parse({ ...delivery.job, id: randomUUID(), kind: 'review', role: 'qa-1' });
  run(
    store.db,
    'INSERT INTO factory_jobs VALUES(?,?,?,?)',
    review.id,
    review.role,
    review.state,
    JSON.stringify(review),
  );
  return { repository, review: review.id };
}

/**
 * Create a scratch terminal's worktree and its session record.
 *
 * @param workspaces - Project Git.
 * @param repository - Project ledger.
 * @param id - Ledger id, `terminal-<session>`.
 * @param head - Base commit.
 * @returns Its directory.
 */
async function terminal(
  workspaces: WorkspaceManager,
  repository: FactoryRepository,
  id: string,
  head: string,
): Promise<string> {
  const session = id.slice('terminal-'.length);
  const branch = `malt/terminal/${session}`;
  const worktree = await workspaces.create(id, head, branch, false);
  repository.terminals.create({
    id: session,
    provider: 'claude',
    worktree,
    branch,
    base: head,
    baseBranch: 'main',
    columns: 80,
    rows: 24,
  });
  return worktree;
}

/**
 * Build the project: an active delivery with uncommitted work, a running attempt's snapshot, a finished
 * attempt's clean snapshot, a dirty orphan with a junctioned `.malt`, a snapshot with a commit no ref holds,
 * a worktree whose folder was deleted, a live and a cancelled terminal, a worktree whose `.malt` points
 * elsewhere, a stray folder and a worktree outside `.malt/worktrees`.
 *
 * @param t - Owns cleanup.
 * @returns Prune's context, every worktree's id and directory, and the evidence the tests check.
 */
async function scene(t: TestContext): Promise<Scene> {
  const delivery = await fixture(t);
  const { mesh, workspaces } = delivery;
  const { repository, review } = ledger(delivery);
  const head = await workspaces.git(['rev-parse', 'HEAD']);
  await put(delivery.directory, 'wip.txt', 'unpublished delivery work\n');
  await put(mesh.directory, 'sentinel.txt', 'project memory\n');
  const ids: Record<Name, string> = {
    delivery: path.basename(delivery.directory),
    running: `snapshot-${review}`,
    finished: `snapshot-${randomUUID()}`,
    orphan: 'orphan-dev-1',
    loose: `snapshot-${randomUUID()}`,
    stale: 'stale-dev-1',
    live: `terminal-${randomUUID()}`,
    closed: `terminal-${randomUUID()}`,
    foreign: 'foreign-dev-1',
  };
  const orphan = await workspaces.create(ids.orphan, head, 'malt/orphan-1');
  await put(orphan, 'orphan.txt', 'untracked orphan work\n');
  await put(orphan, 'shared.txt', 'changed by the orphan\n');
  const looseTree = await workspaces.create(ids.loose, head, null);
  await put(looseTree, 'loose.txt', 'committed on no branch\n');
  await workspaces.git(['add', 'loose.txt'], looseTree);
  await workspaces.git(['commit', '-m', 'Detached work'], looseTree);
  const stale = await workspaces.create(ids.stale, head, null, false);
  rmSync(stale, { recursive: true, force: true });
  const foreign = await workspaces.create(ids.foreign, head, null, false);
  const elsewhere = scratch(delivery, 'malt-prune-foreign-');
  await put(elsewhere, 'keep.txt', 'not this project\n');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixture link inside its temporary worktree.
  await symlink(elsewhere, path.join(foreign, '.malt'), process.platform === 'win32' ? 'junction' : 'dir');
  const directories: Record<Name, string> = {
    delivery: delivery.directory,
    running: await workspaces.create(ids.running, head, null),
    finished: await workspaces.create(ids.finished, head, null),
    orphan,
    loose: looseTree,
    stale,
    live: await terminal(workspaces, repository, ids.live, head),
    closed: await terminal(workspaces, repository, ids.closed, head),
    foreign,
  };
  repository.terminals.change(ids.closed.slice('terminal-'.length), 'requested', 'cancelled');
  const stray = path.join(mesh.directory, 'worktrees', 'stray');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixture folder inside its temporary project.
  mkdirSync(stray);
  await put(stray, 'notes.txt', 'someone else\n');
  const outside = path.join(scratch(delivery, 'malt-prune-outside-'), 'session');
  await workspaces.git(['worktree', 'add', '--detach', outside, head]);
  return {
    context: { mesh, repository, workspaces },
    ids,
    directories,
    stray,
    outside,
    loose: await workspaces.git(['rev-parse', 'HEAD'], looseTree),
    foreignFile: path.join(elsewhere, 'keep.txt'),
  };
}

/**
 * Find one entry by id.
 *
 * @param result - Prune report.
 * @param id - Ledger id, folder name or path.
 * @returns The reported decision for it.
 */
function entry(result: PruneResult, id: string): PruneEntry {
  const found = result.entries.find((item) => item.id === id);
  assert.ok(found !== undefined, `prune reports ${id}`);
  return found;
}

/**
 * Comparable form of a path on any host.
 *
 * @param directory - Fixture or Git path.
 * @returns Resolved, lower-cased path.
 */
function same(directory: string): string {
  return path.resolve(directory).toLowerCase();
}

/**
 * Directories Git registers as worktrees.
 *
 * @param workspaces - Project Git.
 * @returns Their comparable paths.
 */
async function registered(workspaces: WorkspaceManager): Promise<string[]> {
  const output = await workspaces.git(['worktree', 'list', '--porcelain', '-z']);
  return registrations(output).map((item) => same(item.directory));
}

await test('a dry run reports every worktree and snapshot with its owner and why, and changes nothing', async (t) => {
  const { context, ids, directories, stray, outside } = await scene(t);
  const before = await registered(context.workspaces);
  const recorded = context.workspaces.owned();
  const result = await pruneWorktrees(context, {});
  assert.equal(result.applied, false);

  const active = entry(result, ids.delivery);
  assert.equal(active.kind, 'delivery');
  assert.equal(active.owner, 'delivery #4 (development)');
  assert.equal(active.action, 'keep', 'an active delivery is kept, uncommitted work and all');
  assert.match(active.reason, /In use by delivery #4/v);

  const running = entry(result, ids.running);
  assert.equal(running.kind, 'snapshot');
  assert.equal(running.action, 'keep');
  assert.match(running.owner ?? '', /^attempt .+ \(review, running\) for delivery #4$/v);

  const finished = entry(result, ids.finished);
  assert.equal(finished.action, 'remove');
  assert.match(finished.owner ?? '', /\(not running\)$/v);
  assert.match(finished.reason, /no uncommitted changes/v);

  const orphan = entry(result, ids.orphan);
  assert.equal(orphan.owner, null);
  assert.equal(orphan.action, 'archive');
  assert.equal(orphan.archive, 'refs/malt/archive/prune/orphan-dev-1');
  assert.match(orphan.reason, /uncommitted changes go to refs\/malt\/archive\/prune\/orphan-dev-1 first/v);

  assert.equal(entry(result, ids.loose).action, 'archive');
  assert.match(entry(result, ids.loose).reason, /no ref holds commit/v);
  assert.equal(entry(result, ids.stale).action, 'prune');
  assert.match(entry(result, ids.stale).reason, /prunable/v);

  const live = entry(result, ids.live);
  assert.equal(live.kind, 'terminal');
  assert.equal(live.action, 'keep');
  assert.match(live.reason, /In use by terminal .+ \(requested\)/v);
  assert.equal(entry(result, ids.closed).action, 'remove');
  assert.match(entry(result, ids.closed).owner ?? '', /\(cancelled\)$/v);

  assert.equal(entry(result, ids.foreign).action, 'keep');
  assert.match(entry(result, ids.foreign).reason, /Its .malt is not a link to this project's memory/v);

  const folder = entry(result, path.basename(stray));
  assert.equal(folder.kind, 'unowned');
  assert.equal(folder.action, 'keep');
  assert.match(folder.reason, /Neither Git nor the ownership ledger/v);

  const session = result.entries.find((item) => same(item.directory) === same(outside));
  assert.equal(session?.action, 'keep');
  assert.match(session.reason, /Outside .malt\/worktrees/v);
  assert.equal(result.entries.find((item) => item.reason === 'The primary checkout.')?.action, 'keep');

  assert.deepEqual(await registered(context.workspaces), before, 'a dry run registers and prunes nothing');
  assert.deepEqual(context.workspaces.owned(), recorded, 'a dry run leaves the ledger alone');
  for (const name of ['delivery', 'running', 'finished', 'orphan', 'loose', 'live', 'closed', 'foreign'] as const) {
    assert.ok(isPresent(directories[name]), `${name} still exists`);
  }
});

await test('removal keeps owned work, archives orphans first, unlinks .malt without following it and prunes Git', async (t) => {
  const { context, ids, directories, stray, outside, loose, foreignFile } = await scene(t);
  const git = async (...args: string[]): Promise<string> => context.workspaces.git(args);

  context.repository.setActive(true);
  await assert.rejects(
    pruneWorktrees(context, { apply: true }),
    (error: unknown) =>
      error instanceof MeshError && error.code === 'FACTORY_GATED' && error.message.includes('Pause the factory'),
  );
  assert.ok(isPresent(directories.finished), 'a refused removal touches nothing');
  context.repository.setActive(false);

  const result = await pruneWorktrees(context, { apply: true });
  assert.equal(result.applied, true);

  // Owned active work stays exactly as it was.
  assert.equal(entry(result, ids.delivery).action, 'keep');
  assert.equal(await contents(path.join(directories.delivery, 'wip.txt')), 'unpublished delivery work\n');
  assert.equal(entry(result, ids.running).action, 'keep');
  assert.ok(isPresent(directories.running));
  assert.equal(entry(result, ids.live).action, 'keep');
  assert.ok(isPresent(directories.live));

  // A clean orphan and a cancelled terminal are removed; the terminal's branch is not.
  assert.equal(entry(result, ids.finished).action, 'removed');
  assert.ok(!isPresent(directories.finished));
  assert.equal(entry(result, ids.closed).action, 'removed');
  assert.ok(!isPresent(directories.closed));
  const branch = `refs/heads/malt/terminal/${ids.closed.slice('terminal-'.length)}`;
  assert.notEqual(await git('for-each-ref', '--format=%(refname)', branch), '', 'branches are never deleted');

  // The dirty orphan's work is archived before its junctioned .malt is unlinked and the folder removed.
  const archive = 'refs/malt/archive/prune/orphan-dev-1';
  assert.equal(entry(result, ids.orphan).action, 'archived');
  assert.ok(!isPresent(directories.orphan));
  assert.equal(await git('show', `${archive}:orphan.txt`), 'untracked orphan work');
  assert.equal(await git('show', `${archive}:shared.txt`), 'changed by the orphan');
  assert.notEqual(await git('for-each-ref', '--format=%(refname)', 'refs/heads/malt/orphan-1'), '');
  assert.equal(
    await contents(path.join(context.mesh.directory, 'sentinel.txt')),
    'project memory\n',
    'the shared project memory behind the junction survives',
  );

  // A detached commit no ref held is archived as it is.
  assert.equal(entry(result, ids.loose).action, 'archived');
  assert.equal(await git('rev-parse', `refs/malt/archive/prune/${ids.loose}`), loose);

  // A .malt link to anything but this project's memory is never followed or removed.
  assert.equal(entry(result, ids.foreign).action, 'keep');
  assert.ok(isPresent(directories.foreign));
  assert.equal(await contents(foreignFile), 'not this project\n');

  // Git worktree prune dropped the registration whose folder was gone, and the ledger retired it.
  assert.equal(entry(result, ids.stale).action, 'pruned');
  assert.ok(!(await registered(context.workspaces)).includes(same(directories.stale)));
  const owned = new Set(context.workspaces.owned().map((record) => record.id));
  assert.ok(!owned.has(ids.stale) && !owned.has(ids.orphan) && !owned.has(ids.finished) && owned.has(ids.foreign));

  // Folders MALT did not create are left alone.
  assert.ok(isPresent(path.join(stray, 'notes.txt')));
  assert.ok(isPresent(outside));

  // A second dry run finds nothing more to remove.
  const again = await pruneWorktrees(context, {});
  assert.deepEqual(
    again.entries.filter((item) => item.action !== 'keep').map((item) => item.id),
    [],
  );
});

await test('removal is refused while another environment owns .malt/worktrees; the dry run still reports', async (t) => {
  const { context, ids, directories } = await scene(t);
  const owner = { root: '/data', platform: 'linux', isContainer: true, recordedAt: 1, handovers: [] };
  await put(path.join(context.mesh.directory, 'worktrees'), 'owner.json', JSON.stringify(owner));
  await assert.rejects(
    pruneWorktrees(context, { apply: true }),
    (error: unknown) =>
      error instanceof MeshError && error.code === 'FACTORY_GATED' && error.message.includes('/data (linux)'),
  );
  assert.ok(isPresent(directories.finished));
  assert.equal(entry(await pruneWorktrees(context, {}), ids.finished).action, 'remove');
});

await test('Git porcelain parsing keeps locked and prunable reasons, including paths with spaces', () => {
  const output = [
    'worktree /repo',
    'HEAD 1111111111111111111111111111111111111111',
    'branch refs/heads/main',
    '',
    'worktree /repo/.malt/worktrees/a b',
    'HEAD 2222222222222222222222222222222222222222',
    'detached',
    'locked held by the operator',
    '',
    'worktree /gone',
    'HEAD 3333333333333333333333333333333333333333',
    'branch refs/heads/x',
    'locked',
    'prunable gitdir file points to non-existent location',
    '',
  ].join('\0');
  assert.deepEqual(registrations(output), [
    { directory: '/repo', isDetached: false, locked: null, prunable: null },
    { directory: '/repo/.malt/worktrees/a b', isDetached: true, locked: 'held by the operator', prunable: null },
    { directory: '/gone', isDetached: false, locked: '', prunable: 'gitdir file points to non-existent location' },
  ]);
});
