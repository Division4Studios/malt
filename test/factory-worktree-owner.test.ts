/**
 * One execution environment owns `.malt/worktrees`: the first supervisor
 * records itself, another environment or a ledger of foreign worktrees refuses
 * dispatch, and an explicit handover records the previous owner.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { adoptWorktrees, currentEnvironment, readOwner, worktreeOwnerBlocker } from '../src/factory/worktree-owner.ts';
import { MeshError } from '../src/protocol.ts';

import { createCleanup, createProject } from './helpers.ts';

import type { MeshConfig } from '../src/config.ts';

/**
 * Record another environment as the owner, as a Docker supervisor would.
 *
 * @param mesh - Project configuration.
 */
function ownedByContainer(mesh: MeshConfig): void {
  const directory = path.join(mesh.directory, 'worktrees');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- The fixture's own temporary project.
  mkdirSync(directory, { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- The fixture's own temporary project.
  writeFileSync(
    path.join(directory, 'owner.json'),
    JSON.stringify({ root: '/data', platform: 'linux', isContainer: true, recordedAt: 1, handovers: [] }),
  );
}

await test('the first supervisor owns the worktrees and keeps owning them across restarts', (t) => {
  const mesh = createProject(createCleanup(t));
  assert.equal(worktreeOwnerBlocker(mesh, 10), null);
  assert.deepEqual(readOwner(mesh), { ...currentEnvironment(mesh), recordedAt: 10, handovers: [] });
  assert.equal(worktreeOwnerBlocker(mesh, 20), null);
  assert.equal(readOwner(mesh)?.recordedAt, 10, 'the same environment does not rewrite the record');
});

await test('another environment refuses dispatch until the operator hands ownership over', (t) => {
  const mesh = createProject(createCleanup(t));
  ownedByContainer(mesh);
  assert.match(
    worktreeOwnerBlocker(mesh, 10) ?? '',
    /belongs to the Docker container \(linux\) at \/data, but this supervisor runs in the .*factory-worktrees-adopt/v,
  );
  const adopted = adoptWorktrees(mesh, 30);
  assert.equal(adopted.root, currentEnvironment(mesh).root);
  assert.deepEqual(adopted.handovers, [{ root: '/data', platform: 'linux', isContainer: true, until: 30 }]);
  assert.equal(worktreeOwnerBlocker(mesh, 40), null);
  assert.throws(
    () => adoptWorktrees(mesh, 50),
    (error: unknown) => error instanceof MeshError && error.code === 'INVALID_INPUT',
  );
});

await test('worktrees registered under another path root block a first supervisor', (t) => {
  const mesh = createProject(createCleanup(t));
  const ledger = path.join(mesh.directory, 'factory', 'worktrees.json');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- The fixture's own temporary project.
  mkdirSync(path.dirname(ledger), { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- The fixture's own temporary project.
  writeFileSync(
    ledger,
    JSON.stringify([{ id: 'a', directory: '/data/.malt/worktrees/a', branch: null, removed: false }]),
  );
  assert.match(
    worktreeOwnerBlocker(mesh, 10) ?? '',
    /another environment \(it registered \/data\/\.malt\/worktrees\/a\)/v,
  );
  assert.equal(readOwner(mesh), null, 'no owner is recorded while worktrees are mixed');
  adoptWorktrees(mesh, 20);
  assert.equal(worktreeOwnerBlocker(mesh, 30), null);
});
