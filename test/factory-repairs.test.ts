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
import { completeJob } from '../src/factory/completion.ts';
import { consoleView } from '../src/factory/console-view.ts';
import { MergeConflictError } from '../src/factory/merge-conflict.ts';
import { runProcess } from '../src/factory/processes.ts';
import { assignmentPrompt } from '../src/factory/prompts.ts';
import { reconcile } from '../src/factory/reconcile.ts';
import { REPAIR_FINDING_MAX, attemptBudget, countedRepairs } from '../src/factory/repair-schema.ts';
import { openRepair, recordConflict } from '../src/factory/repairs.ts';
import { FactoryRepository } from '../src/factory/repository.ts';
import { jobIntents } from '../src/factory/scheduler.ts';
import { factoryConfigSchema, featureSchema, jobSchema, resultSchema, taskSchema } from '../src/factory/schema.ts';
import { WorkspaceManager } from '../src/factory/workspaces.ts';
import { ProjectLearning } from '../src/learning.ts';
import { Store } from '../src/store.ts';
import { readConsole } from '../web/dist/console-model.js';

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
 * @param logs - Log text the remote returns per check name.
 * @returns Fixture services.
 */
async function repairFixture(
  t: TestContext,
  overrides: Record<string, unknown> = {},
  logs: Readonly<Record<string, string>> = {},
): Promise<Fixture> {
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
          checks.map((check) => ({ name: check.name, text: logs[check.name] ?? null })),
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
    'authorization: Basic dXNlcjpwYXNzd29yZA== trailing',
    'authorization = opaque-credential-1',
    '"authorization":  "opaque-credential-2"',
    'mesh-secret-value appears here',
    'Unexpected token in JSON at position 4',
  ].join('\n');
  const clean = redactLog(raw, ['mesh-secret-value']);
  assert.ok(!clean.includes('\u{1B}') && !clean.includes('\r'));
  assert.doesNotMatch(clean, /2026-10-17T/v);
  assert.ok(!clean.includes(LEAKED));
  assert.doesNotMatch(clean, /hunter2|abc\.def\.ghi|mesh-secret-value/v);
  assert.match(clean, /https:\/\/\[REDACTED\]@github\.com/v);
  assert.match(clean, /^Authorization: \[REDACTED\]$/mv);
  assert.match(clean, /^authorization: \[REDACTED\]$/mv, 'a non-Bearer credential is redacted whole');
  assert.doesNotMatch(clean, /opaque-credential/v, 'spacing around the delimiter does not expose the value');
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
  const verbose = Array.from({ length: 200 }, (_value, index) => `${String(index)} ${'v'.repeat(195)}`);
  verbose[20] = 'src/app.ts(3,1): error TS2304: Cannot find name';
  const bounded = excerptLog(verbose.join('\n'));
  assert.ok(bounded.length <= REPAIR_FINDING_MAX);
  assert.match(bounded, /error TS2304/v, 'the first error survives a verbose log');
  assert.match(bounded, /^199 v+$/mv);
  const check = checkState(FAILED_CHECK);
  const finding = ciFinding(check, 'error everywhere\n'.repeat(5000), 'a'.repeat(40));
  assert.ok(finding.length <= REPAIR_FINDING_MAX);
  assert.match(finding, /^\[P1\] CI check "check \(ubuntu-latest\)" failed on a{40}/v);
  assert.match(ciFinding(check, null, 'b'), /No log was available/v);
});

