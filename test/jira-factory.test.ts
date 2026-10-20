/**
 * The supervisor delivering through a Jira tracker, with real Git, the real
 * capability policy and a fixture Jira site: intake files each workable
 * issue once as an objective, provisioning creates its sub-tasks, and a Jira
 * capability denial parks its scope as exactly one durable blocker with no
 * Jira request and no retries, until a human changes the Jira mode (#330).
 *
 * @file
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { CapabilityPolicyStore } from '../src/capability-policy.ts';
import { JiraDelivery } from '../src/factory/jira-delivery.ts';
import { factoryConfigSchema, featureSchema, taskSchema } from '../src/factory/schema.ts';
import { FactoryService } from '../src/factory/service.ts';
import { intakeObjectiveId } from '../src/factory/tracker-work.ts';
import { WorkspaceManager } from '../src/factory/workspaces.ts';
import { ProjectGitHub } from '../src/github.ts';
import { setJiraMode } from '../src/jira/modes.ts';
import { readIntakeRecord } from '../src/jira/workflow.ts';
import { ProjectLearning } from '../src/learning.ts';
import { Store } from '../src/store.ts';

import { OPERATOR, createCleanup, createProject } from './helpers.ts';
import { SITE_TOKEN, STATUS, jiraSite } from './jira-site.ts';

import type { JiraSite } from './jira-site.ts';
import type { JiraWorkflow } from '../src/connector.ts';
import type { AgentCompletion } from '../src/factory/providers.ts';
import type { FactoryRepository } from '../src/factory/repository.ts';
import type { FactoryTask } from '../src/factory/schema.ts';
import type { JiraMode } from '../src/jira/modes.ts';
import type { TestContext } from 'node:test';

/** The fixture site. */
const ORIGIN = 'https://example.atlassian.net';
/** Spacing that always exceeds the unpaid reconcile interval and the intake interval. */
const PASS_MS = 61_000;
/** Project policy; nothing here runs validation. */
const settings = factoryConfigSchema.parse({
  testCommands: [{ file: process.execPath }],
  endToEndCommands: [{ file: process.execPath }],
});

