/**
 * Capability denials park their scope once (#79): no effect retries, no new
 * assignments for that scope, unrelated work keeps dispatching, and a policy
 * change resumes the original operation. Real Git and a fixture remote.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { CapabilityPolicyStore } from '../src/capability-policy.ts';
import { factoryConfigSchema, featureSchema, taskSchema } from '../src/factory/schema.ts';
import { FactoryService } from '../src/factory/service.ts';
import { WorkspaceManager } from '../src/factory/workspaces.ts';
import { ProjectGitHub } from '../src/github.ts';
import { ProjectLearning } from '../src/learning.ts';
import { MeshError } from '../src/protocol.ts';
import { Store } from '../src/store.ts';

import { OPERATOR, createCleanup, createProject } from './helpers.ts';

import type { AgentCompletion } from '../src/factory/providers.ts';
import type { DeliveryRemote } from '../src/factory/remote.ts';
import type { FactoryRepository } from '../src/factory/repository.ts';
import type { FactoryTask, Feature } from '../src/factory/schema.ts';
import type { TestContext } from 'node:test';

/** Spacing that always exceeds the unpaid reconcile interval. */
const PASS_MS = 31_000;
/** Project policy; parked scopes need no validation commands. */
const settings = factoryConfigSchema.parse({
  testCommands: [{ file: process.execPath }],
  endToEndCommands: [{ file: process.execPath }],
});

/** Controllable supervisor over a fixture remote. */
interface Fixture {
  /** Supervisor under test. */
  readonly factory: FactoryService;
  /** Its ledger. */
  readonly repository: FactoryRepository;
  /** Real policy store sharing the project database. */
  readonly policy: CapabilityPolicyStore;
  /** Issues the remote currently denies. */
  readonly denied: Set<number>;
  /** Whether provisioning is denied. */
  readonly provisioning: { denied: boolean; calls: number };
  /** Effects the remote was asked to apply, in order. */
  readonly effects: { id: string; issue: number; value: string }[];
  /** Development assignments that reached the provider boundary. */
  readonly launches: string[];
  /** Fixture clock. */
  readonly clock: { now: number };
}

/**
 * The broker's denial for a capability.
 *
 * @param capability - Denied capability.
 * @returns Matching error.
 */
