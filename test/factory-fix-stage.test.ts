/**
 * Fix-stage workflow on real local Git: reviews feed a fixer who rules on every
 * finding, fixes are validated and published, a failed regression returns the
 * work to the fixer, and a passing regression readies the merge. No inference.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { completeJob } from '../src/factory/completion.ts';
import { startableSteps, taskWorkflow } from '../src/factory/pipeline.ts';
import { runProcess } from '../src/factory/processes.ts';
import { FactoryRepository } from '../src/factory/repository.ts';
import { factoryConfigSchema, jobSchema, taskSchema } from '../src/factory/schema.ts';
import { builtinWorkflows, workflowDigest } from '../src/factory/workflows.ts';
import { WorkspaceManager } from '../src/factory/workspaces.ts';
import { ProjectLearning } from '../src/learning.ts';
import { Store } from '../src/store.ts';

import { createCleanup, createProject } from './helpers.ts';

import type { FactoryContext, ExecutedJob } from '../src/factory/context.ts';
import type { AgentResult, FactoryJob, FactoryRole, FactoryTask } from '../src/factory/schema.ts';
import type { TestContext } from 'node:test';

/** A delivery that runs the built-in direct workflow on a real repository. */
interface Fixture {
  /** Project services with real Git and fixture remote effects. */
  readonly context: FactoryContext;
  /** Delivery identifier. */
  readonly taskId: string;
}

/**
 * Build a repository with a bare origin and a delivery running the direct workflow.
 *
 * @param t - Owns cleanup.
 * @returns Context and delivery.
 */
async function fixture(t: TestContext): Promise<Fixture> {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  const settings = factoryConfigSchema.parse({
    testCommands: [{ file: process.execPath }],
    endToEndCommands: [{ file: process.execPath }],
    maxAttempts: 3,
  });
  const workspaces = new WorkspaceManager(mesh, settings);
  await workspaces.git(['init', '--initial-branch=main']);
  await workspaces.git(['config', 'user.name', 'Fix fixture']);
  await workspaces.git(['config', 'user.email', 'fix@example.invalid']);
  await workspaces.git(['add', '.']);
  await workspaces.git(['commit', '-m', 'Fixture baseline']);
  const origin = path.join(mesh.directory, 'origin.git');
  await workspaces.git(['init', '--bare', origin]);
  await workspaces.git(['remote', 'add', 'origin', origin]);
  await workspaces.git(['push', '-u', 'origin', 'main']);
  const store = new Store(mesh);
  defer(() => {
    if (store.db.isOpen) {
      store.close();
    }
  });
  const repository = new FactoryRepository(store);
  repository.configure(settings);
  repository.prepareSender();
  const direct = builtinWorkflows().find((workflow) => workflow.id === 'direct');
  assert.ok(direct !== undefined);
  const task = taskSchema.parse({
    id: randomUUID(),
    featureId: null,
    issue: 4,
    parentIssue: 1,
    key: 'fix-stage',
    title: 'Greeting file',
    description: 'Write the greeting.',
    acceptanceCriteria: ['The greeting is correct.'],
    dependencies: [],
    phase: 'development',
    developer: 'developer-1',
    branch: null,
    worktree: null,
    head: null,
    base: null,
    pr: null,
    prUrl: null,
    merge: null,
    reviews: [],
    feedback: [],
    attempts: 1,
    version: 0,
    error: null,
    updatedAt: Date.now(),
    workflow: { id: direct.id, revision: workflowDigest(direct), workflow: direct },
  });
  repository.addTask(task);
  const context: FactoryContext = {
    mesh,
    home: mesh.root,
    settings,
    workspaces,
    repository,
    learning: new ProjectLearning(mesh),
    processes: runProcess,
    agent: async () => {
      await delay(0);
      throw new Error('This test drives completion directly and never calls inference.');
    },
    remote: {
      verify: async () => {
        await delay(0);
      },
      provision: async () => await delay(0, []),
      readyIssues: async () => await delay(0, []),
      inspect: async () => {
        await delay(0);
        throw new Error('Not inspected in this test.');
      },
      merge: async () => {
        await delay(0);
        throw new Error('Not merged in this test.');
      },
      effect: async () => {
        await delay(0);
      },
      issueState: async () => await delay(0, { state: 'open', stateReason: null }),
      parentComplete: async () => await delay(0, false),
      pullRequest: async () => {
        await delay(0);
        throw new Error('Publication is simulated in this test.');
      },
    },
  };
  return { context, taskId: task.id };
}

