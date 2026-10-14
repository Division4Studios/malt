/**
 * Factory publication refuses private state even when Git ignore rules were bypassed.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { factoryConfigSchema } from '../src/factory/schema.ts';
import { WorkspaceManager } from '../src/factory/workspaces.ts';

import { createCleanup, createProject } from './helpers.ts';

await test('tracked or force-staged project memory blocks dispatch before any publication', async (t) => {
  const mesh = createProject(createCleanup(t));
  const settings = factoryConfigSchema.parse({
    testCommands: [{ file: process.execPath }],
    endToEndCommands: [{ file: process.execPath }],
  });
  const workspaces = new WorkspaceManager(mesh, settings);
  await workspaces.git(['init', '--initial-branch=main']);
  await workspaces.git(['remote', 'add', 'origin', 'https://github.com/fixture/app.git']);
  const file = path.join(mesh.directory, 'fixture-private.txt');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- A deliberately fake private artifact is created only in this disposable fixture.
  await writeFile(file, 'Not a real credential.\n');
  await workspaces.assertPrivateStateUntracked();
  await workspaces.git(['add', '--force', '--', '.malt/fixture-private.txt']);
  await assert.rejects(workspaces.assertPrivateStateUntracked(), /Git is tracking .malt/v);
  await assert.rejects(workspaces.origin(), /Git is tracking .malt/v);
  await workspaces.git(['rm', '--cached', '--', '.malt/fixture-private.txt']);
  await workspaces.assertPrivateStateUntracked();
});
