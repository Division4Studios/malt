/** @file Console projection: board columns, step states and the unified Inbox. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { consoleView } from '../src/factory/console-view.ts';
import {
  archiveDeliveries,
  AUTO_ARCHIVE_MS,
  holdDeliveries,
  isClaimEligible,
} from '../src/factory/delivery-controls.ts';
import { queueObjective } from '../src/factory/objectives.ts';
import { FactoryRepository } from '../src/factory/repository.ts';
import { factoryConfigSchema, jobSchema, taskSchema } from '../src/factory/schema.ts';
import { builtinWorkflows, workflowDigest, workflowSchema } from '../src/factory/workflows.ts';
import { Store } from '../src/store.ts';

import { createCleanup, createProject } from './helpers.ts';

import type { FactoryTask } from '../src/factory/schema.ts';
import type { Workflow } from '../src/factory/workflows.ts';
import type { TestContext } from 'node:test';

/** Quick review, then a human sign-off before the final check. */
const signOff: Workflow = (() => {
  const quick = builtinWorkflows().find((workflow) => workflow.id === 'quick');
  assert.ok(quick !== undefined);
  const [implement, review, final, verify] = quick.delivery;
  assert.ok(implement !== undefined && review !== undefined && final !== undefined && verify !== undefined);
  return workflowSchema.parse({
    ...quick,
    id: 'sign-off',
    delivery: [
      implement,
      review,
      { id: 'sign-off', kind: 'approve', title: 'Sign off', after: ['review'] },
      { ...final, after: ['sign-off'] },
      verify,
    ],
  });
})();

/**
 * A configured project ledger.
 *
 * @param t - Owns cleanup.
 * @returns Repository with settings saved.
 */
function project(t: TestContext): FactoryRepository {
  const defer = createCleanup(t);
  const store = new Store(createProject(defer));
  defer(() => {
    store.close();
  });
  const repository = new FactoryRepository(store);
  repository.configure(
    factoryConfigSchema.parse({
      testCommands: [{ file: process.execPath }],
      endToEndCommands: [{ file: process.execPath }],
    }),
  );
  repository.prepareSender();
  return repository;
}

/**
 * Store a delivery running the sign-off workflow.
 *
 * @param repository - Project ledger.
 * @param overrides - Scenario state.
 * @returns Stored delivery.
 */
function delivery(repository: FactoryRepository, overrides: Partial<FactoryTask>): FactoryTask {
  const task = taskSchema.parse({
    id: randomUUID(),
    featureId: null,
    issue: repository.tasks().length + 10,
    parentIssue: 1,
    key: `key-${String(repository.tasks().length)}`,
    title: 'Card',
    description: 'Card',
    acceptanceCriteria: ['Works'],
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
    updatedAt: 1,
    workflow: { id: signOff.id, revision: workflowDigest(signOff), workflow: signOff },
    ...overrides,
  });
  repository.addTask(task);
  return task;
}

