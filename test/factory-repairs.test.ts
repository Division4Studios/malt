/**
 * CI-failure and merge-conflict repair rounds: log extraction and redaction,
 * idempotent bounded rounds, real Git conflicts and repair-aware scheduling.
 * No paid inference and no network.
 *
 * @file
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { actionsJobId, checkState, ciFinding, excerptLog, failedChecks, redactLog } from '../src/factory/ci-logs.ts';
import { MergeConflictError } from '../src/factory/merge-conflict.ts';
import { runProcess } from '../src/factory/processes.ts';
import { reconcile } from '../src/factory/reconcile.ts';
import { REPAIR_FINDING_MAX, attemptBudget } from '../src/factory/repair-schema.ts';
import { recordConflict } from '../src/factory/repairs.ts';
import { FactoryRepository } from '../src/factory/repository.ts';
import { jobIntents } from '../src/factory/scheduler.ts';
import { factoryConfigSchema, featureSchema, taskSchema } from '../src/factory/schema.ts';
import { WorkspaceManager } from '../src/factory/workspaces.ts';
import { ProjectLearning } from '../src/learning.ts';
import { Store } from '../src/store.ts';

import { createCleanup, createProject } from './helpers.ts';

import type { CheckLog, CheckState, RawCheck } from '../src/factory/ci-logs.ts';
import type { FactoryContext } from '../src/factory/context.ts';
import type { PullRequest } from '../src/factory/remote.ts';
import type { FactoryConfig, FactoryEffect, FactoryTask } from '../src/factory/schema.ts';
import type { TestContext } from 'node:test';

/** A GitHub token shape the redactor must remove. */
const LEAKED = `ghp_${'a1B2c3D4'.repeat(5)}`;
/** A failed Actions job as GitHub reports it in the rollup. */
const FAILED_CHECK: RawCheck = {
  name: 'check (ubuntu-latest)',
  status: 'COMPLETED',
  conclusion: 'FAILURE',
  detailsUrl: 'https://github.com/fixture/app/actions/runs/7/job/42',
};
/** A passing check alongside it. */
const PASSING_CHECK: RawCheck = { name: 'docker', status: 'COMPLETED', conclusion: 'SUCCESS' };

/** A fixture with real Git, durable state and a scriptable remote. */
interface Fixture {
  /** Factory services. */
  readonly context: FactoryContext;
  /** The delivery under test. */
  readonly task: FactoryTask;
  /** Change what the remote reports. */
  readonly setPr: (change: Partial<PullRequest>) => void;
  /** Checks whose logs were requested. */
  readonly requested: CheckState[][];
  /** Remote effects the reconciler sent. */
  readonly sent: FactoryEffect[];
}

/**
 * Build a repository with a bare remote, a delivery in review and a scriptable PR.
 *
 * @param t - Owns cleanup.
 * @param overrides - Project policy changes.
 * @returns Fixture services.
 */
async function repairFixture(t: TestContext, overrides: Record<string, unknown> = {}): Promise<Fixture> {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  const settings = factoryConfigSchema.parse({
    testCommands: [{ file: process.execPath, args: ['-e', ''] }],
    endToEndCommands: [{ file: process.execPath, args: ['-e', ''] }],
    ...overrides,
  });
  const workspaces = new WorkspaceManager(mesh, settings);
  await workspaces.git(['init', '--initial-branch=main']);
  await workspaces.git(['config', 'user.name', 'Repair fixture']);
  await workspaces.git(['config', 'user.email', 'repair@example.invalid']);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixture writes only inside its temporary project.
  await writeFile(path.join(mesh.root, 'shared.txt'), 'original\n');
  await workspaces.git(['add', '.']);
  await workspaces.git(['commit', '-m', 'Fixture baseline']);
  const origin = path.join(mesh.directory, 'origin.git');
  await workspaces.git(['init', '--bare', origin]);
  await workspaces.git(['remote', 'add', 'origin', origin]);
  await workspaces.git(['push', '-u', 'origin', 'main']);
  const head = await workspaces.base();
  const store = new Store(mesh);
  defer(() => {
    if (store.db.isOpen) {
      store.close();
    }
  });
  const repository = new FactoryRepository(store);
  repository.configure(settings);
  repository.prepareSender();
  repository.setActive(true);
  const initial: PullRequest = {
    number: 3,
    url: 'https://github.com/fixture/app/pull/3',
    headRefOid: head,
    baseRefOid: head,
    baseRefName: 'main',
    isDraft: false,
    state: 'OPEN',
    mergeStateStatus: 'BLOCKED',
    mergeCommit: null,
    statusCheckRollup: [FAILED_CHECK, PASSING_CHECK],
  };
  let current = initial;
  const task = taskSchema.parse({
    id: randomUUID(),
    featureId: null,
    issue: 2,
    parentIssue: 1,
    key: 'repair',
    title: 'Repairable change',
    description: 'One observable outcome.',
    acceptanceCriteria: ['Observable behavior passes.'],
    dependencies: [],
    phase: 'review',
    developer: 'developer-1',
    branch: null,
    worktree: null,
    head,
    base: head,
    pr: 3,
    prUrl: initial.url,
    merge: null,
    reviews: [{ role: 'qa-1', head, base: head, outcome: 'success', summary: 'Approved.', jobId: randomUUID() }],
    feedback: [],
    attempts: 1,
    version: 0,
    error: null,
    updatedAt: Date.now(),
  });
  repository.addTask(task);
  const requested: CheckState[][] = [];
  const sent: FactoryEffect[] = [];
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
      throw new Error('Repairs must not call paid inference.');
    },
    remote: {
      verify: async () => {
        await delay(0);
      },
      provision: async () => await delay(0, []),
      readyIssues: async () => await delay(0, []),
      inspect: async () => await delay(0, current),
      merge: async () => {
        await delay(0);
        throw new Error('Failing work must never merge.');
      },
      effect: async (effect) => {
        sent.push(effect);
        await delay(0);
      },
      issueState: async () => await delay(0, { state: 'open', stateReason: null }),
      parentComplete: async () => await delay(0, false),
      pullRequest: async () => {
        await delay(0);
        throw new Error('Repairs must not create a PR.');
      },
      checkLogs: async (checks: readonly CheckState[]): Promise<CheckLog[]> => {
        requested.push([...checks]);
        return await delay(
          0,
          checks.map((check) => ({ name: check.name, text: null })),
        );
      },
    },
  };
  return {
    context,
    task,
    setPr: (change) => {
      current = { ...current, ...change };
    },
    requested,
    sent,
  };
}

