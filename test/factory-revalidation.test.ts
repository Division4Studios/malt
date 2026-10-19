/**
 * Brief revalidation for bound predecessors: the lead rechecks a dependent
 * delivery's brief once its predecessors merged, before implementation, and
 * a brief that needs revising stops the delivery for the operator.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import test from 'node:test';

import { completeJob } from '../src/factory/completion.ts';
import { consoleView } from '../src/factory/console-view.ts';
import { deliveryTask } from '../src/factory/reconcile.ts';
import { retryBlocked } from '../src/factory/recovery.ts';
import { FactoryRepository } from '../src/factory/repository.ts';
import { revalidationIntents } from '../src/factory/revalidation.ts';
import { routeAssignment } from '../src/factory/routing.ts';
import { jobIntents } from '../src/factory/scheduler.ts';
import { factoryConfigSchema, jobSchema } from '../src/factory/schema.ts';
import { sealSource } from '../src/factory/source-reader.ts';
import { WorkspaceManager } from '../src/factory/workspaces.ts';
import { ProjectLearning } from '../src/learning.ts';
import { Store } from '../src/store.ts';

import { createCleanup, createProject } from './helpers.ts';

import type { ExecutedJob, FactoryContext } from '../src/factory/context.ts';
import type { JobIntent } from '../src/factory/scheduler.ts';
import type { AgentResult, FactoryTask } from '../src/factory/schema.ts';
import type { TestContext } from 'node:test';

/** Merge commit of the predecessor. */
const MERGE = 'a'.repeat(40);
/** Main the lead read. */
const MAIN = 'b'.repeat(40);

/**
 * Fail if a test reaches a provider or GitHub.
 *
 * @returns Never; always rejects.
 */
async function reject(): Promise<never> {
  await Promise.resolve();
  throw new Error('Not used.');
}

/**
 * A ledger with one merged predecessor and one dependent delivery.
 *
 * @param t - Owns cleanup.
 * @param isEnabled - Whether the project enables brief revalidation.
 * @returns Context and both deliveries.
 */
function fixture(t: TestContext, isEnabled = true): { context: FactoryContext; dependent: FactoryTask } {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  const store = new Store(mesh);
  defer(() => {
    store.close();
  });
  const settings = factoryConfigSchema.parse({
    testCommands: [{ file: process.execPath }],
    endToEndCommands: [{ file: process.execPath }],
    briefRevalidation: isEnabled,
  });
  const repository = new FactoryRepository(store);
  repository.configure(settings);
  repository.prepareSender();
  const context: FactoryContext = {
    mesh,
    home: mesh.root,
    settings,
    workspaces: new WorkspaceManager(mesh, settings),
    repository,
    learning: new ProjectLearning(mesh),
    processes: reject,
    agent: reject,
    remote: {
      verify: reject,
      provision: reject,
      readyIssues: reject,
      inspect: reject,
      merge: reject,
      effect: reject,
      issueState: reject,
      parentComplete: reject,
      pullRequest: reject,
    },
  };
  const issue = { parentIssue: 1, description: 'Bounded.', acceptanceCriteria: ['Visible'] };
  const predecessor = deliveryTask(context, { ...issue, issue: 2, title: 'Store greetings' }, null);
  repository.addTask({ ...predecessor, phase: 'done', merge: MERGE });
  const dependent = deliveryTask(context, { ...issue, issue: 3, title: 'Show greetings' }, null);
  repository.addTask({ ...dependent, dependencies: [predecessor.id] });
  const independent = deliveryTask(context, { ...issue, issue: 4, title: 'Unrelated' }, null);
  repository.addTask(independent);
  return { context, dependent: repository.task(dependent.id) };
}

/**
 * The scheduler's current intents.
 *
 * @param context - Project ledger to schedule from.
 * @returns Ordered candidate assignments.
 */
function intents(context: FactoryContext): JobIntent[] {
  return jobIntents({
    config: context.settings,
    tasks: context.repository.tasks(),
    features: context.repository.features(),
    jobs: context.repository.jobs(),
    skillRequests: [],
    now: context.repository.store.now(),
  });
}

/**
 * Claim the revalidation intent and apply a recorded lead result.
 *
 * @param context - Project ledger.
 * @param result - Result fields.
 */
async function revalidate(context: FactoryContext, result: Partial<AgentResult>): Promise<void> {
  const intent = intents(context).find((candidate) => candidate.kind === 'revalidate');
  assert.ok(intent !== undefined);
  const job = jobSchema.parse({
    ...intent,
    target: null,
    id: randomUUID(),
    provider: 'codex',
    token: randomUUID(),
    state: 'running',
    startedAt: 1,
    finishedAt: null,
    expiresAt: Number.MAX_SAFE_INTEGER,
    reservation: 0,
    usageTokens: null,
    pid: null,
    summary: null,
    artifact: path.join(context.mesh.directory, 'factory', 'jobs', randomUUID()),
  });
  assert.equal(context.repository.claim(job, context.settings), true);
  sealSource(context.repository, job, { directory: context.mesh.root, head: MAIN, status: '' });
  const execution: ExecutedJob = {
    completion: {
      result: {
        outcome: 'success',
        summary: 'Brief holds.',
        findings: [],
        deliveries: [],
        skillActions: [],
        instructionReceipts: [],
        ...result,
      },
      usageTokens: null,
      cooldownUntil: 0,
      subscriptionUsedPercent: null,
      subscriptionResetAt: null,
      process: { exitCode: 0, stdout: '', stderr: '', interrupted: false },
    },
    snapshot: null,
    checks: [],
    waiting: null,
  };
  const controller = new AbortController();
  await completeJob(context, job, execution, controller.signal);
  context.repository.saveJob({ ...job, state: 'succeeded', finishedAt: 2 });
}