await test('the board places deliveries by what they need next and the Inbox lists every decision', (t) => {
  const repository = project(t);
  const ready = delivery(repository, {});
  const waiting = delivery(repository, {
    phase: 'review',
    developer: 'developer-1',
    head: 'h',
    base: 'b',
    pr: 3,
    reviews: [
      { role: 'qa-1', stepId: 'review', head: 'h', base: 'b', outcome: 'success', summary: 'ok', jobId: randomUUID() },
    ],
  });
  const blocked = delivery(repository, { phase: 'blocked', error: 'Tests fail on main' });
  const shipped = delivery(repository, { phase: 'done', dependencies: [], updatedAt: repository.store.now() });
  const dependent = delivery(repository, { dependencies: [ready.id] });
  queueObjective(repository, { objective: '# Billing: retry charges\n\nDetails', workflowId: 'full-assurance' });

  const view = consoleView(repository);
  const columns = new Map(view.deliveries.map((card) => [card.taskId, card.column]));
  assert.equal(columns.get(ready.id), 'ready');
  assert.equal(columns.get(waiting.id), 'needs_you');
  assert.equal(columns.get(blocked.id), 'needs_you');
  assert.equal(columns.get(shipped.id), 'done');
  assert.deepEqual(view.deliveries.find((card) => card.taskId === dependent.id)?.waitingOn, [ready.issue]);

  const waitingCard = view.deliveries.find((card) => card.taskId === waiting.id);
  assert.ok(waitingCard !== undefined);
  assert.deepEqual(
    waitingCard.steps.map((step) => [step.id, step.state]),
    [
      ['implement', 'done'],
      ['review', 'done'],
      ['sign-off', 'needs_you'],
      ['final', 'waiting'],
      ['verify', 'waiting'],
    ],
  );
  assert.equal(waitingCard.steps[1]?.result?.summary, 'ok');

  const [planning] = view.objectives;
  assert.ok(planning !== undefined);
  assert.equal(planning.title, 'Billing: retry charges');
  assert.equal(planning.column, 'planning');
  assert.deepEqual(
    planning.steps.map((step) => step.state),
    ['ready', 'waiting', 'waiting', 'waiting'],
  );

  assert.deepEqual(
    view.inbox.open.map((item) => [item.kind, item.taskId, item.stepId, item.head]),
    [
      ['approval', waiting.id, 'sign-off', 'h'],
      ['blocked_delivery', blocked.id, null, null],
    ],
  );
});

await test('held deliveries start no new attempts and finished ones leave the board', (t) => {
  const repository = project(t);
  const first = delivery(repository, {});
  const second = delivery(repository, {});
  const recent = delivery(repository, { phase: 'done', updatedAt: repository.store.now() });
  const old = delivery(repository, { phase: 'done', updatedAt: repository.store.now() - AUTO_ARCHIVE_MS });

  assert.deepEqual(holdDeliveries(repository, { all: true, hold: true, reason: 'Release freeze' }), {
    changed: 2,
    skipped: [],
  });
  const held = consoleView(repository).deliveries.find((card) => card.taskId === first.id);
  assert.equal(held?.held?.reason, 'Release freeze');
  const claim = jobSchema.parse({
    id: randomUUID(),
    role: 'developer-1',
    provider: 'codex',
    kind: 'develop',
    taskId: first.id,
    featureId: null,
    token: randomUUID(),
    state: 'running',
    startedAt: 1,
    finishedAt: null,
    expiresAt: 2,
    reservation: 1,
    usageTokens: null,
    pid: null,
    head: null,
    base: null,
    summary: null,
    artifact: 'fixture',
  });
  assert.equal(isClaimEligible(repository, claim), false, 'A hold also fences a claim scheduled before it.');
  assert.equal(isClaimEligible(repository, { ...claim, taskId: second.id }), false);
  assert.deepEqual(holdDeliveries(repository, { taskIds: [second.id, recent.id], hold: false }), {
    changed: 1,
    skipped: [{ taskId: recent.id, reason: 'Already finished.' }],
  });
  assert.throws(() => holdDeliveries(repository, { taskIds: [first.id], all: true, hold: true }), /exactly one/v);

  const board = (): string[] => consoleView(repository).deliveries.map((card) => card.taskId);
  assert.ok(board().includes(recent.id));
  assert.ok(!board().includes(old.id), 'Finished deliveries archive themselves after a week.');
  assert.equal(consoleView(repository).archived.total, 1);
  assert.deepEqual(
    consoleView(repository).archived.recent.map((entry) => entry.taskId),
    [old.id],
  );
  archiveDeliveries(repository, { taskIds: [old.id], archive: false });
  archiveDeliveries(repository, { taskIds: [recent.id], archive: true });
  assert.ok(board().includes(old.id), 'Unarchiving keeps a delivery on the board.');
  assert.ok(!board().includes(recent.id));
  assert.equal(archiveDeliveries(repository, { taskIds: [first.id], archive: true }).skipped.length, 1);
});