/**
 * Put the delivery back in review on a given head, as a republication would.
 *
 * @param fixture - Test fixture.
 * @param head - Published head.
 */
function republish(fixture: Fixture, head: string): void {
  fixture.context.repository.editTask(fixture.task.id, (current) => ({ ...current, phase: 'review', head }));
  fixture.setPr({ headRefOid: head });
}

await test('check states: pending waits, cancelled and skipped never count, failures are unique by name', () => {
  assert.equal(checkState({ name: 'a', status: 'IN_PROGRESS', conclusion: null }).state, 'pending');
  assert.equal(checkState({ context: 'ci/legacy', state: 'PENDING' }).state, 'pending');
  assert.equal(checkState({ name: 'a', status: 'COMPLETED', conclusion: 'CANCELLED' }).state, 'ignored');
  assert.equal(checkState({ context: 'ci/legacy', state: 'ERROR' }).state, 'failed');
  assert.equal(checkState({ name: 'a', status: 'COMPLETED', conclusion: 'TIMED_OUT' }).state, 'failed');
  assert.equal(failedChecks([FAILED_CHECK, { name: 'b', status: 'QUEUED' }]), null);
  assert.deepEqual(failedChecks([{ name: 'a', status: 'COMPLETED', conclusion: 'CANCELLED' }, PASSING_CHECK]), []);
  assert.deepEqual(
    failedChecks([FAILED_CHECK, FAILED_CHECK, { context: 'a-legacy', state: 'FAILURE' }])?.map((check) => check.name),
    ['a-legacy', 'check (ubuntu-latest)'],
  );
  assert.equal(actionsJobId(FAILED_CHECK.detailsUrl ?? null), '42');
  assert.equal(actionsJobId('https://ci.example.invalid/build/1'), null);
  assert.equal(actionsJobId(null), null);
});

await test('logs lose control codes, timestamps, known secrets, token shapes and URL credentials', () => {
  const raw = [
    '2026-10-17T01:02:03.4567890Z \u{1B}[32mRunning npm test\u{1B}[0m\r',
    `2026-10-17T01:02:04.0000000Z token=${LEAKED}`,
    'fetch https://bot:hunter2@github.com/fixture/app.git',
    'Authorization: Bearer abc.def.ghi',
    'mesh-secret-value appears here',
    'Unexpected token in JSON at position 4',
  ].join('\n');
  const clean = redactLog(raw, ['mesh-secret-value']);
  assert.ok(!clean.includes('\u{1B}') && !clean.includes('\r'));
  assert.doesNotMatch(clean, /2026-10-17T/v);
  assert.ok(!clean.includes(LEAKED));
  assert.doesNotMatch(clean, /hunter2|abc\.def\.ghi|mesh-secret-value/v);
  assert.match(clean, /https:\/\/\[REDACTED\]@github\.com/v);
  assert.match(clean, /^Authorization: \[REDACTED\]/mv);
  assert.match(clean, /^Running npm test$/mv);
  assert.match(clean, /Unexpected token in JSON/v, 'ordinary prose keeps its words');
});

