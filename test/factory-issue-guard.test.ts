/**
 * Closed-issue dispatch guard: the unpaid supervisor parks deliveries whose GitHub issue is
 * already closed instead of launching a developer, using fixture issue states and real Git.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { z } from 'zod/v3';

import { factoryConfigSchema, taskSchema } from '../src/factory/schema.ts';
import { FactoryService } from '../src/factory/service.ts';
import { WorkspaceManager } from '../src/factory/workspaces.ts';
import { ProjectGitHub } from '../src/github.ts';
import { ProjectLearning } from '../src/learning.ts';
import { Store } from '../src/store.ts';

import { createCleanup, createProject } from './helpers.ts';

import type { AgentCompletion, AgentRequest } from '../src/factory/providers.ts';
import type { DeliveryRemote, IssueState } from '../src/factory/remote.ts';
import type { FactoryRepository } from '../src/factory/repository.ts';
import type { FactoryJob, FactoryTask } from '../src/factory/schema.ts';
import type { TestContext } from 'node:test';

/** Operator-visible supervisor problem. */
const statusSchema = z.object({ error: z.string() });
/** Spacing that always exceeds the unpaid reconcile interval. */
const PASS_MS = 31_000;
/** Project policy; real Git, no validation commands needed for parked deliveries. */
const settings = factoryConfigSchema.parse({
  testCommands: [{ file: process.execPath }],
  endToEndCommands: [{ file: process.execPath }],
});

/** Mutable fixture behavior shared between the test and its remote. */
interface Fixture {
  /** Issue numbers read, in order. */
  readonly reads: number[];
  /** Developer launches observed by the provider boundary. */
  readonly launches: string[];
  /** Replaceable issue read implementation. */
  readonly behavior: { read: (issue: number) => Promise<IssueState> };
  /** Fixture clock. */
  readonly clock: { now: number };
  /** Supervisor under test. */
  readonly factory: FactoryService;
  /** Its ledger. */
  readonly repository: FactoryRepository;
  /** Initial commit shared by every seeded task. */
  readonly head: string;
  /** Project root containing the disposable repository. */
  readonly root: string;
}

/**
 * Advance one supervisor pass.
 *
 * @param fixture - Running fixture.
 */
async function pass(fixture: Fixture): Promise<void> {
  const { clock } = fixture;
  clock.now += PASS_MS;
  await fixture.factory.tick();
  await delay(20);
}

/**
 * Build a supervisor over a real repository whose remote reports controlled issue states.
 *
 * @param t - Owns cleanup.
 * @returns Controllable fixture.
 */
async function build(t: TestContext): Promise<Fixture> {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  const workspaces = new WorkspaceManager(mesh, settings);
  await workspaces.git(['init', '--initial-branch=main']);
  await workspaces.git(['config', 'user.name', 'Guard fixture']);
  await workspaces.git(['config', 'user.email', 'guard@example.invalid']);
  await workspaces.git(['add', '.']);
  await workspaces.git(['commit', '-m', 'Fixture baseline']);
  const origin = path.join(mesh.directory, 'origin.git');
  await workspaces.git(['init', '--bare', origin]);
  await workspaces.git(['remote', 'add', 'origin', origin]);
  await workspaces.git(['push', '-u', 'origin', 'main']);
  const head = await workspaces.base();
  const clock = { now: Date.now() };
  const behavior: Fixture['behavior'] = { read: async () => delay(0, { state: 'open', stateReason: null }) };
  const store = new Store(mesh, { now: () => clock.now });
  const launches: string[] = [];
  const reads: number[] = [];
  const offline = async (): Promise<never> => {
    await delay(0);
    throw new Error('Fixture remote is not used by this check.');
  };
  const remote: DeliveryRemote = {
    verify: async () => delay(0),
    provision: async () => delay(0, []),
    readyIssues: async () => delay(0, []),
    pullRequest: offline,
    inspect: offline,
    merge: offline,
    effect: async () => delay(0),
    parentComplete: async () => delay(0, false),
    issueState: async (issue) => {
      reads.push(issue);
      return behavior.read(issue);
    },
  };
  const agent = async (request: AgentRequest): Promise<AgentCompletion> => {
    launches.push(request.job.kind);
    await delay(0);
    throw new Error('Fixture provider stops after proving a launch.');
  };
  const factory = new FactoryService(
    mesh,
    store,
    { github: new ProjectGitHub(mesh), learning: new ProjectLearning(mesh) },
    {
      home: mesh.root,
      remote,
      agent,
      resources: () => ({ freeMemoryMb: 10_000, totalMemoryMb: 20_000, cpuPercent: 1 }),
    },
  );
  defer(async () => {
    await factory.close();
    store.close();
  });
  const fixture: Fixture = {
    reads,
    launches,
    behavior,
    clock,
    factory,
    repository: factory.repository,
    head,
    root: mesh.root,
  };
  factory.repository.configure(settings);
  factory.repository.prepareSender();
  factory.repository.setActive(true);
  return fixture;
}

