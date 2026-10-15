/** @file Real local Git/worktree fixture shared by terminal lifecycle and loopback verification. */
import path from 'node:path';

import { FactoryRepository } from '../src/factory/repository.ts';
import { factoryConfigSchema } from '../src/factory/schema.ts';
import { WorkspaceManager } from '../src/factory/workspaces.ts';
import { Store } from '../src/store.ts';

import { createCleanup, createProject } from './helpers.ts';

import type { Defer } from './helpers.ts';
import type { MeshConfig } from '../src/config.ts';
import type { FactoryConfig } from '../src/factory/schema.ts';
import type { TestContext } from 'node:test';

/**
 * Create a local repository and bare remote without GitHub or inference.
 *
 * @param t - Test cleanup owner.
 * @returns Actual Git, project ledger and teardown registration.
 */
export async function terminalProject(t: TestContext): Promise<{
  mesh: MeshConfig;
  settings: FactoryConfig;
  workspaces: WorkspaceManager;
  repository: FactoryRepository;
  store: Store;
  defer: Defer;
}> {
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
  return { mesh, settings, workspaces, repository, store, defer };
}