await test('excerpts keep the first error with context and the final lines, within the bound', () => {
  const lines = Array.from({ length: 400 }, (_value, index) => `line ${String(index)}`);
  lines[200] = 'src/app.ts(3,1): error TS2304: Cannot find name';
  const excerpt = excerptLog(lines.join('\n'));
  assert.match(excerpt, /line 186\n/v);
  assert.match(excerpt, /error TS2304/v);
  assert.match(excerpt, /line 399$/v);
  assert.doesNotMatch(excerpt, /line 10\n/v);
  assert.match(excerpt, /lines omitted/v);
  const huge = excerptLog(`${'x'.repeat(390)} error\n`.repeat(2000), 500);
  assert.ok(huge.length <= 500);
  const check = checkState(FAILED_CHECK);
  const finding = ciFinding(check, 'error everywhere\n'.repeat(5000), 'a'.repeat(40));
  assert.ok(finding.length <= REPAIR_FINDING_MAX);
  assert.match(finding, /^\[P1\] CI check "check \(ubuntu-latest\)" failed on a{40}/v);
  assert.match(ciFinding(check, null, 'b'), /No log was available/v);
});

await test('pending and cancelled checks never start a repair', async (t) => {
  const fixture = await repairFixture(t);
  const { context, task } = fixture;
  fixture.setPr({ statusCheckRollup: [FAILED_CHECK, { name: 'e2e', status: 'QUEUED' }] });
  await reconcile(context);
  assert.equal(context.repository.task(task.id).phase, 'review');
  fixture.setPr({
    statusCheckRollup: [{ name: 'check (ubuntu-latest)', status: 'COMPLETED', conclusion: 'CANCELLED' }, PASSING_CHECK],
  });
  await reconcile(context);
  const current = context.repository.task(task.id);
  assert.equal(current.phase, 'review');
  assert.deepEqual(current.repairs, []);
  assert.deepEqual(fixture.requested, []);
});

await test('the CI repair cap stops the delivery for the operator', async (t) => {
  const fixture = await repairFixture(t, { repair: { maxCiRepairs: 1 } });
  const { context, task } = fixture;
  await reconcile(context);
  assert.equal(context.repository.task(task.id).repairs.length, 1);
  republish(fixture, 'f'.repeat(40));
  await reconcile(context);
  const capped = context.repository.task(task.id);
  assert.equal(capped.phase, 'blocked');
  assert.match(capped.error ?? '', /1 CI repair round did not fix it/v);
  assert.equal(capped.repairs.length, 1);
  assert.equal(fixture.requested.length, 1, 'a capped round never downloads logs');
});

await test('the conflict repair cap blocks before another paid turn', async (t) => {
  const { context, task } = await repairFixture(t, { repair: { maxConflictRepairs: 1 } });
  const { directory } = await context.workspaces.developer(task);
  const base = task.head ?? '';
  await context.workspaces.git(['commit', '--allow-empty', '-m', 'Another delivery commit'], directory);
  const later = await context.workspaces.git(['rev-parse', 'HEAD'], directory);
  const conflict = { files: ['shared.txt'], base, directory };
  assert.equal(await recordConflict(context, task, { ...conflict, head: base }), 'recorded');
  assert.equal(
    await recordConflict(context, context.repository.task(task.id), { ...conflict, head: later }),
    'exhausted',
  );
  const blocked = context.repository.task(task.id);
  assert.equal(blocked.phase, 'blocked');
  assert.match(blocked.error ?? '', /1 merge-conflict repair round did not fix it/v);
  assert.equal(blocked.repairs.length, 1);
});

await test('each repair round grants the developer one more attempt', () => {
  const config: FactoryConfig = factoryConfigSchema.parse({
    testCommands: [{ file: process.execPath }],
    endToEndCommands: [{ file: process.execPath }],
  });
  const objective = featureSchema.parse({
    id: randomUUID(),
    objective: 'Fixture',
    phase: 'active',
    productPlan: null,
    plan: null,
    parentIssue: null,
    error: null,
    createdAt: 1,
    updatedAt: 1,
  });
  const exhausted = taskSchema.parse({
    id: randomUUID(),
    featureId: objective.id,
    issue: 1,
    parentIssue: 2,
    key: 'fixture',
    title: 'Fixture',
    description: 'Fixture',
    acceptanceCriteria: [],
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
    attempts: config.maxAttempts,
    version: 0,
    error: null,
    updatedAt: 1,
  });
  const repaired: FactoryTask = {
    ...exhausted,
    repairs: [
      { kind: 'ci', key: 'ci:x:y', head: 'x', base: 'y', at: 2, checks: ['y'], files: [], findings: [], summary: 'y' },
    ],
  };
  assert.equal(attemptBudget(repaired, config), config.maxAttempts + 1);
  const intents = (tasks: FactoryTask[]): string[] => {
    return jobIntents({ config, features: [objective], tasks, jobs: [], skillRequests: [], now: 10 })
      .filter((intent) => intent.kind === 'develop')
      .map((intent) => intent.role);
  };
  assert.deepEqual(intents([exhausted]), []);
  assert.deepEqual(intents([repaired]), ['developer-1']);
});

await test('conflict errors keep a bounded path list for the round', () => {
  const error = new MergeConflictError({
    files: Array.from({ length: 80 }, (_value, index) => `file-${String(index)}.ts`),
    head: 'h',
    base: 'b',
  });
  assert.equal(error.files.length, 50);
  assert.equal(error.code, 'FACTORY_GATED');
  assert.match(error.message, /file-0\.ts, file-1\.ts/v);
});