/**
 * List developer assignments, ignoring unrelated unpaid-role jobs.
 *
 * @param fixture - Running fixture.
 * @returns Development jobs recorded so far.
 */
function developJobs(fixture: Fixture): FactoryJob[] {
  return fixture.repository.jobs().filter((job) => job.kind === 'develop');
}

/**
 * Seed one delivery.
 *
 * @param fixture - Target ledger.
 * @param fields - Task overrides.
 * @returns Persisted task.
 */
function seed(fixture: Fixture, fields: Partial<FactoryTask> & { issue: number }): FactoryTask {
  const task = taskSchema.parse({
    id: randomUUID(),
    featureId: null,
    parentIssue: 1,
    key: `issue-${String(fields.issue)}`,
    title: `Delivery ${String(fields.issue)}`,
    description: 'One observable outcome.',
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
    ...fields,
  });
  fixture.repository.addTask(task);
  return task;
}

await test('a ready delivery whose issue is closed as completed is parked without any developer launch', async (t) => {
  const fixture = await build(t);
  fixture.behavior.read = async () => delay(0, { state: 'closed', stateReason: 'completed' });
  const task = seed(fixture, { issue: 98 });
  await pass(fixture);
  const parked = fixture.repository.task(task.id);
  assert.equal(parked.phase, 'blocked');
  assert.match(parked.error ?? '', /#98/v);
  assert.match(parked.error ?? '', /closed/v);
  assert.match(parked.error ?? '', /completed/v);
  assert.match(parked.error ?? '', /adopt the merge/v);
  assert.match(parked.error ?? '', /reopen or re-scope/v);
  assert.deepEqual(fixture.launches, []);
  assert.deepEqual(developJobs(fixture), []);
  const { version } = parked;
  await pass(fixture);
  await pass(fixture);
  assert.deepEqual(fixture.reads, [98], 'A parked delivery is not read again.');
  assert.equal(fixture.repository.task(task.id).version, version, 'A later pass must not duplicate the blocker.');
});

await test('an issue closed as not planned is distinguished from completed', async (t) => {
  const fixture = await build(t);
  fixture.behavior.read = async () => delay(0, { state: 'closed', stateReason: 'not_planned' });
  const task = seed(fixture, { issue: 45 });
  await pass(fixture);
  const parked = fixture.repository.task(task.id);
  assert.equal(parked.phase, 'blocked');
  assert.match(parked.error ?? '', /state_reason: not_planned/v);
  assert.doesNotMatch(parked.error ?? '', /completed/v);
});

await test('pausing during the remote observation prevents a late development claim', async (t) => {
  const fixture = await build(t);
  fixture.behavior.read = async () => {
    await delay(0);
    fixture.repository.setActive(false);
    return { state: 'open', stateReason: null };
  };
  seed(fixture, { issue: 7 });
  await pass(fixture);
  assert.deepEqual(fixture.launches, []);
  assert.deepEqual(developJobs(fixture), []);
});

await test('a development rework delivery keeps its head, base, branch and uncommitted worktree when parked', async (t) => {
  const fixture = await build(t);
  fixture.behavior.read = async () => delay(0, { state: 'closed', stateReason: 'completed' });
  const worktree = path.join(fixture.root, 'owned-worktree');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- A disposable owned-worktree fixture inside the test project.
  mkdirSync(worktree, { recursive: true });
  const dirty = path.join(worktree, 'uncommitted.txt');
  const content = Buffer.from([0x00, 0xff, 0x10, 0x0a, 0x41]);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixed uncommitted file inside the disposable worktree.
  writeFileSync(dirty, content);
  const task = seed(fixture, {
    issue: 102,
    phase: 'development',
    developer: 'developer-1',
    branch: 'malt/issue-102-fixture',
    worktree,
    head: fixture.head,
    base: fixture.head,
    attempts: 1,
    feedback: ['Main advanced before PR submission. The original developer must refresh main.'],
  });
  await pass(fixture);
  const parked = fixture.repository.task(task.id);
  assert.equal(parked.phase, 'blocked');
  assert.match(parked.error ?? '', /#102 is closed/v);
  assert.deepEqual(
    { ...parked, phase: 0, error: 0, version: 0, updatedAt: 0 },
    { ...task, phase: 0, error: 0, version: 0, updatedAt: 0 },
  );
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Reads back the fixed disposable file.
  assert.deepEqual(readFileSync(dirty), content);
  assert.deepEqual(fixture.launches, []);
  assert.deepEqual(developJobs(fixture), []);
});

await test('an open issue dispatches development exactly as before', async (t) => {
  const fixture = await build(t);
  const task = seed(fixture, { issue: 7 });
  await pass(fixture);
  assert.deepEqual(fixture.reads, [7]);
  assert.deepEqual(
    developJobs(fixture).map((job) => job.taskId),
    [task.id],
  );
  const dispatched = fixture.repository.task(task.id);
  assert.equal(dispatched.attempts, 1);
  assert.equal(dispatched.developer, 'developer-1');
  assert.doesNotMatch(dispatched.error ?? '', /is closed/v);
});

await test('a failed or malformed read launches nothing, keeps phase and error, shows a bounded wait and retries later', async (t) => {
  const fixture = await build(t);
  let failures = 0;
  fixture.behavior.read = async () => {
    await delay(0);
    failures += 1;
    if (failures === 1) {
      throw new Error(`gh: ${'x'.repeat(2000)}`);
    }
    if (failures === 2) {
      throw new SyntaxError('Unexpected token < in JSON');
    }
    return { state: 'closed', stateReason: 'completed' };
  };
  const task = seed(fixture, { issue: 99, error: 'Existing explanation.' });
  await pass(fixture);
  const waiting = statusSchema.parse(await fixture.factory.status()).error;
  assert.match(waiting, /^Waiting to confirm issue #99 is open/v);
  assert.ok(waiting.length <= 300);
  const unchanged = fixture.repository.task(task.id);
  assert.equal(unchanged.phase, 'ready');
  assert.equal(unchanged.error, 'Existing explanation.');
  assert.equal(unchanged.version, task.version);
  assert.deepEqual(fixture.launches, []);
  const { clock } = fixture;
  clock.now += 1000;
  await fixture.factory.tick();
  await delay(20);
  assert.deepEqual(fixture.reads, [99], 'A failed read is not repeated on every heartbeat.');
  await pass(fixture);
  assert.deepEqual(fixture.reads, [99, 99]);
  assert.equal(fixture.repository.task(task.id).phase, 'ready');
  assert.deepEqual(fixture.launches, []);
  await pass(fixture);
  assert.equal(fixture.repository.task(task.id).phase, 'blocked');
  assert.match(fixture.repository.task(task.id).error ?? '', /#99 is closed/v);
  assert.deepEqual(fixture.launches, []);
});

await test('an operator edit during the issue read is never overwritten', async (t) => {
  const fixture = await build(t);
  const task = seed(fixture, {
    issue: 100,
    phase: 'development',
    developer: 'developer-1',
    head: fixture.head,
    base: fixture.head,
    attempts: 1,
  });
  let isFirst = true;
  fixture.behavior.read = async () => {
    await delay(0);
    if (isFirst) {
      isFirst = false;
      fixture.repository.editTask(task.id, (current) => {
        const feedback = [...current.feedback, 'Operator note written during the read.'];
        return { ...current, feedback };
      });
    }
    return { state: 'closed', stateReason: 'completed' };
  };
  await pass(fixture);
  const edited = fixture.repository.task(task.id);
  assert.equal(edited.phase, 'development', 'The stale verdict must not block the edited revision.');
  assert.deepEqual(edited.feedback, ['Operator note written during the read.']);
  assert.equal(edited.version, task.version + 1);
  assert.equal(edited.error, null);
  assert.deepEqual(fixture.launches, [], 'A stale verdict never launches either.');
  await pass(fixture);
  assert.equal(fixture.repository.task(task.id).phase, 'blocked', 'The next pass decides on the current revision.');
  assert.deepEqual(fixture.repository.task(task.id).feedback, ['Operator note written during the read.']);
});

await test('only deliveries about to be dispatched have their issue read', async (t) => {
  const fixture = await build(t);
  fixture.behavior.read = async () => delay(0, { state: 'closed', stateReason: 'completed' });
  const prerequisite = seed(fixture, { issue: 10, attempts: settings.maxAttempts });
  seed(fixture, { issue: 11, dependencies: [prerequisite.id] });
  seed(fixture, { issue: 12, attempts: settings.maxAttempts });
  seed(fixture, { issue: 15, scopeReplacement: randomUUID(), phase: 'blocked', error: 'Superseded.' });
  const eligible = seed(fixture, { issue: 16 });
  await pass(fixture);
  assert.deepEqual(fixture.reads, [16]);
  assert.equal(fixture.repository.task(eligible.id).phase, 'blocked');
  for (const issue of [11, 12]) {
    const untouched = fixture.repository.tasks().find((task) => task.issue === issue);
    assert.equal(untouched?.phase, 'ready');
    assert.equal(untouched.error, null);
  }
});
