/**
 * The Board's Needs you column and the Inbox read the same open items: a
 * delivery waiting on an agent question or a checkpoint decision is in Needs
 * you, not only in the Inbox, and every card the Inbox targets is in it. No
 * provider CLI runs.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { run } from '../src/database.ts';
import { askForDecision } from '../src/factory/checkpoint-decisions.ts';
import { consoleView, isAwaitingHuman } from '../src/factory/console-view.ts';
import { factoryConfigSchema, jobSchema, taskSchema } from '../src/factory/schema.ts';
import { FactoryService } from '../src/factory/service.ts';
import { ProjectGitHub } from '../src/github.ts';
import { ProjectLearning } from '../src/learning.ts';
import { Store } from '../src/store.ts';

import { createCleanup, createProject, registration } from './helpers.ts';

import type { ConsoleView, InboxItem } from '../src/factory/console-view.ts';
import type { FactoryJob, FactoryTask } from '../src/factory/schema.ts';
import type { TestContext } from 'node:test';

process.env['AGENTMESH_LOG_LEVEL'] = 'silent';

/** One minute. */
const MINUTE = 60_000;

/** A configured supervisor and one delivery. */
interface Fixture {
  /** Supervisor owning the project ledger. */
  readonly factory: FactoryService;
  /** Project store. */
  readonly store: Store;
  /** The delivery. */
  readonly task: FactoryTask;
  /** Working directory for attempt artifacts. */
  readonly directory: string;
}

/**
 * A configured, active project with one delivery in the given phase.
 *
 * @param t - Owns cleanup.
 * @param phase - Delivery phase.
 * @returns Supervisor, store and delivery.
 */
function fixture(t: TestContext, phase: 'ready' | 'review'): Fixture {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  const store = new Store(mesh);
  const factory = new FactoryService(
    mesh,
    store,
    { github: new ProjectGitHub(mesh), learning: new ProjectLearning(mesh) },
    { home: mesh.root },
  );
  defer(async () => {
    await factory.close();
    store.close();
  });
  const settings = factoryConfigSchema.parse({
    testCommands: [{ file: process.execPath }],
    endToEndCommands: [{ file: process.execPath }],
    resources: { maxActiveJobs: 4 },
  });
  factory.repository.configure(settings);
  factory.repository.prepareSender();
  factory.repository.setActive(true);
  const task = taskSchema.parse({
    id: randomUUID(),
    featureId: null,
    issue: 9,
    parentIssue: 1,
    key: 'needs-you',
    title: 'Pick a storage format',
    description: 'Needs a human choice.',
    acceptanceCriteria: ['Chosen.'],
    dependencies: [],
    phase,
    developer: phase === 'review' ? 'developer-1' : null,
    branch: null,
    worktree: null,
    head: phase === 'review' ? 'h1' : null,
    base: phase === 'review' ? 'b1' : null,
    pr: null,
    prUrl: null,
    merge: null,
    reviews: [],
    feedback: [],
    attempts: 0,
    version: 0,
    error: null,
    updatedAt: Date.now(),
  });
  factory.repository.addTask(task);
  return { factory, store, task, directory: mesh.directory };
}

/**
 * The delivery's board column.
 *
 * @param view - Console projection.
 * @param task - Delivery.
 * @returns Its column.
 */
function columnOf(view: ConsoleView, task: FactoryTask): string | undefined {
  return view.deliveries.find((card) => card.taskId === task.id)?.column;
}

/**
 * Every card the Inbox targets is in Needs you.
 *
 * @param view - Console projection.
 */
function assertBoardMatchesInbox(view: ConsoleView): void {
  for (const card of view.deliveries) {
    const isTargeted = view.inbox.open.some((item) => item.taskId === card.taskId);
    assert.equal(card.column === 'needs_you', isTargeted && card.phase !== 'done', `#${String(card.issue)}`);
  }
  for (const card of view.objectives) {
    const isTargeted = isAwaitingHuman(view.inbox.open, { taskId: null, featureId: card.featureId });
    assert.equal(card.column === 'needs_you', isTargeted, card.title);
  }
}

