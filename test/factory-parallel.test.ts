/** @file Supervisor overlap and admission recovery over real Git, without paid turns or network. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { factoryConfigSchema, featureSchema, taskSchema } from '../src/factory/schema.ts';
import { FactoryService } from '../src/factory/service.ts';
import { WorkspaceManager } from '../src/factory/workspaces.ts';
import { ProjectGitHub } from '../src/github.ts';
import { ProjectLearning } from '../src/learning.ts';
import { Store } from '../src/store.ts';

import { createCleanup, createProject } from './helpers.ts';

import type { AgentCompletion, AgentRequest } from '../src/factory/providers.ts';
import type { DeliveryRemote } from '../src/factory/remote.ts';
import type { FactoryConfig, FactoryJob, Feature } from '../src/factory/schema.ts';
import type { TestContext } from 'node:test';

/** Controlled scheduler advance, short enough not to expire live claims. */
const STEP_MS = 1000;
/** Bounded async preparation attempts before declaring a regression. */
const MAX_PASSES = 100;
/** Evidence and controls for an isolated unpaid factory. */
interface Fixture {
  readonly factory: FactoryService;
  readonly requests: AgentRequest[];
  readonly releases: Map<string, () => void>;
  readonly clock: { now: number };
  readonly probe: { cpu: number };
  readonly settings: FactoryConfig;
}

/**
 * Fail any remote boundary outside the explicit fixture contract.
 *
 * @returns Always rejects; never accesses GitHub.
 */
async function unused(): Promise<never> {
  await Promise.resolve();
  throw new Error('Unexpected fixture remote boundary.');
}

/**
 * Initialize real disposable Git/worktrees with a deferred inference boundary.
 *
 * @param t - Owns resources in reverse acquisition order.
 * @param cap - Broker pipeline ceiling for this test.
 * @returns Ready fixture; no supervisor polling timer starts.
 */
async function build(t: TestContext, cap = 2): Promise<Fixture> {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  const settings = factoryConfigSchema.parse({
    testCommands: [{ file: process.execPath, args: ['--version'] }],
    endToEndCommands: [{ file: process.execPath, args: ['--version'] }],
    providers: { codex: { executable: 'fixture', concurrency: 2 }, claude: { executable: 'fixture', enabled: false } },
    resources: { maxActiveJobs: cap, maxCpuPercent: 80 },
  });
  const git = new WorkspaceManager(mesh, settings);
  await git.git(['init', '--initial-branch=main']);
  await git.git(['config', 'user.name', 'Parallel fixture']);
  await git.git(['config', 'user.email', 'parallel@example.invalid']);
  await git.git(['add', '.']);
  await git.git(['commit', '-m', 'Disposable baseline']);
  const origin = path.join(mesh.directory, 'origin.git');
  await git.git(['init', '--bare', origin]);
  await git.git(['remote', 'add', 'origin', origin]);
  await git.git(['push', '-u', 'origin', 'main']);
  const clock = { now: Date.now() };
  const probe = { cpu: 1 };
  const store = new Store(mesh, { now: () => clock.now });
  const requests: AgentRequest[] = [];
  const releases = new Map<string, () => void>();
  const remote: DeliveryRemote = {
    verify: async () => delay(0),
    readyIssues: async () => delay(0, []),
    provision: unused,
    inspect: unused,
    pullRequest: unused,
    merge: unused,
    effect: async () => delay(0),
    parentComplete: async () => delay(0, false),
    issueState: async () => delay(0, { state: 'open', stateReason: null }),
  };
  const agent = async (request: AgentRequest): Promise<AgentCompletion> => {
    requests.push(request);
    await new Promise<void>((resolve) => {
      releases.set(request.job.id, resolve);
      request.signal.addEventListener(
        'abort',
        () => {
          resolve();
        },
        { once: true },
      );
      if (request.signal.aborted) {
        resolve();
      }
    });
    throw new Error('Deferred fixture released without implementing a delivery.');
  };
  const factory = new FactoryService(
    mesh,
    store,
    { github: new ProjectGitHub(mesh), learning: new ProjectLearning(mesh) },
    {
      home: mesh.root,
      remote,
      agent,
      resources: () => ({ freeMemoryMb: 10_000, totalMemoryMb: 20_000, cpuPercent: probe.cpu }),
    },
  );
  defer(async () => {
    await factory.close();
    store.close();
  });
  await factory.execute('factory_setup', settings);
  factory.repository.setActive(true);
  return { factory, requests, releases, clock, probe, settings };
}

/**
 * Add one independent objective with an optional ready delivery.
 *
 * @param fixture - Isolated supervisor.
 * @param issue - Unique fixture issue.
 * @param isQueued - Whether product planning remains to be done.
 * @returns Persisted objective.
 */