function denial(capability: string): MeshError {
  return new MeshError(
    'CAPABILITY_DENIED',
    `Capability ${capability} is disabled for this project; supervisor for team-lead may not use it.`,
  );
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
 * Build a supervisor whose remote denies selected issues and provisioning.
 *
 * @param t - Owns cleanup.
 * @returns Controllable fixture.
 */
async function build(t: TestContext): Promise<Fixture> {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  const workspaces = new WorkspaceManager(mesh, settings);
  await workspaces.git(['init', '--initial-branch=main']);
  await workspaces.git(['config', 'user.name', 'Capability fixture']);
  await workspaces.git(['config', 'user.email', 'capability@example.invalid']);
  await workspaces.git(['add', '.']);
  await workspaces.git(['commit', '-m', 'Fixture baseline']);
  const origin = path.join(mesh.directory, 'origin.git');
  await workspaces.git(['init', '--bare', origin]);
  await workspaces.git(['remote', 'add', 'origin', origin]);
  await workspaces.git(['push', '-u', 'origin', 'main']);
  const clock = { now: Date.now() };
  const store = new Store(mesh, { now: () => clock.now });
  const denied = new Set<number>();
  const provisioning = { denied: false, calls: 0 };
  const effects: Fixture['effects'] = [];
  const launches: string[] = [];
  const offline = async (): Promise<never> => {
    await delay(0);
    throw new Error('Fixture remote is not used by this check.');
  };
  const remote: DeliveryRemote = {
    verify: async () => delay(0),
    provision: async () => {
      provisioning.calls += 1;
      await delay(0);
      if (provisioning.denied) {
        throw denial('issue-create');
      }
      return [];
    },
    readyIssues: async () => delay(0, []),
    pullRequest: offline,
    inspect: offline,
    merge: offline,
    effect: async (effect) => {
      effects.push({ id: effect.id, issue: effect.issue, value: effect.value });
      await delay(0);
      if (denied.has(effect.issue)) {
        throw denial('transition');
      }
    },
    parentComplete: async () => delay(0, false),
    issueState: async () => delay(0, { state: 'open', stateReason: null }),
  };
  const agent = async (): Promise<AgentCompletion> => {
    launches.push('develop');
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
  factory.repository.configure(settings);
  factory.repository.prepareSender();
  factory.repository.setActive(true);
  const policy = new CapabilityPolicyStore(store, mesh);
  return { factory, repository: factory.repository, policy, denied, provisioning, effects, launches, clock };
}

/**
 * Seed one ready delivery.
 *
 * @param fixture - Target ledger.
 * @param issue - Native issue number.
 * @returns Persisted task.
 */
function seed(fixture: Fixture, issue: number): FactoryTask {
  const task = taskSchema.parse({
    id: randomUUID(),
    featureId: null,
    issue,
    parentIssue: 1,
    key: `issue-${String(issue)}`,
    title: `Delivery ${String(issue)}`,
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
  });
  fixture.repository.addTask(task);
  return task;
}

/**
 * Change the policy, as a human edit does.
 *
 * @param fixture - Running fixture.
 */
function grantTransition(fixture: Fixture): void {
  fixture.policy.set(OPERATOR, 'transition', { mode: 'approved-agent-roles', roles: ['team-lead'] });
}

await test('a denied effect parks its delivery once, unrelated work dispatches, and a policy change resumes its transition', async (t) => {
  const fixture = await build(t);
  fixture.denied.add(60);
  const blocked = seed(fixture, 60);
  // Adding the delivery queues its Ready board status, which the remote denies.
  await pass(fixture);
  const parked = fixture.repository.task(blocked.id);
  assert.equal(parked.phase, 'blocked');
  assert.match(parked.error ?? '', /Capability transition is disabled/v);
  assert.match(parked.error ?? '', /capability-set/v);
  assert.equal(parked.capabilityBlock?.phase, 'ready');

  const other = seed(fixture, 61);
  for (let index = 0; index < 3; index += 1) {
    await pass(fixture);
  }
  assert.deepEqual(
    fixture.effects.filter((effectSent) => effectSent.issue === 60).length,
    1,
    'neither the denied effect nor the parked board status is retried',
  );
  assert.equal(fixture.repository.task(blocked.id).version, parked.version, 'the blocker is written once');
  const jobs = fixture.repository.jobs();
  assert.ok(
    jobs.every((job) => job.taskId !== blocked.id),
    'no assignment for the parked delivery',
  );
  assert.ok(
    jobs.some((job) => job.taskId === other.id && job.kind === 'develop'),
    'unrelated work dispatches',
  );

  fixture.denied.delete(60);
  grantTransition(fixture);
  await pass(fixture);
  const resumed = fixture.repository.task(blocked.id);
  const sent = fixture.effects.filter((effectSent) => effectSent.issue === 60);
  // Board status is coalesced per issue: the resumed transition carries the restored phase,
  // and the delivery dispatches again through its tracking gate.
  assert.equal(sent[1]?.value, 'Ready');
  assert.ok(sent.slice(2).every((effectSent) => effectSent.value === 'Development'));
  assert.ok(
    fixture.repository.effects().every((pending) => pending.capabilityRevision === undefined),
    'nothing stays parked',
  );
  assert.notEqual(resumed.phase, 'blocked');
  assert.equal(resumed.capabilityBlock, undefined);
});

await test('a denied tracking gate parks the delivery before any model launch', async (t) => {
  const fixture = await build(t);
  fixture.denied.add(62);
  const task = seed(fixture, 62);
  await pass(fixture);
  const parked = fixture.repository.task(task.id);
  assert.equal(parked.phase, 'blocked');
  assert.equal(parked.capabilityBlock?.phase, 'ready');
  assert.deepEqual(fixture.launches, []);
  const attempts = fixture.repository.jobs().length;
  await pass(fixture);
  await pass(fixture);
  assert.equal(fixture.repository.jobs().length, attempts, 'no further assignment while parked');
  assert.deepEqual(fixture.launches, []);
});

await test('denied provisioning parks the objective until the policy changes', async (t) => {
  const fixture = await build(t);
  fixture.provisioning.denied = true;
  const plan = {
    outcome: 'success',
    summary: 'One slice.',
    findings: [],
    deliveries: [
      {
        key: 'only',
        title: 'Only slice',
        description: 'One observable result.',
        acceptanceCriteria: ['The result is observable.'],
        dependencies: [],
      },
    ],
  };
  const feature: Feature = featureSchema.parse({
    id: randomUUID(),
    objective: 'Deliver one scoped outcome.',
    phase: 'provisioning',
    productPlan: plan,
    plan,
    parentIssue: null,
    error: null,
    createdAt: fixture.clock.now,
    updatedAt: fixture.clock.now,
  });
  fixture.repository.saveFeature(feature);
  await pass(fixture);
  await pass(fixture);
  const parked = fixture.repository.features().find((candidate) => candidate.id === feature.id);
  assert.equal(parked?.phase, 'blocked');
  assert.equal(parked.capabilityBlock?.phase, 'provisioning');
  assert.match(parked.error ?? '', /issue-create/v);
  assert.equal(fixture.provisioning.calls, 1, 'provisioning is not retried while parked');

  fixture.provisioning.denied = false;
  grantTransition(fixture);
  await pass(fixture);
  assert.equal(fixture.provisioning.calls, 2);
  const resumed = fixture.repository.features().find((candidate) => candidate.id === feature.id);
  assert.notEqual(resumed?.phase, 'blocked');
  assert.equal(resumed?.capabilityBlock, undefined);
});