/**
 * Kinds offered for one delivery.
 *
 * @param context - Project ledger.
 * @param taskId - Delivery.
 * @returns Offered kinds, deduplicated.
 */
function offered(context: FactoryContext, taskId: string): string[] {
  return [
    ...new Set(
      intents(context)
        .filter((intent) => intent.taskId === taskId)
        .map((intent) => intent.kind),
    ),
  ];
}

await test('without the project setting a dependent delivery starts implementation directly', (t) => {
  const { context, dependent } = fixture(t, false);
  assert.deepEqual(offered(context, dependent.id), ['develop']);
});

await test('a confirmed brief is recorded against the predecessor merges and then implemented', async (t) => {
  const { context, dependent } = fixture(t);
  const lead = intents(context).filter((intent) => intent.kind === 'revalidate');
  assert.deepEqual(
    lead.map((intent) => [intent.role, intent.taskId]),
    [['team-lead', dependent.id]],
  );
  assert.deepEqual(offered(context, dependent.id), ['revalidate']);
  const routing = routeAssignment({
    intent: lead[0] ?? assert.fail('missing intent'),
    provider: 'codex',
    settings: context.settings,
    task: dependent,
  });
  assert.equal(routing.tier, 'small');
  await revalidate(context, { outcome: 'success', summary: 'Brief holds.' });
  const verdict = context.repository.task(dependent.id).revalidation;
  assert.ok(verdict !== null);
  assert.equal(verdict.outcome, 'confirmed');
  assert.equal(verdict.source, MAIN);
  assert.deepEqual(
    verdict.predecessors.map((entry) => entry.merge),
    [MERGE],
  );
  assert.deepEqual(offered(context, dependent.id), ['develop']);
  const card = consoleView(context.repository).deliveries.find((delivery) => delivery.taskId === dependent.id);
  assert.equal(card?.revalidation?.outcome, 'confirmed');
});

await test('a brief that needs revising stops the delivery until the operator retries it', async (t) => {
  const { context, dependent } = fixture(t);
  await revalidate(context, {
    outcome: 'changes_requested',
    summary: 'The store returns ids, not names.',
    findings: ['[P1] Acceptance names a field the predecessor did not add.'],
  });
  const stopped = context.repository.task(dependent.id);
  assert.equal(stopped.phase, 'blocked');
  assert.equal(stopped.revalidation?.outcome, 'revise');
  assert.match(stopped.error ?? '', /Brief revalidation proposes changes: The store returns ids/v);
  assert.deepEqual(offered(context, dependent.id), []);
  retryBlocked(context.repository, { taskId: dependent.id });
  assert.deepEqual(offered(context, dependent.id), ['develop']);
});

await test('an unfinished predecessor delays both revalidation and implementation', (t) => {
  const { context, dependent } = fixture(t);
  const [predecessorId] = dependent.dependencies;
  assert.ok(predecessorId !== undefined);
  context.repository.editTask(predecessorId, (current) => ({ ...current, phase: 'verifying' }));
  assert.deepEqual(offered(context, dependent.id), []);
});

await test('a long verdict is recorded bounded, and ineligible deliveries are not chosen', async (t) => {
  const { context, dependent } = fixture(t);
  const state = {
    config: context.settings,
    tasks: context.repository.tasks(),
    jobs: context.repository.jobs(),
    now: context.repository.store.now(),
  };
  assert.equal(revalidationIntents(state, []).length, 1);
  assert.deepEqual(
    revalidationIntents({ ...state, isSpendBlocked: () => true }, []),
    [],
    'A spend-blocked delivery waits.',
  );
  assert.deepEqual(
    revalidationIntents({ ...state, objectiveQueue: { focusedFeatureId: 'another-objective' } }, []),
    [],
    'Only the focused objective is revalidated.',
  );
  assert.equal(
    revalidationIntents({ ...state, objectiveQueue: { focusedFeatureId: 'another-objective', existingOnly: true } }, [])
      .length,
    1,
    'Existing-delivery recovery revalidates retained deliveries of every objective.',
  );
  await revalidate(context, { outcome: 'success', summary: 'x'.repeat(5000), findings: ['y'.repeat(5000)] });
  const verdict = context.repository.task(dependent.id).revalidation;
  assert.equal(verdict?.outcome, 'confirmed', 'A paid result longer than the record allows is kept, bounded.');
  assert.equal(verdict.summary.length, 4000);
  assert.equal(verdict.findings[0]?.length, 4000);
});
