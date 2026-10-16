/** @file Console projection: board columns, step states and the unified Inbox. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { consoleView } from '../src/factory/console-view.ts';
import { queueObjective } from '../src/factory/objectives.ts';
import { FactoryRepository } from '../src/factory/repository.ts';
import { factoryConfigSchema, taskSchema } from '../src/factory/schema.ts';
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
  const shipped = delivery(repository, { phase: 'done', dependencies: [] });
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