/**
 * Claim, complete and settle one attempt with a recorded result.
 *
 * @param fix - Fixture.
 * @param attempt - Seat, kind and workflow step.
 * @param attempt.role - Seat performing the step.
 * @param attempt.kind - Assignment kind.
 * @param attempt.step - Workflow step id.
 * @param result - Structured result to apply.
 * @returns The delivery afterwards.
 */
async function perform(
  fix: Fixture,
  attempt: { role: FactoryRole; kind: FactoryJob['kind']; step: string },
  result: Partial<AgentResult>,
): Promise<FactoryTask> {
  const { context } = fix;
  const task = context.repository.task(fix.taskId);
  const job = jobSchema.parse({
    id: randomUUID(),
    role: attempt.role,
    provider: 'claude',
    kind: attempt.kind,
    taskId: task.id,
    featureId: null,
    token: randomUUID(),
    state: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    expiresAt: Number.MAX_SAFE_INTEGER,
    reservation: 0,
    usageTokens: null,
    pid: null,
    head: task.head,
    base: task.base,
    summary: null,
    artifact: path.join(context.mesh.directory, 'factory', 'jobs', randomUUID()),
    step: attempt.step,
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
  return context.repository.task(fix.taskId);
}

/**
 * Write the greeting into the delivery's worktree, as an agent would.
 *
 * @param fix - Fixture.
 * @param text - New file content.
 */
async function writeGreeting(fix: Fixture, text: string): Promise<void> {
  const { worktree } = fix.context.repository.task(fix.taskId);
  assert.ok(worktree !== null);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixture-owned worktree created by this test.
  await writeFile(path.join(worktree, 'greeting.txt'), `${text}\n`);
}

/**
 * Simulate the unpaid PR publication that moves a published delivery to review.
 *
 * @param fix - Fixture.
 */
function publishPullRequest(fix: Fixture): void {
  fix.context.repository.editTask(fix.taskId, (current) => {
    return {
      ...current,
      phase: 'review',
      pr: 3,
      prUrl: 'https://github.com/fixture/app/pull/3',
    };
  });
}

/**
 * The ids of steps that may start now.
 *
 * @param fix - Fixture.
 * @returns Startable step ids.
 */
function startable(fix: Fixture): string[] {
  const task = fix.context.repository.task(fix.taskId);
  return startableSteps(task, taskWorkflow(task)).map((step) => step.id);
}

/**
 * Implement and publish the delivery, then complete both reviews.
 *
 * @param fix - Fixture.
 */
async function implementAndReview(fix: Fixture): Promise<void> {
  const { context } = fix;
  const prepared = await context.workspaces.developer(context.repository.task(fix.taskId));
  context.repository.editTask(fix.taskId, (current) => {
    return {
      ...current,
      branch: prepared.branch,
      worktree: prepared.directory,
      base: prepared.base,
    };
  });
  await writeGreeting(fix, 'hello wrold');
  const developed = await perform(fix, { role: 'developer-1', kind: 'develop', step: 'implement' }, {});
  assert.equal(developed.phase, 'publishing');
  assert.equal(developed.implementation?.head, developed.head);
  publishPullRequest(fix);
  assert.deepEqual(startable(fix), ['review', 'blind-review']);
  await perform(
    fix,
    { role: 'qa-1', kind: 'review', step: 'review' },
    { outcome: 'changes_requested', findings: ['[P1] greeting.txt:1 — "wrold" is misspelled — expected "world"'] },
  );
  const reviewed = await perform(fix, { role: 'qa-2', kind: 'review', step: 'blind-review' }, {});
  assert.equal(reviewed.phase, 'review');
  assert.deepEqual(startable(fix), ['fix']);
}

await test('a fixer rules on every finding, regressions loop back, and verified fixes reach merge readiness', async (t) => {
  const fix = await fixture(t);
  await implementAndReview(fix);
  const implementation = fix.context.repository.task(fix.taskId).implementation?.head;

  await writeGreeting(fix, 'hello world!');
  const fixed = await perform(
    fix,
    { role: 'fixer', kind: 'adjudicate', step: 'fix' },
    {
      dispositions: [
        { id: 'review-1', decision: 'adopted', reason: 'Real typo', evidence: 'greeting.txt now says world' },
      ],
    },
  );
  assert.equal(fixed.phase, 'publishing');
  assert.notEqual(fixed.head, implementation);
  assert.equal(fixed.stepResults.at(-1)?.stepId, 'fix');
  publishPullRequest(fix);
  assert.deepEqual(startable(fix), ['regress']);

  const failed = await perform(
    fix,
    { role: 'regression-verifier', kind: 'regress', step: 'regress' },
    { outcome: 'changes_requested', findings: ['review-1: the stray "!" is not in the expected greeting'] },
  );
  assert.equal(failed.phase, 'review');
  assert.match(failed.feedback.join('\n'), /stray "!"/v);
  assert.deepEqual(startable(fix), ['fix']);

  await writeGreeting(fix, 'hello world');
  await perform(
    fix,
    { role: 'fixer', kind: 'adjudicate', step: 'fix' },
    { dispositions: [{ id: 'review-1', decision: 'adopted', reason: 'Typo', evidence: 'Exact greeting restored' }] },
  );
  publishPullRequest(fix);
  const verified = await perform(fix, { role: 'regression-verifier', kind: 'regress', step: 'regress' }, {});
  assert.equal(verified.phase, 'merge_ready');
  assert.equal(verified.implementation?.head, implementation);
  assert.deepEqual(
    verified.reviews.map((review) => [review.stepId, review.head === implementation]),
    [
      ['review', true],
      ['blind-review', true],
    ],
  );
});

await test('a fixer that skips a finding is stopped for an operator decision', async (t) => {
  const fix = await fixture(t);
  await implementAndReview(fix);
  const stopped = await perform(fix, { role: 'fixer', kind: 'adjudicate', step: 'fix' }, { dispositions: [] });
  assert.equal(stopped.phase, 'blocked');
  assert.match(stopped.error ?? '', /review-1 needs exactly one disposition/v);
});

await test('supervisor commits record the delivery, step, seat and attempt as trailers', async (t) => {
  const fix = await fixture(t);
  await implementAndReview(fix);
  await writeGreeting(fix, 'hello world');
  await perform(
    fix,
    { role: 'fixer', kind: 'adjudicate', step: 'fix' },
    { dispositions: [{ id: 'review-1', decision: 'adopted', reason: 'Typo', evidence: 'Fixed' }] },
  );
  const { worktree } = fix.context.repository.task(fix.taskId);
  assert.ok(worktree !== null);
  const log = await fix.context.workspaces.git(['log', '--format=%s%n%b', '-n', '2'], worktree);
  assert.match(log, /^Fix review findings for #4: Greeting file/v);
  assert.match(log, /X-MALT-Step: fix\nX-MALT-Role: fixer\nX-MALT-Attempt: [\d\-a-f]{36}/v);
  assert.match(
    log,
    /Deliver #4: Greeting file\nX-MALT-Delivery: #4\nX-MALT-Step: implement\nX-MALT-Role: developer-1/v,
  );
});