/** A supervisor over the Jira remote. */
interface Fixture {
  readonly factory: FactoryService;
  readonly repository: FactoryRepository;
  readonly policy: CapabilityPolicyStore;
  readonly site: JiraSite;
  /** Workflow settings the tracker reports; tests change them in place. */
  readonly workflow: { -readonly [Key in keyof JiraWorkflow]: JiraWorkflow[Key] };
  readonly clock: { now: number };
  readonly projectId: string;
  /** Project data directory, holding the intake record. */
  readonly directory: string;
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
 * Build a supervisor whose delivery remote is Jira over a fixture site.
 *
 * @param t - Owns cleanup.
 * @param mode - Jira mode, granted to the team lead.
 * @returns Controllable fixture.
 */
async function build(t: TestContext, mode: JiraMode): Promise<Fixture> {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  const workspaces = new WorkspaceManager(mesh, settings);
  await workspaces.git(['init', '--initial-branch=main']);
  await workspaces.git(['config', 'user.name', 'Jira fixture']);
  await workspaces.git(['config', 'user.email', 'jira@example.invalid']);
  await workspaces.git(['commit', '--allow-empty', '-m', 'Fixture baseline']);
  const origin = path.join(mesh.directory, 'origin.git');
  await workspaces.git(['init', '--bare', origin]);
  await workspaces.git(['remote', 'add', 'origin', origin]);
  await workspaces.git(['push', '-u', 'origin', 'main']);
  const clock = { now: Date.parse('2026-10-20T12:00:00.000Z') };
  const store = new Store(mesh, { now: () => clock.now });
  const policy = new CapabilityPolicyStore(store, mesh);
  setJiraMode(policy, OPERATOR, mode, ['team-lead']);
  const site = jiraSite();
  const workflow: Fixture['workflow'] = {};
  const offline = async (): Promise<never> => {
    await delay(0);
    throw new Error('No pull request exists in this check.');
  };
  const remote = new JiraDelivery(
    mesh,
    () => {
      return {
        tracker: {
          site: ORIGIN,
          projectKey: 'PROJ',
          email: 'robot@example.com',
          tokenVariable: 'JIRA_API_TOKEN',
          workflow: { ...workflow },
        },
        transport: {
          site: { origin: ORIGIN, deployment: 'cloud' },
          credential: { email: 'robot@example.com', token: SITE_TOKEN },
          fetch: site.fetch,
        },
        gate: policy,
      };
    },
    {
      verifySource: async () => delay(0),
      pullRequest: offline,
      inspect: offline,
      merge: offline,
      effect: offline,
    },
    { now: () => clock.now },
  );
  const agent = async (): Promise<AgentCompletion> => {
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
  return {
    factory,
    repository: factory.repository,
    policy,
    site,
    workflow,
    clock,
    projectId: mesh.projectId,
    directory: mesh.directory,
  };
}

/**
 * Seed one ready delivery for a Jira sub-task.
 *
 * @param fixture - Target ledger.
 * @param issue - Jira ID and key of the sub-task.
 * @param issue.id - Jira issue ID.
 * @param issue.key - Jira issue key.
 * @returns Persisted delivery.
 */
function seed(fixture: Fixture, issue: { id: string; key: string }): FactoryTask {
  const task = taskSchema.parse({
    id: randomUUID(),
    featureId: null,
    issue: Number(issue.id),
    parentIssue: 10_000,
    trackerKey: { provider: 'jira', key: issue.key },
    parentKey: { provider: 'jira', key: 'PROJ-100' },
    key: issue.key.toLowerCase(),
    title: 'Export API',
    description: 'Serve the export.',
    acceptanceCriteria: ['GET /export answers CSV.'],
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

await test('a Jira denial parks its delivery once with no Jira request, and a mode change resumes the transition', async (t) => {
  const fixture = await build(t, 'comment-only');
  fixture.workflow.stages = { Ready: { statusId: STATUS.progress, statusName: 'In Progress' } };
  const issue = fixture.site.add({ summary: 'Export API' });
  const task = seed(fixture, issue);
  await pass(fixture);
  const parked = fixture.repository.task(task.id);
  assert.equal(parked.phase, 'blocked');
  assert.equal(parked.capabilityBlock?.phase, 'ready');
  assert.match(parked.error ?? '', /Capability transition is disabled for this project/v);
  assert.match(parked.error ?? '', /capability-set/v);
  for (let index = 0; index < 3; index += 1) {
    await pass(fixture);
  }
  assert.equal(fixture.repository.task(task.id).version, parked.version, 'the blocker is written once');
  assert.ok(
    fixture.repository.jobs().every((job) => job.taskId !== task.id),
    'no assignment for the parked delivery',
  );
  assert.deepEqual(fixture.site.requests, [], 'Jira received no request for the denied write, nor any retry');

  setJiraMode(fixture.policy, OPERATOR, 'full', ['team-lead']);
  await pass(fixture);
  assert.equal(issue.status, STATUS.progress, 'the resumed effect performs the mapped transition');
  const resumed = fixture.repository.task(task.id);
  assert.notEqual(resumed.phase, 'blocked');
  assert.equal(resumed.capabilityBlock, undefined);
});

await test('read-only Jira parks provisioning once; full mode for the lead creates the sub-tasks', async (t) => {
  const fixture = await build(t, 'read-only');
  const parent = fixture.site.add({ summary: 'Export reports' });
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
  const feature = featureSchema.parse({
    id: randomUUID(),
    objective: `${parent.key}: Export reports`,
    phase: 'provisioning',
    productPlan: plan,
    plan,
    parentIssue: Number(parent.id),
    parentKey: { provider: 'jira', key: parent.key },
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
  assert.match(parked.error ?? '', /Capability issue-create is disabled/v);
  assert.deepEqual(fixture.site.requests, [], 'nothing reached Jira');

  setJiraMode(fixture.policy, OPERATOR, 'full', ['team-lead']);
  await pass(fixture);
  const child = fixture.site.issues.find((issue) => issue.parent === parent.key);
  assert.equal(child?.summary, 'Only slice');
  const [task] = fixture.repository.tasks();
  assert.deepEqual(task?.trackerKey, { provider: 'jira', key: child.key });
  assert.equal(task.issue, Number(child.id));
  assert.equal(
    fixture.repository.features().find((candidate) => candidate.id === feature.id)?.phase,
    'active',
    'the objective resumes and is provisioned',
  );

  // A filter as broad as the project also matches the sub-task MALT just created.
  fixture.site.intake = { jql: 'project = PROJ', ids: [parent.id, child.id] };
  fixture.workflow.intake = { jql: 'project = PROJ' };
  await pass(fixture);
  assert.deepEqual(
    fixture.repository.features().map((candidate) => candidate.id),
    [feature.id],
    'neither the parent nor its delivery becomes another objective',
  );
  assert.deepEqual(readIntakeRecord(fixture.directory)?.skipped, [
    { key: parent.key, reason: 'already_queued' },
    { key: child.key, reason: 'already_queued' },
  ]);
});

await test('intake files each workable Jira issue once as an objective whose parent is that issue', async (t) => {
  const fixture = await build(t, 'read-only');
  const wanted = fixture.site.add({ summary: 'Export reports' });
  const done = fixture.site.add({ status: STATUS.done });
  fixture.site.intake = { jql: 'project = PROJ', ids: [wanted.id, done.id] };
  fixture.workflow.intake = { jql: 'project = PROJ' };
  await pass(fixture);
  await pass(fixture);
  const filed = fixture.repository.features();
  assert.equal(filed.length, 1, 'filed once across passes, and never for a done issue');
  const [feature] = filed;
  assert.equal(
    feature?.id,
    intakeObjectiveId(fixture.projectId, { issue: Number(wanted.id), tracker: `jira:${ORIGIN}` }),
  );
  assert.notEqual(
    feature.id,
    intakeObjectiveId(fixture.projectId, { issue: Number(wanted.id), tracker: 'jira:https://other.atlassian.net' }),
    'the same issue ID on another site is another objective',
  );
  assert.equal(feature.parentIssue, Number(wanted.id));
  assert.equal(feature.parentTracker, `jira:${ORIGIN}`);
  assert.deepEqual(feature.parentKey, { provider: 'jira', key: wanted.key });
  assert.match(feature.objective, /^PROJ-1: Export reports/v);
  assert.deepEqual(fixture.site.writes(), [], 'intake only reads');
});
