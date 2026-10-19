/**
 * Real Git recovery gates for advancing main and post-merge repair, without inference.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { writeFile, access, readFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { z } from 'zod/v3';

import { rejectDelivery, completeJob } from '../src/factory/completion.ts';
import { executeJob, retireSnapshot } from '../src/factory/execution.ts';
import { queueObjective } from '../src/factory/objectives.ts';
import { runProcess } from '../src/factory/processes.ts';
import { PublicationSizeError, assertPublicationSize } from '../src/factory/publication-size.ts';
import { reconcile } from '../src/factory/reconcile.ts';
import { FactoryRepository } from '../src/factory/repository.ts';
import { taskSchema, factoryConfigSchema, jobSchema, resultSchema } from '../src/factory/schema.ts';
import { replaceScope } from '../src/factory/scope-changes.ts';
import { installFactorySkills } from '../src/factory/skills.ts';
import { sealSource, readSource } from '../src/factory/source-reader.ts';
import { decideTriage } from '../src/factory/triage.ts';
import { WorkspaceManager } from '../src/factory/workspaces.ts';
import { ProjectLearning } from '../src/learning.ts';
import { Store } from '../src/store.ts';

import { createCleanup, createProject, registration } from './helpers.ts';

import type { FactoryContext } from '../src/factory/context.ts';
import type { PullRequest } from '../src/factory/remote.ts';
import type { FactoryTask, Feature } from '../src/factory/schema.ts';
import type { TestContext } from 'node:test';

/**
 * Build one real local repository with its own bare remote and operational state.
 *
 * @param t - Owns this fixture's cleanup.
 * @returns Actual Git, durable state and a fixture-only remote boundary.
 */
async function fixture(t: TestContext): Promise<{ context: FactoryContext; task: FactoryTask; pr: PullRequest }> {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  const settings = factoryConfigSchema.parse({
    testCommands: [{ file: process.execPath }],
    endToEndCommands: [{ file: process.execPath }],
  });
  const workspaces = new WorkspaceManager(mesh, settings);
  await workspaces.git(['init', '--initial-branch=main']);
  await workspaces.git(['config', 'user.name', 'Recovery fixture']);
  await workspaces.git(['config', 'user.email', 'recovery@example.invalid']);
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
  const pr: PullRequest = {
    number: 3,
    url: 'https://github.com/fixture/app/pull/3',
    headRefOid: head,
    baseRefOid: head,
    baseRefName: 'main',
    isDraft: false,
    state: 'OPEN',
    mergeStateStatus: 'CLEAN',
    mergeCommit: null,
    statusCheckRollup: [],
  };
  const task = taskSchema.parse({
    id: randomUUID(),
    featureId: null,
    issue: 2,
    parentIssue: 1,
    key: 'recovery',
    title: 'Verified change',
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
    prUrl: pr.url,
    merge: null,
    reviews: [
      { role: 'qa-1', head, base: head, outcome: 'success', summary: 'Old source approved.', jobId: randomUUID() },
    ],
    feedback: [],
    attempts: 1,
    version: 0,
    error: null,
    updatedAt: Date.now(),
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
      throw new Error('Recovery must not call paid inference.');
    },
    remote: {
      verify: async () => {
        await delay(0);
      },
      provision: async () => await delay(0, []),
      readyIssues: async () => await delay(0, []),
      inspect: async () => await delay(0, pr),
      merge: async () => {
        await delay(0);
        throw new Error('Stale work must never merge.');
      },
      effect: async () => {
        await delay(0);
      },
      issueState: async () => await delay(0, { state: 'open', stateReason: null }),
      parentComplete: async () => await delay(0, false),
      pullRequest: async () => {
        await delay(0);
        throw new Error('Recovery must not create a PR.');
      },
    },
  };
  return { context, task, pr };
}

/**
 * Advance actual main without changing the factory's recorded source proof.
 *
 * @param context - Isolated Git repository.
 * @returns Newly pushed main commit.
 */
async function advanceMain(context: FactoryContext): Promise<string> {
  await context.workspaces.git(['commit', '--allow-empty', '-m', 'Independent main advance']);
  await context.workspaces.git(['push', 'origin', 'main']);
  return context.workspaces.base();
}