function objective(fixture: Fixture, issue: number, isQueued = false): Feature {
  const feature = featureSchema.parse({
    id: randomUUID(),
    objective: `Objective ${String(issue)}`,
    phase: isQueued ? 'queued' : 'active',
    productPlan: null,
    plan: null,
    parentIssue: isQueued ? null : issue,
    error: null,
    createdAt: fixture.clock.now,
    updatedAt: fixture.clock.now,
  });
  fixture.factory.repository.saveFeature(feature);
  if (!isQueued) {
    fixture.factory.repository.addTask(
      taskSchema.parse({
        id: randomUUID(),
        featureId: feature.id,
        issue,
        parentIssue: issue,
        key: `scope-${String(issue)}`,
        title: `Delivery ${String(issue)}`,
        description: 'One independently observable scope.',
        acceptanceCriteria: ['Observable behavior passes.'],
        dependencies: [],
        phase: 'ready',
        developer: null,
        branch: null,
        worktree: null,
        head: null,
        base: null,
        pr: null,
        prUrl: null,
        merge: null,
        reviews: [],
        feedback: [],
        attempts: 0,
        version: 0,
        error: null,
        updatedAt: fixture.clock.now,
      }),
    );
  }
  return feature;
}

/**
 * Advance only explicit unpaid supervisor passes, waiting for asynchronous Git.
 *
 * @param fixture - Fixture to drive.
 * @param isReady - Actual observed outcome.
 */
async function until(fixture: Fixture, isReady: () => boolean): Promise<void> {
  const { clock } = fixture;
  for (let step = 0; step < MAX_PASSES; step += 1) {
    clock.now += STEP_MS;
    await fixture.factory.tick();
    await delay(20);
    if (isReady()) {
      return;
    }
  }
  assert.fail(
    JSON.stringify({ jobs: fixture.factory.repository.jobs(), requests: fixture.requests.map(({ job }) => job.id) }),
  );
}

/**
 * Read only current owned assignment claims.
 *
 * @param fixture - Isolated ledger.
 * @returns Running jobs.
 */
function running(fixture: Fixture): FactoryJob[] {
  return fixture.factory.repository.jobs().filter((job) => job.state === 'running');
}

await test('two objectives overlap in separate developer worktrees without duplicate claims', async (t) => {
  const fixture = await build(t);
  const first = objective(fixture, 1);
  const second = objective(fixture, 2);
  await until(fixture, () => fixture.requests.length === 2);
  assert.deepEqual(new Set(running(fixture).map((job) => job.featureId)), new Set([first.id, second.id]));
  assert.deepEqual(new Set(fixture.requests.map(({ job }) => job.role)), new Set(['developer-1', 'developer-2']));
  const worktrees = new Set(fixture.requests.map(({ cwd }) => cwd));
  assert.equal(worktrees.size, 2);
  const ids = new Set(running(fixture).map((job) => job.id));
  await until(fixture, () => true);
  await until(fixture, () => true);
  assert.deepEqual(new Set(running(fixture).map((job) => job.id)), ids);
  assert.equal(fixture.requests.length, 2);
});

await test('product planning for another objective overlaps an existing developer', async (t) => {
  const fixture = await build(t);
  const first = objective(fixture, 1);
  await until(fixture, () => fixture.requests.length === 1);
  const second = objective(fixture, 2, true);
  await until(fixture, () => fixture.requests.length === 2);
  assert.ok(running(fixture).some((job) => job.featureId === first.id && job.kind === 'develop'));
  assert.ok(running(fixture).some((job) => job.featureId === second.id && job.kind === 'plan'));
  await until(fixture, () => true);
  assert.equal(fixture.requests.length, 2);
});

await test('single pipeline cap waits for full release before admitting the next objective', async (t) => {
  const fixture = await build(t, 1);
  objective(fixture, 1);
  objective(fixture, 2);
  await until(fixture, () => fixture.requests.length === 1);
  const first = fixture.requests[0];
  assert.ok(first !== undefined);
  await until(fixture, () => true);
  assert.equal(fixture.requests.length, 1);
  assert.equal(running(fixture).length, 1);
  fixture.releases.get(first.job.id)?.();
  // The failed scope is retained, not retried or reported delivered.
  await until(fixture, () =>
    fixture.factory.repository.jobs().some((job) => job.id === first.job.id && job.state !== 'running'),
  );
  await until(fixture, () => fixture.requests.length === 2);
  const second = fixture.requests[1];
  assert.ok(second !== undefined);
  assert.notEqual(second.job.featureId, first.job.featureId);
  assert.equal(second.job.kind, 'develop');
  assert.equal(running(fixture).length, 1);
});

await test('CPU pressure and provider cooldown park unpaid dispatch and recover without duplicate jobs', async (t) => {
  const fixture = await build(t);
  objective(fixture, 1);
  fixture.probe.cpu = 95;
  await until(fixture, () => true);
  assert.deepEqual(running(fixture), []);
  assert.equal(fixture.requests.length, 0);
  fixture.probe.cpu = 1;
  const capacity = fixture.factory.repository.capacity('codex', fixture.settings);
  fixture.factory.repository.saveCapacity({ ...capacity, cooldownUntil: fixture.clock.now + 20_000 });
  await until(fixture, () => true);
  assert.equal(fixture.requests.length, 0);
  assert.deepEqual(running(fixture), []);
  fixture.clock.now += 20_000;
  await until(fixture, () => fixture.requests.length === 1);
  await until(fixture, () => true);
  assert.equal(fixture.requests.length, 1);
});