await test('a delivery whose agent asked a question is in Needs you, as in the Inbox', async (t) => {
  const f = fixture(t, 'ready');
  assert.equal(columnOf(consoleView(f.factory.repository), f.task), 'ready');
  const actor = f.store.register({ ...registration('factory-developer-1'), runtime: 'factory-managed' });
  const job = jobSchema.parse({
    id: randomUUID(),
    role: 'developer-1',
    provider: 'codex',
    kind: 'develop',
    taskId: f.task.id,
    featureId: null,
    step: 'implement',
    token: randomUUID(),
    state: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    expiresAt: Date.now() + MINUTE,
    reservation: 0,
    usageTokens: null,
    pid: null,
    head: null,
    base: null,
    summary: null,
    artifact: f.directory,
  });
  assert.equal(f.factory.repository.claim(job, f.factory.repository.config() ?? assert.fail('configured')), true);
  await f.factory.execute(
    'factory_ask',
    { key: 'format', question: 'JSON or SQLite?', choices: ['JSON', 'SQLite'], allowText: false },
    actor.id,
  );
  f.factory.repository.finishJob(job, 0, 'succeeded');
  const view = consoleView(f.factory.repository);
  assert.ok(view.inbox.open.some((item) => item.kind === 'question' && item.taskId === f.task.id));
  assert.equal(columnOf(view, f.task), 'needs_you');
  assertBoardMatchesInbox(view);
});

await test('a delivery waiting on a checkpoint decision is in Needs you, as in the Inbox', (t) => {
  const f = fixture(t, 'review');
  const { repository } = f.factory;
  const job: FactoryJob = jobSchema.parse({
    id: randomUUID(),
    role: 'qa-1',
    provider: 'codex',
    kind: 'review',
    taskId: f.task.id,
    featureId: null,
    head: 'h1',
    base: 'b1',
    step: 'qa-1',
    token: randomUUID(),
    state: 'running',
    startedAt: 0,
    finishedAt: null,
    expiresAt: 0,
    reservation: 0,
    usageTokens: null,
    pid: null,
    summary: null,
    artifact: '',
  });
  run(
    repository.store.db,
    'INSERT INTO factory_jobs(id, role, state, data) VALUES (?, ?, ?, ?)',
    job.id,
    job.role,
    job.state,
    JSON.stringify(job),
  );
  assert.equal(columnOf(consoleView(repository), f.task), 'in_progress');
  askForDecision(repository, job, {
    state: 'held',
    extensions: 1,
    lastProgressAt: 9 * MINUTE,
    lastSignal: 'tool Bash',
    awaiting: null,
    nextCheckpointAt: 10 * MINUTE,
    ceilingAt: 25 * MINUTE,
    stopReason: 'no extension: codex quota reading is stale',
  });
  const stored = repository.jobs().find((candidate) => candidate.id === job.id);
  assert.ok(stored !== undefined);
  repository.saveJob({ ...stored, state: 'interrupted', finishedAt: 10 * MINUTE, failureClass: 'held' });
  const view = consoleView(repository);
  assert.ok(view.inbox.open.some((item) => item.kind === 'checkpoint' && item.taskId === f.task.id));
  assert.equal(columnOf(view, f.task), 'needs_you');
  assertBoardMatchesInbox(view);
});

await test('an objective-level item never places a delivery in Needs you', () => {
  const featureId = randomUUID();
  const open: InboxItem[] = [
    {
      id: `plan:${featureId}:plan`,
      kind: 'plan_approval',
      lane: 'reply',
      title: 'Approve plan',
      detail: '',
      since: 1,
      taskId: null,
      featureId,
      stepId: 'plan',
      head: null,
      requestId: null,
      questionId: null,
      choices: [],
      allowText: false,
    },
  ];
  assert.equal(isAwaitingHuman(open, { taskId: null, featureId }), true);
  assert.equal(isAwaitingHuman(open, { taskId: randomUUID(), featureId }), false);
  assert.equal(isAwaitingHuman(open, { taskId: null, featureId: randomUUID() }), false);
});