await test('advancing remote main invalidates QA proof and returns ownership to the original developer', async (t) => {
  const { context, task, pr } = await fixture(t);
  pr.baseRefOid = await advanceMain(context);
  await reconcile(context);
  const current = context.repository.task(task.id);
  assert.equal(current.phase, 'development');
  assert.equal(current.developer, 'developer-1');
  assert.deepEqual(current.reviews, []);
  assert.equal(current.finalReview, null);
  assert.match(current.feedback.join('\n'), /original developer must refresh main/v);
});

await test('managed source reads preserve exact committed bytes, exclude private state and fence finished claims', async (t) => {
  const { context, task } = await fixture(t);
  const actor = context.repository.store.register({ ...registration('factory-qa-2'), runtime: 'factory-managed' });
  const job = jobSchema.parse({
    id: randomUUID(),
    role: 'qa-2',
    provider: 'codex',
    kind: 'review',
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
    artifact: context.mesh.directory,
  });
  assert.equal(context.repository.claim(job, context.settings), true);
  const snapshot = await context.workspaces.snapshot(context.mesh.root);
  sealSource(context.repository, job, snapshot);
  const filename = path.join(context.mesh.root, '.gitignore');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Read this fixture's tracked Git-ignore file for exact newline comparison.
  const original = await readFile(filename, 'utf8');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Modify this fixture only; the source API must keep returning the sealed Git blob.
  await writeFile(filename, 'Uncommitted operator change\n');
  const response = await readSource(context, { path: '.gitignore' }, actor.id);
  assert.deepEqual(response, {
    jobId: job.id,
    head: snapshot.head,
    path: '.gitignore',
    truncated: false,
    content: original,
  });
  const listing = await readSource(context, {}, actor.id);
  assert.ok(typeof listing === 'object' && listing !== null && 'changes' in listing);
  assert.ok(typeof listing.changes === 'object' && listing.changes !== null && 'base' in listing.changes);
  assert.equal(listing.changes.base, job.base);
  for (const file of ['.malt/config.json', '../outside.txt', String.raw`C:\credentials.txt`, '.env.local']) {
    await assert.rejects(readSource(context, { path: file }, actor.id), { code: 'INVALID_INPUT' });
  }
  assert.equal(context.repository.finishJob(job, 0, 'succeeded'), true);
  await assert.rejects(readSource(context, { path: '.gitignore' }, actor.id), { code: 'FACTORY_GATED' });
});

await test('large immutable source pages preserve Unicode and redaction without losing bytes', async (t) => {
  const { context } = await fixture(t);
  const content = `${'a'.repeat(31_999)}🌾\n${context.mesh.token}\n${'  source line\n'.repeat(3000)}`;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Only a synthetic tracked file inside this disposable Git fixture.
  await writeFile(path.join(context.mesh.root, 'large.ts'), content);
  await context.workspaces.git(['add', 'large.ts']);
  await context.workspaces.git(['commit', '-m', 'Large read-only fixture']);
  const snapshot = await context.workspaces.snapshot(context.mesh.root);
  const actor = context.repository.store.register({
    ...registration('factory-learning-steward'),
    runtime: 'factory-managed',
  });
  const job = jobSchema.parse({
    id: randomUUID(),
    role: 'learning-steward',
    provider: 'codex',
    kind: 'learn',
    taskId: null,
    featureId: null,
    token: randomUUID(),
    state: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    expiresAt: Number.MAX_SAFE_INTEGER,
    reservation: 0,
    usageTokens: null,
    pid: null,
    head: null,
    base: snapshot.head,
    summary: null,
    artifact: context.mesh.directory,
  });
  assert.equal(context.repository.claim(job, context.settings), true);
  sealSource(context.repository, job, snapshot);
  const pageSchema = z.object({ content: z.string(), nextCursor: z.number().nullable(), head: z.string() });
  let cursor: number | null = 0;
  let restored = '';
  while (cursor !== null) {
    const page = pageSchema.parse(await readSource(context, { path: 'large.ts', cursor }, actor.id));
    assert.equal(page.head, snapshot.head);
    restored += page.content;
    cursor = page.nextCursor;
  }
  assert.equal(restored, content.replace(context.mesh.token, '[REDACTED]'));
  await assert.rejects(readSource(context, { path: 'large.ts', cursor: 32_000 }, actor.id), { code: 'INVALID_INPUT' });
  const basePage = pageSchema.parse(await readSource(context, { path: 'large.ts', revision: 'base' }, actor.id));
  assert.equal(basePage.head, snapshot.head);
});

