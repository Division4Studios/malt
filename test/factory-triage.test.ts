/**
 * Revision-fenced operator decisions, bounded investigations and external PR recovery.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { hasParkedPRUpdate } from '../src/factory/blocked-pr.ts';
import { jobIntents } from '../src/factory/scheduler.ts';
import { factoryConfigSchema, taskSchema, jobSchema } from '../src/factory/schema.ts';
import { FactoryService } from '../src/factory/service.ts';
import {
  decideTriage,
  triageStatus,
  queueBlockerInvestigations,
  completeTriage,
  pendingTriage,
} from '../src/factory/triage.ts';
import { ProjectGitHub } from '../src/github.ts';
import { ProjectLearning } from '../src/learning.ts';
import { Store } from '../src/store.ts';

import { createCleanup, createProject } from './helpers.ts';

import type { TestContext } from 'node:test';

/** Validated fixture policy; no provider is launched. */
const config = factoryConfigSchema.parse({
  testCommands: [{ file: process.execPath }],
  endToEndCommands: [{ file: process.execPath }],
});

/**
 * Open an isolated factory without starting its scheduler.
 *
 * @param t - Test cleanup.
 * @returns Project context.
 */
function fixture(t: TestContext): ReturnType<FactoryService['configured']> {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  const store = new Store(mesh);
  defer(() => {
    store.close();
  });
  const factory = new FactoryService(
    mesh,
    store,
    { github: new ProjectGitHub(mesh), learning: new ProjectLearning(mesh) },
    { home: mesh.root },
  );
  defer(async () => factory.close());
  factory.repository.configure(config);
  factory.repository.addTask(
    taskSchema.parse({
      id: randomUUID(),
      featureId: null,
      issue: 1,
      parentIssue: 2,
      key: 'one',
      title: 'Repair existing PR',
      description: 'Bounded fixture.',
      acceptanceCriteria: ['Works'],
      dependencies: [],
      phase: 'blocked',
      developer: 'developer-2',
      branch: 'malt/fixture',
      worktree: null,
      head: 'old',
      base: 'base',
      pr: 3,
      prUrl: 'https://github.com/fixture/app/pull/3',
      merge: null,
      reviews: [],
      feedback: [],
      attempts: 2,
      version: 0,
      error: 'Required checks failed.',
      updatedAt: 1,
    }),
  );
  return factory.configured();
}

await test('decisions replay exactly, fence stale revisions and do not treat acknowledgment as a fix', (t) => {
  const { repository } = fixture(t);
  const task = repository.tasks()[0];
  assert.ok(task !== undefined);
  const input = {
    requestId: randomUUID(),
    taskId: task.id,
    expectedVersion: task.version,
    action: 'acknowledge',
    note: 'Seen',
  };
  const receipt = decideTriage(repository, input);
  assert.equal(repository.task(task.id).phase, 'blocked');
  assert.deepEqual(decideTriage(repository, input), receipt);
  assert.throws(() => decideTriage(repository, { ...input, note: 'Changed' }), /identity/v);
  repository.editTask(task.id, (current) => ({ ...current, error: 'New evidence' }));
  assert.throws(() => decideTriage(repository, { ...input, requestId: randomUUID() }), /changed/v);
});

await test('waiting does not spin a lead; investigations are single-shot and repair preserves owner', (t) => {
  const { repository } = fixture(t);
  let task = repository.tasks()[0];
  assert.ok(task !== undefined);
  decideTriage(repository, {
    requestId: randomUUID(),
    taskId: task.id,
    expectedVersion: task.version,
    action: 'wait',
    note: 'Which acceptance behavior is intended?',
  });
  queueBlockerInvestigations(repository);
  assert.equal(triageStatus(repository).length, 1, 'Waiting must not immediately schedule a fresh investigation.');
  task = repository.task(task.id);
  const decision = decideTriage(repository, {
    requestId: randomUUID(),
    taskId: task.id,
    expectedVersion: task.version,
    action: 'investigate',
    note: 'Diagnose',
  });
  const intents = jobIntents({
    config,
    tasks: repository.tasks(),
    features: [],
    jobs: [],
    skillRequests: [],
    triage: triageStatus(repository),
    now: Date.now(),
  });
  const intent = intents.find((candidate) => candidate.kind === 'triage');
  assert.ok(intent !== undefined);
  const job = jobSchema.parse({
    ...intent,
    id: randomUUID(),
    token: randomUUID(),
    provider: 'codex',
    state: 'running',
    startedAt: 1,
    finishedAt: null,
    expiresAt: Date.now() + 1000,
    reservation: 1,
    usageTokens: null,
    pid: null,
    summary: null,
    artifact: 'fixture',
  });
  completeTriage(repository, job, {
    outcome: 'blocked',
    summary: 'Need a product decision.',
    findings: ['Should this accept empty input?'],
    deliveries: [],
    skillActions: [],
    instructionReceipts: [],
  });
  assert.equal(triageStatus(repository).find((item) => item.id === decision.id)?.state, 'awaiting_operator');
  queueBlockerInvestigations(repository);
  assert.equal(triageStatus(repository).length, 2);
  decideTriage(repository, {
    requestId: randomUUID(),
    taskId: task.id,
    expectedVersion: task.version,
    action: 'repair',
    note: 'Reject empty input.',
  });
  assert.equal(repository.task(task.id).developer, 'developer-2');
  assert.equal(repository.task(task.id).phase, 'development');
  assert.ok(repository.instructions('developer-2', task.id).some((item) => item.body.includes('Reject empty input')));
});