await test('a failed check on the exact head returns the delivery to its developer with redacted evidence, once', async (t) => {
  const log = `2026-10-17T01:02:03Z \u{1B}[31m##[error]src/app.ts(3,1): error TS2304\u{1B}[0m\nleaked ${LEAKED}\n`;
  const fixture = await repairFixture(t, {}, { 'check (ubuntu-latest)': log });
  const { context, task } = fixture;
  await reconcile(context);
  const repaired = context.repository.task(task.id);
  assert.equal(repaired.phase, 'development');
  assert.equal(repaired.developer, 'developer-1');
  assert.deepEqual(repaired.reviews, []);
  assert.equal(repaired.repairs.length, 1);
  const round = repaired.repairs.at(0);
  assert.ok(round !== undefined);
  assert.equal(round.kind, 'ci');
  assert.deepEqual(round.checks, ['check (ubuntu-latest)']);
  assert.equal(round.head, task.head);
  const evidence = round.findings.join('\n');
  assert.match(evidence, /error TS2304/v);
  assert.ok(!evidence.includes(LEAKED) && !evidence.includes('\u{1B}'));
  assert.deepEqual(
    fixture.requested.map((checks) => checks.map((check) => check.name)),
    [['check (ubuntu-latest)']],
  );
  await reconcile(context);
  const comment = [...context.repository.effects(), ...fixture.sent].find((effect) => effect.kind === 'comment');
  assert.match(comment?.value ?? '', /CI repair round 1 of 2/v);
  assert.doesNotMatch(comment?.value ?? '', /TS2304/v, 'public comments never carry log text');
  assert.equal(openRepair(repaired)?.key, round.key);
  const prompt = assignmentPrompt({
    job: jobSchema.parse(developJob(repaired)),
    task: repaired,
    feature: null,
    repair: openRepair(repaired),
    skill: null,
    standards: [],
    evidence: { repair: openRepair(repaired) },
  });
  assert.match(prompt, /This is a CI repair round/v);
  const shown = readConsole({ factory: { console: consoleView(context.repository) } }).deliveries[0]?.repairs;
  assert.deepEqual(
    shown?.map((entry) => [entry.kind, entry.head, entry.findings.length]),
    [['ci', task.head, 1]],
  );

  republish(fixture, task.head ?? '');
  await reconcile(context);
  const unchanged = context.repository.task(task.id);
  assert.equal(unchanged.phase, 'blocked');
  assert.match(unchanged.error ?? '', /left the failing source unchanged/v);
  assert.equal(unchanged.repairs.length, 1);
  assert.equal(fixture.requested.length, 1, 'a duplicate failure never downloads logs again');
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

await test('a conflicting refresh keeps the delivery commit, records both sides and needs a clean resolution', async (t) => {
  const { context, task } = await repairFixture(t);
  const { repository, workspaces } = context;
  repository.editTask(task.id, (current) => ({ ...current, phase: 'development', head: null, reviews: [] }));
  const developer = await workspaces.developer(repository.task(task.id));
  const shared = path.join(developer.directory, 'shared.txt');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixture writes only inside its owned worktree.
  await writeFile(shared, 'delivery change\n');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixture writes only inside its temporary project.
  await writeFile(path.join(context.mesh.root, 'shared.txt'), 'main change\n');
  await workspaces.git(['commit', '-am', 'Main changes the shared file']);
  await workspaces.git(['push', 'origin', 'main']);
  const base = await workspaces.base();
  repository.editTask(task.id, (current) => {
    return {
      ...current,
      branch: developer.branch,
      worktree: developer.directory,
      base,
    };
  });
  const job = jobSchema.parse(developJob(repository.task(task.id)));
  assert.equal(repository.claim(job, context.settings), true);
  const execution = {
    waiting: null,
    snapshot: null,
    checks: [],
    completion: {
      result: resultSchema.parse({ outcome: 'success', summary: 'Implemented.', findings: [], deliveries: [] }),
      usageTokens: 1,
      cooldownUntil: 0,
      subscriptionUsedPercent: null,
      subscriptionResetAt: null,
      process: { exitCode: 0, stdout: '', stderr: '', interrupted: false },
    },
  };
  const controller = new AbortController();
  await completeJob(context, job, execution, controller.signal);
  const conflicted = repository.task(task.id);
  assert.equal(conflicted.phase, 'development');
  assert.equal(conflicted.repairs.length, 1);
  const round = conflicted.repairs.at(0);
  assert.ok(round !== undefined);
  assert.equal(round.kind, 'conflict');
  assert.deepEqual(round.files, ['shared.txt']);
  assert.match(
    round.findings.join('\n'),
    /This delivery changed it in: \w+ .+\. Main changed it in: \w+ Main changes/v,
  );
  assert.deepEqual(await workspaces.conflictedFiles(developer.directory), [], 'the failed merge was aborted');
  assert.equal(
    await workspaces.git(['log', '-1', '--format=%s'], developer.directory),
    'Deliver #2: Repairable change',
  );

  const again = await workspaces.developer(repository.task(task.id));
  assert.deepEqual(await workspaces.conflictedFiles(again.directory), ['shared.txt']);
  assert.equal(
    await recordConflict(context, repository.task(task.id), {
      files: ['shared.txt'],
      head: round.head,
      base,
      directory: again.directory,
    }),
    'recorded',
  );
  assert.equal(repository.task(task.id).repairs.length, 1, 'the same conflict is one round');
  const publish = async (): Promise<{ head: string }> => {
    return await workspaces.publish(repository.task(task.id), async () => {
      await delay(0);
    });
  };
  await assert.rejects(publish(), /Unresolved merge-conflict markers remain in shared\.txt/v);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixture writes only inside its owned worktree.
  await writeFile(shared, 'delivery change\nmain change\n');
  const published = await publish();
  const parents = await workspaces.git(['rev-list', '--parents', '-n', '1', published.head], developer.directory);
  assert.equal(parents.split(' ').length, 3, 'the resolution concludes a real merge');
  assert.equal(await workspaces.git(['merge-base', '--is-ancestor', base, published.head], developer.directory), '');
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

await test('an operator retry starts the repair caps and the extra attempts afresh', () => {
  const rounds = [{ at: 10 }, { at: 20 }, { at: 30 }];
  assert.equal(countedRepairs({ repairs: rounds }).length, 3);
  assert.deepEqual(countedRepairs({ repairs: rounds, repairsResetAt: 20 }), [{ at: 30 }]);
  assert.equal(attemptBudget({ repairs: rounds }, { maxAttempts: 2 }), 5);
  assert.equal(attemptBudget({ repairs: rounds, repairsResetAt: 30 }, { maxAttempts: 2 }), 2);
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

/**
 * A running develop claim for the delivery's original developer.
 *
 * @param task - Delivery.
 * @returns Job fields.
 */
function developJob(task: FactoryTask): Record<string, unknown> {
  return {
    id: randomUUID(),
    token: randomUUID(),
    kind: 'develop',
    role: 'developer-1',
    provider: 'codex',
    taskId: task.id,
    featureId: null,
    head: null,
    base: null,
    state: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    expiresAt: Date.now() + 60_000,
    reservation: 0,
    usageTokens: null,
    pid: null,
    summary: null,
    artifact: 'fixture-artifact',
  };
}

/**
 * Publish one delivery change from the owned worktree and put the delivery in review on that head.
 *
 * @param fixture - Test fixture.
 * @param file - File the delivery changes.
 * @param phase - `merge_ready` once every review approved it.
 * @returns Published head.
 */
async function publishedInReview(
  fixture: Fixture,
  file: string,
  phase: 'review' | 'merge_ready' = 'review',
): Promise<string> {
  const { repository, workspaces } = fixture.context;
  repository.editTask(fixture.task.id, (current) => ({ ...current, phase: 'development', head: null, reviews: [] }));
  const developer = await workspaces.developer(repository.task(fixture.task.id));
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixture writes only inside its owned worktree.
  await writeFile(path.join(developer.directory, file), 'delivery change\n');
  const owned = { branch: developer.branch, worktree: developer.directory, base: developer.base };
  repository.editTask(fixture.task.id, (current) => ({ ...current, ...owned }));
  const published = await workspaces.publish(repository.task(fixture.task.id), async () => {
    await delay(0);
  });
  const source = { head: published.head, base: published.base };
  repository.editTask(fixture.task.id, (current) => ({ ...current, phase, ...source }));
  fixture.setPr({ headRefOid: published.head, baseRefOid: published.base, statusCheckRollup: [PASSING_CHECK] });
  return published.head;
}

/**
 * Commit and push a change to main from the project checkout.
 *
 * @param fixture - Test fixture.
 * @param file - File main changes.
 * @returns New main.
 */
async function advanceMain(fixture: Fixture, file: string): Promise<string> {
  const { mesh, workspaces } = fixture.context;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixture writes only inside its temporary project.
  await writeFile(path.join(mesh.root, file), 'main change\n');
  await workspaces.git(['add', file]);
  await workspaces.git(['commit', '-m', 'Main moves on']);
  await workspaces.git(['push', 'origin', 'main']);
  const main = await workspaces.base();
  fixture.setPr({ baseRefOid: main });
  return main;
}

await test('main advancing under a reviewed PR is merged in without a developer turn and re-reviewed on the merge', async (t) => {
  const fixture = await repairFixture(t);
  const { context } = fixture;
  const head = await publishedInReview(fixture, 'delivery.txt', 'merge_ready');
  const main = await advanceMain(fixture, 'unrelated.txt');
  await reconcile(context);
  const refreshed = context.repository.task(fixture.task.id);
  assert.equal(refreshed.phase, 'review');
  assert.equal(refreshed.base, main);
  assert.notEqual(refreshed.head, head);
  assert.equal(refreshed.refreshedFrom?.head, head);
  assert.deepEqual(refreshed.reviews, []);
  assert.equal(
    context.repository.jobs().some((job) => job.kind === 'develop'),
    false,
    'no developer turn',
  );
  const parents = await context.workspaces.git(['rev-list', '--parents', '-n', '1', refreshed.head ?? '']);
  assert.equal(parents.split(' ').length, 3, 'the refresh is a real merge of main');
  const remote = await context.workspaces.git(['ls-remote', 'origin', refreshed.branch ?? '']);
  assert.equal(remote.startsWith(refreshed.head ?? '-'), true, 'the merge is pushed to the PR branch');
  const prompt = assignmentPrompt({
    job: jobSchema.parse({ ...developJob(refreshed), kind: 'review', role: 'qa-1' }),
    task: refreshed,
    feature: null,
    skill: null,
    standards: [],
    evidence: {},
  });
  assert.match(prompt, /only merged advanced main into this source/v);
  // Any later code change ends the merge-only scope.
  const repaired = { ...refreshed, head: 'f'.repeat(40) };
  const full = assignmentPrompt({
    job: jobSchema.parse({ ...developJob(repaired), kind: 'review', role: 'qa-1' }),
    task: repaired,
    feature: null,
    skill: null,
    standards: [],
    evidence: {},
  });
  assert.doesNotMatch(full, /only merged advanced main/v, 'new code after the refresh is reviewed in full');
});

await test('a refresh before every review approved keeps the full review scope', async (t) => {
  const fixture = await repairFixture(t);
  const { context } = fixture;
  await publishedInReview(fixture, 'delivery.txt');
  await advanceMain(fixture, 'unrelated.txt');
  await reconcile(context);
  const refreshed = context.repository.task(fixture.task.id);
  assert.equal(refreshed.phase, 'review');
  assert.equal(refreshed.refreshedFrom, undefined, 'unreviewed changes never get a merge-only review');
  const prompt = assignmentPrompt({
    job: jobSchema.parse({ ...developJob(refreshed), kind: 'review', role: 'qa-1' }),
    task: refreshed,
    feature: null,
    skill: null,
    standards: [],
    evidence: {},
  });
  assert.doesNotMatch(prompt, /only merged advanced main/v);
});

await test('a conflicting main refresh becomes a merge-conflict repair for the original developer', async (t) => {
  const fixture = await repairFixture(t);
  const { context } = fixture;
  await publishedInReview(fixture, 'shared.txt');
  await advanceMain(fixture, 'shared.txt');
  await reconcile(context);
  const conflicted = context.repository.task(fixture.task.id);
  assert.equal(conflicted.phase, 'development');
  assert.deepEqual(
    conflicted.repairs.map((round) => [round.kind, round.files]),
    [['conflict', ['shared.txt']]],
  );
});