await test('canonical project aliases preserve repository and owned memory-link identity', async (t) => {
  const { context } = await fixture(t);
  const alias = path.join(context.mesh.directory, 'project-alias');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- This disposable alias points only to the fixture root, never a real project.
  await symlink(context.mesh.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const manager = new WorkspaceManager(
    { ...context.mesh, root: alias, directory: path.join(alias, '.malt') },
    context.settings,
  );
  assert.equal(await manager.origin(), await context.workspaces.origin());
  const created = await manager.create(randomUUID(), await manager.base(), null);
  await access(path.join(created, '.malt'));
});

await test('scope changes committed while inspecting a PR fence the late remote result', async (t) => {
  const { context, task, pr } = await fixture(t);
  let replacement = '';
  const changed: FactoryContext = {
    ...context,
    remote: {
      ...context.remote,
      inspect: async () => {
        await delay(0);
        replacement = replaceScope(context.repository, {
          taskId: task.id,
          instructionId: randomUUID(),
          body: 'Replace this obsolete acceptance requirement.',
        }).featureId;
        return { ...pr, baseRefOid: 'late-obsolete-base' };
      },
    },
  };
  await reconcile(changed);
  const current = context.repository.task(task.id);
  assert.equal(current.phase, 'blocked');
  assert.equal(current.scopeReplacement, replacement);
  assert.deepEqual(current.reviews, []);
  assert.match(current.error ?? '', /Scope superseded/v);
  assert.equal(current.merge, null);
});

await test('superseded issues retire once through confirmed outbox receipts while dirty owned source survives', async (t) => {
  const { context, task } = await fixture(t);
  assert.ok(task.head !== null);
  const worktree = await context.workspaces.create(task.id, task.head, 'mlt/superseded-fixture');
  const filename = path.join(worktree, 'unfinished.txt');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- The fixture writes inside its own ledger-owned worktree.
  await writeFile(filename, 'Preserve operator edits.\n');
  context.repository.editTask(task.id, (delivery) => {
    return {
      ...delivery,
      pr: null,
      worktree,
      branch: 'mlt/superseded-fixture',
    };
  });
  replaceScope(context.repository, {
    taskId: task.id,
    instructionId: randomUUID(),
    body: 'Replace the acceptance scope.',
  });
  const effects: string[] = [];
  const retired: FactoryContext = {
    ...context,
    remote: {
      ...context.remote,
      effect: async (effect) => {
        await delay(0);
        effects.push(effect.kind);
      },
    },
  };
  await reconcile(retired);
  assert.equal(context.repository.task(task.id).scopeCleanup, undefined);
  await reconcile(retired);
  await reconcile(retired);
  await reconcile(retired);
  const current = context.repository.task(task.id);
  assert.match(current.scopeCleanup?.note ?? '', /Preserved/v);
  assert.equal(current.phase, 'blocked');
  assert.equal(effects.filter((kind) => kind === 'close_not_planned').length, 1);
  await access(filename);
  assert.equal(await context.workspaces.git(['rev-parse', 'mlt/superseded-fixture']), task.head);
});

await test('superseded parent waits for actual native children and closes as not planned once across restart', async (t) => {
  const { context, task } = await fixture(t);
  const { featureId } = queueObjective(context.repository, { objective: 'Original parent scope' });
  const original = context.repository.features().find((feature) => feature.id === featureId);
  assert.ok(original !== undefined);
  const replacement = randomUUID();
  context.repository.saveFeature({
    ...original,
    parentIssue: 1,
    phase: 'active',
    scopeReplacement: replacement,
    error: 'Operator replaced scope.',
  });
  context.repository.editTask(task.id, (current) => {
    return {
      ...current,
      featureId,
      phase: 'blocked',
      scopeReplacement: replacement,
      scopeCleanup: { at: context.repository.store.now(), note: 'Dirty source preserved; child closure confirmed.' },
    };
  });
  let areChildrenClosed = false;
  const effects: string[] = [];
  const retirement: FactoryContext = {
    ...context,
    remote: {
      ...context.remote,
      parentComplete: async (parent, children) => {
        assert.equal(parent, 1);
        assert.deepEqual(children, [2]);
        return await delay(0, areChildrenClosed);
      },
      effect: async (effect) => {
        await delay(0);
        if (effect.issue !== 1) {
          return;
        }
        effects.push(effect.kind);
        assert.notEqual(effect.kind, 'close');
        assert.notEqual(effect.value, 'Done');
      },
    },
  };
  await reconcile(retirement);
  assert.deepEqual(effects, []);
  assert.equal(context.repository.features().find((feature) => feature.id === featureId)?.scopeCleanup, undefined);
  areChildrenClosed = true;
  await reconcile(retirement);
  await reconcile(retirement);
  await reconcile(retirement);
  assert.deepEqual(effects, ['comment', 'close_not_planned']);
  context.repository.store.close();
  const restartedStore = new Store(context.mesh);
  let retired: Feature | undefined;
  try {
    const restoredRepository = new FactoryRepository(restartedStore);
    await reconcile({ ...retirement, repository: restoredRepository });
    retired = restoredRepository.features().find((feature) => feature.id === featureId);
  } finally {
    restartedStore.close();
  }
  assert.deepEqual(effects, ['comment', 'close_not_planned']);
  assert.ok(retired !== undefined);
  assert.equal(retired.phase, 'blocked');
  assert.match(retired.scopeCleanup?.note ?? '', /not planned/v);
  assert.equal(retired.scopeReplacement, replacement);
});

await test('a merge completed during scope replacement recovers historical approvals before obsolete closure', async (t) => {
  const { context, task, pr } = await fixture(t);
  assert.ok(task.head !== null && task.base !== null);
  const approved = context.repository.editTask(task.id, (current) => {
    return {
      ...current,
      phase: 'merging',
      reviews: [
        ...current.reviews,
        {
          role: 'qa-2',
          head: task.head ?? '',
          base: task.base ?? '',
          outcome: 'success',
          summary: 'Reviewed exact source.',
          jobId: randomUUID(),
        },
      ],
      finalReview: {
        head: task.head ?? '',
        base: task.base ?? '',
        jobId: randomUUID(),
        summary: 'Integration passed.',
      },
    };
  });
  const replacement = replaceScope(context.repository, {
    taskId: task.id,
    instructionId: randomUUID(),
    body: 'Replace acceptance while merge response is unavailable.',
  });
  const pendingId = `${task.id}:superseded:${replacement.featureId}:pr-close`;
  context.repository.enqueueEffect({
    id: pendingId,
    kind: 'close_pr',
    issue: pr.number,
    value: task.head,
    attempts: 0,
    retryAt: 0,
    error: null,
  });
  pr.state = 'MERGED';
  pr.mergeCommit = { oid: task.head };
  const recovery: FactoryContext = {
    ...context,
    remote: {
      ...context.remote,
      effect: async (effect) => {
        await delay(0);
        assert.notEqual(effect.kind, 'close_pr');
        assert.notEqual(effect.kind, 'close_not_planned');
      },
    },
  };
  await reconcile(recovery);
  const recovered = context.repository.task(task.id);
  assert.equal(recovered.phase, 'verifying');
  assert.equal(recovered.merge, task.head);
  assert.equal(recovered.scopeReplacement, undefined);
  assert.equal(recovered.verifiedMain, null);
  assert.deepEqual(recovered.reviews, approved.reviews);
  assert.deepEqual(recovered.finalReview, approved.finalReview);
  assert.equal(context.repository.effectCompleted(pendingId), false);
  assert.ok(context.repository.effects().every((effect) => effect.id !== pendingId));
  await reconcile(recovery);
  assert.equal(context.repository.task(task.id).phase, 'verifying');
});

await test('unapproved superseded merge preserves its actual commit and blocks retirement and closure', async (t) => {
  const { context, task, pr } = await fixture(t);
  const replacement = replaceScope(context.repository, {
    taskId: task.id,
    instructionId: randomUUID(),
    body: 'Replace unapproved scope.',
  });
  pr.state = 'MERGED';
  pr.mergeCommit = { oid: task.head ?? '' };
  await reconcile(context);
  const recovered = context.repository.task(task.id);
  assert.equal(recovered.merge, task.head);
  assert.equal(recovered.phase, 'blocked');
  assert.equal(recovered.scopeReplacement, replacement.featureId);
  assert.equal(recovered.scopeCleanup, undefined);
  assert.match(recovered.error ?? '', /without retained exact-head\/base/v);
  await reconcile(context);
  assert.equal(context.repository.task(task.id).version, recovered.version);
});

await test('advancing main after verification invalidates closure proof without closing an issue', async (t) => {
  const { context, task } = await fixture(t);
  context.repository.editTask(task.id, (delivery) => {
    return {
      ...delivery,
      phase: 'closing',
      merge: task.head,
      verifiedMain: { head: task.head ?? '', jobId: randomUUID(), summary: 'Previously checked main.' },
    };
  });
  await advanceMain(context);
  await reconcile(context);
  const current = context.repository.task(task.id);
  assert.equal(current.phase, 'verifying');
  assert.equal(current.verifiedMain, null);
  assert.match(current.error ?? '', /Main advanced/v);
  assert.ok(!context.repository.effectCompleted(`${task.id}:verified:close`));
});

await test('post-merge defects preserve dirty owned edits and history and return repair to the original developer', async (t) => {
  const { context, task } = await fixture(t);
  assert.ok(task.head !== null);
  const branch = 'mlt/recovery-source';
  const worktree = await context.workspaces.create(task.id, task.head, branch);
  const filename = path.join(worktree, 'preserve.txt');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Write a fixed file inside this fixture's owned worktree.
  await writeFile(filename, 'Operator edits must survive repair.\n');
  const merged = context.repository.editTask(task.id, (current) => {
    return {
      ...current,
      phase: 'verifying',
      merge: task.head,
      branch,
      worktree,
    };
  });
  assert.match(await context.workspaces.cleanup(merged), /^Preserved/v);
  const repaired = await rejectDelivery(context, merged, 'Merged-main behavior fails a boundary case.');
  assert.equal(repaired.phase, 'development');
  assert.equal(repaired.developer, 'developer-1');
  assert.equal(repaired.pr, null);
  assert.equal(repaired.merge, null);
  assert.deepEqual(repaired.reviews, []);
  assert.ok(
    context.repository
      .taskVersions(task.id)
      .some((version) => version.worktree === worktree && version.merge === task.head),
  );

  await access(filename);
  assert.equal(await context.workspaces.git(['rev-parse', branch]), task.head);
});

await test('rework lessons are kept per finding, not per whole review report', async (t) => {
  const { context, task } = await fixture(t);
  const [first, second] = ['Export drops the header row.', 'Totals are off by one.'];
  await rejectDelivery(context, task, `Two defects.\n${first}\n${second}`, [first, second]);
  await rejectDelivery(context, task, `One defect is still open.\n${first}`, [first]);
  const folder = path.join(context.mesh.directory, 'knowledge', 'lessons');
  const lessonSchema = z.object({ cause: z.string(), occurrences: z.number().optional() });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- The fixture's own lesson folder.
  const recorded = readdirSync(folder).map((name) => {
    const file = path.join(folder, name);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- A file listed in that folder.
    const text = readFileSync(file, 'utf8');
    return lessonSchema.parse(JSON.parse(text));
  });
  assert.equal(recorded.length, 2, 'one lesson per cause; the summary is not part of its identity');
  assert.equal(recorded.find((lesson) => lesson.cause === first)?.occurrences, 2, 'the repeated cause is counted');
});

await test('oversized validated source parks for an exact human exception and publishes without another developer turn', async (t) => {
  const { context, task } = await fixture(t);
  const settings = { ...context.settings, maxDiffLines: 1, maxFiles: 1 };
  const manager = new WorkspaceManager(context.mesh, settings);
  const developer = await manager.developer(task);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixture writes only in its owned throwaway developer worktree.
  await writeFile(path.join(developer.directory, 'large.txt'), 'one\ntwo\nthree\n');
  const { repository } = context;
  repository.editTask(task.id, (prior) => {
    return {
      ...prior,
      branch: developer.branch,
      worktree: developer.directory,
      phase: 'development',
    };
  });
  const instructionId = repository.instruct('developer-1', task.id, 'Include the indivisible regression.');
  const job = jobSchema.parse({
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
    artifact: path.join(context.mesh.directory, 'checks'),
  });
  assert.equal(repository.claim(job, settings), true);
  repository.instructionLedger.deliver(job, repository.instructions(job.role, job.taskId));
  const execution = {
    waiting: null,
    snapshot: null,
    checks: [],
    completion: {
      result: resultSchema.parse({
        outcome: 'success',
        summary: 'Implementation and regression completed.',
        findings: [],
        deliveries: [],
        instructionReceipts: [
          { id: instructionId, acknowledged: true, applied: true, evidence: 'Included the three-line regression.' },
        ],
      }),
      usageTokens: 1,
      cooldownUntil: 0,
      subscriptionUsedPercent: null,
      subscriptionResetAt: null,
      process: { exitCode: 0, stdout: '', stderr: '', interrupted: false },
    },
  };
  const controller = new AbortController();
  await completeJob({ ...context, settings, workspaces: manager }, job, execution, controller.signal);
  const current = repository.task(task.id);
  assert.equal(current.phase, 'blocked');
  const gate = current.publicationGate;
  assert.ok(gate !== undefined);
  const statuses = z.array(z.object({ id: z.string(), state: z.string() }));
  assert.equal(
    statuses.parse(repository.instructionLedger.recent()).find((item) => item.id === instructionId)?.state,
    'applied',
  );
  repository.finishJob(job, 1, 'succeeded');
  await assert.rejects(completeJob({ ...context, settings, workspaces: manager }, job, execution, controller.signal), {
    code: 'FACTORY_GATED',
  });
  const decision = {
    requestId: randomUUID(),
    taskId: task.id,
    expectedVersion: current.version,
    action: 'approve_size',
    note: 'Indivisible fixture regression and implementation.',
  };
  assert.throws(() => decideTriage(context.repository, { ...decision, note: '' }), /reason/v);
  decideTriage(context.repository, decision);
  const approved = context.repository.task(task.id);
  assert.equal(approved.phase, 'publishing');
  assert.deepEqual(approved.reviews, current.reviews, 'Size approval cannot invent QA approvals');
  assert.equal(approved.attempts, current.attempts);
  await manager.retryPublication(approved);
  assert.equal(await manager.git(['rev-parse', 'HEAD'], developer.directory), gate.head);
  assertPublicationSize(gate, settings, approved.sizeApproval);
  assert.throws(() => {
    assertPublicationSize({ ...gate, head: 'changed' }, settings, approved.sizeApproval);
  }, PublicationSizeError);
  assert.throws(() => {
    assertPublicationSize({ ...gate, base: 'advanced' }, settings, approved.sizeApproval);
  }, PublicationSizeError);
  assert.throws(() => decideTriage(context.repository, { ...decision, requestId: randomUUID() }), /changed/v);
});

/** Verification spawns are not observed by these fixtures. */
function ignoreSpawn(): void {
  // Intentionally empty: no process identity is needed.
}

/**
 * Claim one merged-main verification exactly as the scheduler would for this delivery revision.
 *
 * @param context - Real Git fixture.
 * @param task - Verifying delivery.
 * @returns Live final-tester claim.
 */
function verifyClaim(context: FactoryContext, task: FactoryTask): z.output<typeof jobSchema> {
  const job = jobSchema.parse({
    id: randomUUID(),
    token: randomUUID(),
    kind: 'verify',
    role: 'final-tester',
    provider: 'codex',
    taskId: task.id,
    featureId: null,
    head: task.head,
    base: task.base,
    state: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    expiresAt: Date.now() + 60_000,
    reservation: 0,
    usageTokens: null,
    pid: null,
    summary: null,
    artifact: path.join(context.mesh.directory, 'checks', randomUUID()),
  });
  assert.equal(context.repository.claim(job, context.settings), true);
  return job;
}

/**
 * Adopt an operator-identified commit on a parked delivery without a recorded merge.
 *
 * @param context - Real Git fixture.
 * @param task - Parked delivery.
 * @param mergeCommit - Operator-named external merge.
 * @returns Verifying delivery.
 */
function adoptExternal(context: FactoryContext, task: FactoryTask, mergeCommit: string): FactoryTask {
  const parked = context.repository.editTask(task.id, (current) => {
    return {
      ...current,
      phase: 'blocked',
      error: 'Issue already delivered outside the factory.',
    };
  });
  const receipt = decideTriage(context.repository, {
    requestId: randomUUID(),
    taskId: task.id,
    expectedVersion: parked.version,
    action: 'adopt_merge',
    mergeCommit,
    note: 'Delivered by external PRs.',
  });
  assert.equal(receipt.state, 'applied');
  return context.repository.task(task.id);
}

await test('an adopted commit missing from main fails verification gated and never closes its issue', async (t) => {
  const { context, task } = await fixture(t);
  const outside = await context.workspaces.git(['commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'Not on main']);
  const adopted = adoptExternal(context, task, outside);
  assert.equal(adopted.phase, 'verifying');
  const job = verifyClaim(context, adopted);
  await assert.rejects(
    executeJob(context, job, { signal: AbortSignal.timeout(60_000), onSpawn: ignoreSpawn }),
    { code: 'FACTORY_GATED', message: /not contained/v },
    'Containment is checked before any paid final-tester inference.',
  );
  await reconcile(context);
  const current = context.repository.task(task.id);
  assert.equal(current.phase, 'verifying');
  assert.equal(current.verifiedMain, null);
  const returned = await rejectDelivery(context, current, 'Merged-main verification failed.');
  await reconcile(context);
  assert.ok(!['closing', 'done'].includes(context.repository.task(task.id).phase));
  assert.equal(returned.verifiedMain, null);
  assert.ok(!context.repository.effectCompleted(`${task.id}:verified:close`));
  assert.ok(context.repository.effects().every((effect) => effect.kind !== 'close'));
});

await test('an adopted commit contained in main verifies, closes and completes while dirty owned work survives', async (t) => {
  const { context, task } = await fixture(t);
  assert.ok(task.head !== null);
  installFactorySkills(context.mesh);
  const branch = 'malt/adopted-source';
  const worktree = await context.workspaces.create(task.id, task.head, branch);
  const filename = path.join(worktree, 'preserve.txt');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Write a fixed file inside this fixture's owned worktree.
  await writeFile(filename, 'Unsubmitted edits must survive completion.\n');
  context.repository.editTask(task.id, (current) => ({ ...current, branch, worktree }));
  const external = await advanceMain(context);
  const adopted = adoptExternal(context, task, external);
  assert.deepEqual([adopted.head, adopted.base, adopted.pr], [task.head, task.base, task.pr]);
  const effects: string[] = [];
  const verifying: FactoryContext = {
    ...context,
    agent: async () => {
      await delay(0);
      return {
        result: resultSchema.parse({
          outcome: 'success',
          summary: 'Adopted merge verified on actual main.',
          findings: [],
          deliveries: [],
          instructionReceipts: [],
        }),
        usageTokens: 1,
        cooldownUntil: 0,
        subscriptionUsedPercent: null,
        subscriptionResetAt: null,
        process: { exitCode: 0, stdout: '', stderr: '', interrupted: false },
      };
    },
    remote: {
      ...context.remote,
      effect: async (effect) => {
        await delay(0);
        effects.push(effect.kind);
      },
    },
  };
  const job = verifyClaim(context, adopted);
  const controller = new AbortController();
  const execution = await executeJob(verifying, job, { signal: controller.signal, onSpawn: ignoreSpawn });
  await completeJob(verifying, job, execution, controller.signal);
  await retireSnapshot(verifying, execution.snapshot);
  const closing = context.repository.task(task.id);
  assert.equal(closing.phase, 'closing');
  assert.equal(closing.verifiedMain?.head, external);
  assert.deepEqual(closing.reviews, [], 'Verification cannot fabricate QA approvals.');
  await reconcile(verifying);
  assert.equal(context.repository.task(task.id).phase, 'done');
  await reconcile(verifying);
  await reconcile(verifying);
  const done = context.repository.task(task.id);
  assert.equal(done.phase, 'done');
  assert.match(done.error ?? '', /^Preserved/v);
  assert.equal(done.worktree, worktree);
  await access(filename);
  assert.ok(context.repository.effectCompleted(`${task.id}:verified:close`));
  assert.ok(effects.includes('close'));
  assert.ok(
    effects.every((kind) => ['status', 'comment', 'close'].includes(kind)),
    'Completion effects never reopen or re-scope an issue.',
  );
});

/**
 * Give the fixture delivery current approvals and move it to merging.
 *
 * @param context - Fixture ledger.
 * @param task - Fixture delivery.
 */
function approveForMerge(context: FactoryContext, task: FactoryTask): void {
  const head = task.head ?? '';
  const base = task.base ?? '';
  context.repository.editTask(task.id, (current) => {
    return {
      ...current,
      phase: 'merging',
      reviews: [
        ...current.reviews,
        { role: 'qa-2', head, base, outcome: 'success', summary: 'Reviewed exact source.', jobId: randomUUID() },
      ],
      finalReview: { head, base, jobId: randomUUID(), summary: 'Integration passed.' },
    };
  });
}

await test('a merge GitHub completes later waits in merging with its reason, then is adopted', async (t) => {
  const { context, task, pr } = await fixture(t);
  approveForMerge(context, task);
  const reason =
    'Auto-merge is armed, awaiting 1 approving review; GitHub merges the exact reviewed head when protection allows.';
  const pending: FactoryContext = {
    ...context,
    remote: { ...context.remote, merge: async () => await delay(0, { pending: reason }) },
  };
  await reconcile(pending);
  const waiting = context.repository.task(task.id);
  assert.equal(waiting.phase, 'merging');
  assert.equal(waiting.error, reason);
  pr.state = 'MERGED';
  pr.mergeCommit = { oid: task.head ?? '' };
  await reconcile(pending);
  assert.equal(context.repository.task(task.id).phase, 'verifying');
});

await test('auto-merge is disarmed before a moved head is reworked', async (t) => {
  const { context, task, pr } = await fixture(t);
  const disarmed: number[] = [];
  const watched: FactoryContext = {
    ...context,
    remote: {
      ...context.remote,
      disarm: async (number) => {
        await delay(0);
        disarmed.push(number);
      },
    },
  };
  pr.autoMergeRequest = { enabledAt: '2026-10-17T00:00:00Z' };
  pr.headRefOid = 'f'.repeat(40);
  await reconcile(watched);
  assert.deepEqual(disarmed, [3]);
  assert.equal(context.repository.task(task.id).phase, 'development');
});

await test('auto-merge is disarmed as soon as any check fails, even while others still run', async (t) => {
  const { context, pr } = await fixture(t);
  const disarmed: number[] = [];
  const watched: FactoryContext = {
    ...context,
    remote: {
      ...context.remote,
      disarm: async (number) => {
        await delay(0);
        disarmed.push(number);
      },
    },
  };
  pr.autoMergeRequest = { enabledAt: '2026-10-17T00:00:00Z' };
  pr.statusCheckRollup = [
    { name: 'docker', status: 'COMPLETED', conclusion: 'FAILURE' },
    { name: 'check (ubuntu-latest)', status: 'IN_PROGRESS', conclusion: null },
  ];
  await reconcile(watched);
  assert.deepEqual(disarmed, [3]);
});

await test('a PR merged outside the factory at the recorded head is adopted and verified on main', async (t) => {
  const { context, task, pr } = await fixture(t);
  pr.state = 'MERGED';
  pr.mergeCommit = { oid: task.head ?? '' };
  await reconcile(context);
  const adopted = context.repository.task(task.id);
  assert.equal(adopted.phase, 'verifying');
  assert.equal(adopted.merge, task.head);
  assert.equal(adopted.error, null);
  assert.deepEqual(adopted.reviews, [], 'adoption implies no QA approval');
  assert.equal(adopted.finalReview, null);
});

await test('a parked delivery whose PR was merged elsewhere is adopted instead of waiting for an operator', async (t) => {
  const { context, task, pr } = await fixture(t);
  context.repository.editTask(task.id, (current) => ({ ...current, phase: 'development', reviews: [] }));
  pr.state = 'MERGED';
  pr.mergeCommit = { oid: task.head ?? '' };
  await reconcile(context);
  assert.equal(context.repository.task(task.id).phase, 'verifying');
});

await test('an external merge of another head or off main stays an operator decision', async (t) => {
  const moved = await fixture(t);
  moved.pr.state = 'MERGED';
  moved.pr.headRefOid = 'f'.repeat(40);
  moved.pr.mergeCommit = { oid: 'f'.repeat(40) };
  await reconcile(moved.context);
  assert.equal(moved.context.repository.task(moved.task.id).phase, 'blocked');

  // Repeated passes never turn a merge of another head into an adoption, even without an owned worktree.
  const repeated = await fixture(t);
  repeated.context.repository.editTask(repeated.task.id, (current) => ({ ...current, worktree: null }));
  repeated.pr.state = 'MERGED';
  repeated.pr.headRefOid = 'f'.repeat(40);
  repeated.pr.mergeCommit = { oid: repeated.task.head ?? '' };
  await reconcile(repeated.context);
  await reconcile(repeated.context);
  const kept = repeated.context.repository.task(repeated.task.id);
  assert.equal(kept.phase, 'blocked', 'the second pass still waits for the operator');
  assert.equal(kept.head, repeated.task.head, 'the recorded source is kept');

  const elsewhere = await fixture(t);
  elsewhere.pr.state = 'MERGED';
  elsewhere.pr.mergeCommit = { oid: 'e'.repeat(40) };
  await reconcile(elsewhere.context);
  const blocked = elsewhere.context.repository.task(elsewhere.task.id);
  assert.equal(blocked.phase, 'blocked');
  assert.match(blocked.error ?? '', /without the current factory QA\/final gates/v);
});