await test('external merged PRs stop implementation loops and require explicit verification, never fake approvals', async (t) => {
  const context = fixture(t);
  const { repository } = context;
  const task = repository.tasks()[0];
  assert.ok(task !== undefined);
  t.mock.method(context.remote, 'inspect', async () => {
    await delay(0);
    return {
      number: 3,
      url: task.prUrl ?? '',
      headRefOid: 'new',
      baseRefOid: 'base',
      baseRefName: 'main',
      isDraft: false,
      state: 'MERGED',
      mergeStateStatus: 'CLEAN',
      mergeCommit: { oid: 'merged' },
      statusCheckRollup: [],
    };
  });
  assert.equal(await hasParkedPRUpdate(context, task), true);
  const parked = repository.task(task.id);
  assert.equal(parked.merge, 'merged');
  assert.equal(parked.phase, 'blocked');
  await hasParkedPRUpdate(context, parked);
  assert.equal(
    repository.task(task.id).version,
    parked.version,
    'Same remote evidence must not generate an event/retry storm.',
  );
  decideTriage(repository, {
    requestId: randomUUID(),
    taskId: task.id,
    expectedVersion: parked.version,
    action: 'verify',
    note: 'Verify my external merge on actual main.',
  });
  const verifying = repository.task(task.id);
  assert.equal(verifying.phase, 'verifying');
  assert.deepEqual(verifying.reviews, []);
  assert.equal(verifying.verifiedMain, null);
});

await test('existing PR owner repairs precede new development, and stale lead findings cannot change task state', (t) => {
  const { repository } = fixture(t);
  const task = repository.tasks()[0];
  assert.ok(task !== undefined);
  decideTriage(repository, {
    requestId: randomUUID(),
    taskId: task.id,
    expectedVersion: task.version,
    action: 'repair',
    note: 'Repair the PR.',
  });
  const existing = repository.task(task.id);
  const fresh = {
    ...existing,
    id: randomUUID(),
    issue: 4,
    pr: null,
    prUrl: null,
    developer: null,
    phase: 'ready' as const,
  };
  const intents = jobIntents({
    config,
    tasks: [fresh, existing],
    features: [],
    jobs: [],
    skillRequests: [],
    now: Date.now(),
  });
  assert.equal(intents[0]?.taskId, existing.id);
  assert.equal(intents[0].role, 'developer-2');
});

await test('old queued investigations survive a full newer history and focus filters the durable queue', (t) => {
  const { repository } = fixture(t);
  const task = repository.tasks()[0];
  assert.ok(task !== undefined);
  const queued = decideTriage(repository, {
    requestId: randomUUID(),
    taskId: task.id,
    expectedVersion: task.version,
    action: 'investigate',
    note: 'Old pending diagnosis',
  });
  for (let index = 0; index < 105; index += 1) {
    decideTriage(repository, {
      requestId: randomUUID(),
      taskId: task.id,
      expectedVersion: task.version,
      action: 'acknowledge',
      note: 'Newer receipt',
    });
  }
  assert.equal(
    triageStatus(repository).some((decision) => decision.id === queued.id),
    false,
  );
  assert.equal(pendingTriage(repository, null)[0]?.id, queued.id);
  assert.deepEqual(pendingTriage(repository, randomUUID()), []);
  const intents = jobIntents({
    config,
    tasks: repository.tasks(),
    features: [],
    jobs: [],
    skillRequests: [],
    triage: pendingTriage(repository, null),
    now: Date.now(),
  });
  const intent = intents.find((candidate) => candidate.kind === 'triage');
  assert.ok(intent !== undefined);
  const job = jobSchema.parse({
    ...intent,
    id: randomUUID(),
    token: randomUUID(),
    provider: 'codex',
    state: 'running',
    startedAt: 1,
    finishedAt: null,
    expiresAt: Date.now() + 1000,
    reservation: 0,
    usageTokens: null,
    pid: null,
    summary: null,
    artifact: 'fixture',
  });
  completeTriage(repository, job, {
    outcome: 'blocked',
    summary: 'Need a decision',
    findings: [],
    deliveries: [],
    skillActions: [],
    instructionReceipts: [],
  });
  assert.deepEqual(pendingTriage(repository, null), []);
});
