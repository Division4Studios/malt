/**
 * A delivery and its developer's owned worktree on a temporary local
 * repository with a bare origin, for tests of the supervisor's Git work.
 *
 * @file
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { factoryConfigSchema, jobSchema, taskSchema } from '../src/factory/schema.ts';
import { WorkspaceManager } from '../src/factory/workspaces.ts';

import { createCleanup, createProject } from './helpers.ts';

import type { MeshConfig } from '../src/config.ts';
import type { FactoryJob, FactoryTask } from '../src/factory/schema.ts';
import type { TestContext } from 'node:test';

/** A delivery worktree on a local repository with a bare origin. */
export interface Fixture {
  readonly mesh: MeshConfig;
  readonly workspaces: WorkspaceManager;
  readonly task: FactoryTask;
  readonly job: FactoryJob;
  readonly directory: string;
  /** Registers cleanup that runs before the project folder is removed. */
  readonly defer: (cleanup: () => unknown) => void;
}

/**
 * Build a repository, its origin, a delivery and the developer's owned worktree.
 *
 * @param t - Owns cleanup.
 * @returns Repository services, the delivery, its attempt and its worktree.
 */
export async function fixture(t: TestContext): Promise<Fixture> {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  const settings = factoryConfigSchema.parse({
    testCommands: [{ file: process.execPath, args: ['-e', ''] }],
    endToEndCommands: [{ file: process.execPath, args: ['-e', ''] }],
  });
  const workspaces = new WorkspaceManager(mesh, settings);
  await workspaces.git(['init', '--initial-branch=main']);
  await workspaces.git(['config', 'user.name', 'Diagnostics fixture']);
  await workspaces.git(['config', 'user.email', 'diagnostics@example.invalid']);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixture writes only inside its temporary project.
  await writeFile(path.join(mesh.root, 'shared.txt'), 'original\n');
  await workspaces.git(['add', '.']);
  await workspaces.git(['commit', '-m', 'Fixture baseline']);
  const origin = path.join(mesh.directory, 'origin.git');
  await workspaces.git(['init', '--bare', origin]);
  await workspaces.git(['remote', 'add', 'origin', origin]);
  await workspaces.git(['push', '-u', 'origin', 'main']);
  const head = await workspaces.base();
  const draft = taskSchema.parse({
    id: randomUUID(),
    featureId: null,
    issue: 4,
    parentIssue: 1,
    key: 'diagnostics',
    title: 'Diagnosable change',
    description: 'One observable outcome.',
    acceptanceCriteria: ['Observable behavior passes.'],
    dependencies: [],
    phase: 'development',
    developer: 'developer-1',
    branch: null,
    worktree: null,
    head: null,
    base: head,
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
  const developer = await workspaces.developer(draft);
  const task = { ...draft, branch: developer.branch, worktree: developer.directory };
  const artifact = path.join(mesh.directory, 'factory', 'jobs', 'diagnostics');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- The fixture's own temporary job artifact.
  mkdirSync(artifact, { recursive: true });
  const job = jobSchema.parse({
    id: randomUUID(),
    token: randomUUID(),
    kind: 'develop',
    role: 'developer-1',
    provider: 'codex',
    taskId: task.id,
    featureId: null,
    head: null,
    base: null,
    state: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    expiresAt: Date.now() + 60_000,
    reservation: 0,
    usageTokens: null,
    pid: null,
    summary: null,
    artifact,
  });
  return { mesh, workspaces, task, job, directory: developer.directory, defer };
}

/**
 * What a promise rejected with.
 *
 * @param promise - Operation expected to fail.
 * @returns The rejection, or undefined when it resolved.
 */
export async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return undefined;
}
