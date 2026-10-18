/**
 * Full-assurance planning: specification, atomic plan, independent plan review
 * and a fresh revision that must rule on every finding before provisioning.
 * Results are applied directly; no inference runs.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { completeJob } from '../src/factory/completion.ts';
import { queueObjective } from '../src/factory/objectives.ts';
import { runProcess } from '../src/factory/processes.ts';
import { FactoryRepository } from '../src/factory/repository.ts';
import { jobIntents } from '../src/factory/scheduler.ts';
import { factoryConfigSchema, jobSchema } from '../src/factory/schema.ts';
import { WorkspaceManager } from '../src/factory/workspaces.ts';
import { ProjectLearning } from '../src/learning.ts';
import { Store } from '../src/store.ts';

import { createCleanup, createProject } from './helpers.ts';

import type { FactoryContext, ExecutedJob } from '../src/factory/context.ts';
import type { JobIntent } from '../src/factory/scheduler.ts';
import type { AgentResult, Feature } from '../src/factory/schema.ts';
import type { TestContext } from 'node:test';

/** One planned delivery, as a lead would return it. */
const delivery = {
  key: 'greeting',
  title: 'Greeting',
  description: 'Show a greeting.',
  acceptanceCriteria: ['The greeting is visible.'],
  dependencies: [],
  capabilityTier: null,
  skills: [],
};

/**
 * A project ledger with a full-assurance objective queued.
 *
 * @param t - Owns cleanup.
 * @returns Context and objective id.
 */
function fixture(t: TestContext): { context: FactoryContext; featureId: string } {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  const store = new Store(mesh);
  defer(() => {
    store.close();
  });
  const settings = factoryConfigSchema.parse({
    testCommands: [{ file: process.execPath }],
    endToEndCommands: [{ file: process.execPath }],
  });
  const repository = new FactoryRepository(store);
  repository.configure(settings);
  repository.prepareSender();
  const { featureId } = queueObjective(repository, { objective: 'Greet visitors', workflowId: 'full-assurance' });
  const context: FactoryContext = {
    mesh,
    home: mesh.root,
    settings,
    workspaces: new WorkspaceManager(mesh, settings),
    repository,
    learning: new ProjectLearning(mesh),
    processes: runProcess,
    agent: async () => {
      await delay(0);
      throw new Error('Planning results are applied directly in this test.');
    },
    remote: {
      verify: async () => {
        await delay(0);
      },
      provision: async () => await delay(0, []),
      readyIssues: async () => await delay(0, []),
      inspect: async () => {
        await delay(0);
        throw new Error('Not used.');
      },
      merge: async () => {
        await delay(0);
        throw new Error('Not used.');
      },
      effect: async () => {
        await delay(0);
      },
      issueState: async () => await delay(0, { state: 'open', stateReason: null }),
      parentComplete: async () => await delay(0, false),
      pullRequest: async () => {
        await delay(0);
        throw new Error('Not used.');
      },
    },
  };
  return { context, featureId };
}

/**
 * The objective now.
 *
 * @param context - Project ledger.
 * @param featureId - Identifier of the objective to load.
 * @returns Stored objective.
 */
function objective(context: FactoryContext, featureId: string): Feature {
  const found = context.repository.features().find((feature) => feature.id === featureId);
  assert.ok(found !== undefined);
  return found;
}

/**
 * The scheduler's next planning intent.
 *
 * @param context - Project ledger.
 * @returns First intent.
 */
function nextIntent(context: FactoryContext): JobIntent {
  const [intent] = jobIntents({
    config: context.settings,
    tasks: context.repository.tasks(),
    features: context.repository.features(),
    jobs: context.repository.jobs(),
    skillRequests: [],
    now: context.repository.store.now(),
  });
  assert.ok(intent !== undefined);
  return intent;
}

/**
 * Claim the next planning intent and apply a recorded result.
 *
 * @param context - Project ledger.
 * @param result - Result fields to apply.
 * @returns The intent that ran.
 */
async function perform(context: FactoryContext, result: Partial<AgentResult>): Promise<JobIntent> {
  const intent = nextIntent(context);
  const job = jobSchema.parse({
    ...intent,
    id: randomUUID(),
    provider: 'codex',
    token: randomUUID(),
    state: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    expiresAt: Number.MAX_SAFE_INTEGER,
    reservation: 0,
    usageTokens: null,
    pid: null,
    summary: null,
    artifact: path.join(context.mesh.directory, 'factory', 'jobs', randomUUID()),
    target: null,
  });
  assert.equal(context.repository.claim(job, context.settings), true);
  const execution: ExecutedJob = {
    completion: {
      result: {
        outcome: 'success',
        summary: 'Done',
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
  context.repository.saveJob({ ...job, state: 'succeeded', finishedAt: Date.now() });
  return intent;
}

/**
 * Run specification and planning, returning the review intent that follows.
 *
 * @param context - Project ledger.
 * @returns The plan review intent.
 */
async function specifyAndPlan(context: FactoryContext): Promise<JobIntent> {
  const specify = await perform(context, { deliveries: [delivery] });
  assert.deepEqual([specify.role, specify.kind, specify.step], ['product-owner', 'plan', 'specify']);
  const plan = await perform(context, { deliveries: [delivery] });
  assert.deepEqual([plan.role, plan.kind, plan.step], ['team-lead', 'refine', 'plan']);
  const review = nextIntent(context);
  assert.deepEqual(
    [review.role, review.kind, review.step, review.preferredProvider],
    ['plan-reviewer', 'plan_review', 'plan-review', 'codex'],
  );
  return review;
}

await test('a reviewed plan is revised with a ruling on every finding before provisioning', async (t) => {
  const { context, featureId } = fixture(t);
  await specifyAndPlan(context);
  await perform(context, {
    outcome: 'changes_requested',
    findings: ['[P1] greeting has no failing check named', '[P2] consider splitting the copy change'],
  });
  assert.equal(objective(context, featureId).phase, 'refining');
  const revise = nextIntent(context);
  assert.deepEqual([revise.role, revise.kind, revise.step], ['team-lead', 'refine', 'plan-revise']);
  await perform(context, {
    deliveries: [{ ...delivery, acceptanceCriteria: ['The greeting test fails today and passes after.'] }],
    dispositions: [
      { id: 'plan-review-1', decision: 'adopted', reason: 'Valid', evidence: 'Acceptance names the check' },
      { id: 'plan-review-2', decision: 'rejected', reason: 'Already one small delivery', evidence: '' },
    ],
  });
  const planned = objective(context, featureId);
  assert.equal(planned.phase, 'provisioning');
  assert.deepEqual(planned.plan?.deliveries[0]?.acceptanceCriteria, [
    'The greeting test fails today and passes after.',
  ]);
});

await test('a revision that leaves a finding unruled stops planning for a decision', async (t) => {
  const { context, featureId } = fixture(t);
  await specifyAndPlan(context);
  await perform(context, { outcome: 'changes_requested', findings: ['[P1] missing failing check'] });
  await perform(context, { deliveries: [delivery], dispositions: [] });
  const stopped = objective(context, featureId);
  assert.equal(stopped.phase, 'blocked');
  assert.match(stopped.error ?? '', /plan-review-1 needs exactly one disposition/v);
});

await test('a clean plan review skips the revision', async (t) => {
  const { context, featureId } = fixture(t);
  await specifyAndPlan(context);
  await perform(context, { outcome: 'success', findings: [] });
  assert.equal(objective(context, featureId).phase, 'provisioning');
});
