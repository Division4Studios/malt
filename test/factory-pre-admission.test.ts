/**
 * Every paid delivery assignment reads GitHub first: a closed issue parks the
 * delivery, a merged or closed PR starts no paid run, a confirmed-open read is
 * reused for one reconcile interval, and verification is not guarded.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { IssueGuard } from '../src/factory/issue-guard.ts';
import { runProcess } from '../src/factory/processes.ts';
import { FactoryRepository } from '../src/factory/repository.ts';
import { factoryConfigSchema, taskSchema } from '../src/factory/schema.ts';
import { WorkspaceManager } from '../src/factory/workspaces.ts';
import { ProjectLearning } from '../src/learning.ts';
import { Store } from '../src/store.ts';

import { createCleanup, createProject } from './helpers.ts';

import type { FactoryContext } from '../src/factory/context.ts';
import type { IssueState, PullRequest } from '../src/factory/remote.ts';
import type { JobIntent } from '../src/factory/scheduler.ts';
import type { FactoryTask } from '../src/factory/schema.ts';
import type { TestContext } from 'node:test';

/** Reviewed source. */
const HEAD = 'a'.repeat(40);
/** Reviewed base. */
const BASE = 'b'.repeat(40);

/**
 * A remote call the guard never makes.
 *
 * @returns Never; it always rejects.
 */
async function refuse(): Promise<never> {
  await delay(0);
  throw new Error('Not used by the guard.');
}

/** A guarded delivery in review, with controllable GitHub answers. */
interface Fixture {
  readonly context: FactoryContext;
  readonly task: FactoryTask;
  readonly clock: { now: number };
  readonly reads: string[];
  readonly github: { issue: IssueState; pr: string };
}

/**
 * Build a ledger with one published delivery in review.
 *
 * @param t - Owns cleanup.
 * @returns The context, delivery, clock, recorded reads and GitHub answers.
 */
function fixture(t: TestContext): Fixture {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  const clock = { now: 1_000_000 };
  const store = new Store(mesh, { now: () => clock.now });
  defer(() => {
    store.close();
  });
  const settings = factoryConfigSchema.parse({
    testCommands: [{ file: process.execPath }],
    endToEndCommands: [{ file: process.execPath }],
  });
  const repository = new FactoryRepository(store);
  repository.configure(settings);
  const task = taskSchema.parse({
    id: randomUUID(),
    featureId: null,
    issue: 7,
    parentIssue: 1,
    key: 'guarded',
    title: 'Guarded delivery',
    description: 'One observable outcome.',
    acceptanceCriteria: ['Observable behavior passes.'],
    dependencies: [],
    phase: 'review',
    developer: 'developer-1',
    branch: 'guarded',
    worktree: null,
    head: HEAD,
    base: BASE,
    pr: 3,
    prUrl: 'https://github.com/example/app/pull/3',
    merge: null,
    reviews: [],
    feedback: [],
    attempts: 1,
    version: 1,
    error: null,
    updatedAt: clock.now,
  });
  repository.addTask(task);
  const reads: string[] = [];
  const github: Fixture['github'] = { issue: { state: 'open', stateReason: null }, pr: 'OPEN' };
  const context: FactoryContext = {
    mesh,
    home: mesh.root,
    settings,
    workspaces: new WorkspaceManager(mesh, settings),
    repository,
    learning: new ProjectLearning(mesh),
    processes: runProcess,
    agent: refuse,
    remote: {
      verify: refuse,
      provision: refuse,
      readyIssues: refuse,
      pullRequest: refuse,
      merge: refuse,
      effect: refuse,
      parentComplete: refuse,
      issueState: async () => {
        reads.push('issue');
        return await delay(0, github.issue);
      },
      inspect: async (): Promise<PullRequest> => {
        reads.push('pr');
        await delay(0);
        return {
          number: 3,
          url: 'https://github.com/example/app/pull/3',
          headRefOid: HEAD,
          baseRefOid: BASE,
          baseRefName: 'main',
          isDraft: false,
          state: github.pr,
          mergeStateStatus: 'CLEAN',
          mergeCommit: github.pr === 'MERGED' ? { oid: HEAD } : null,
          statusCheckRollup: [],
        };
      },
    },
  };
  return { context, task, clock, reads, github };
}

/**
 * A review intent for the fixture delivery.
 *
 * @param f - Fixture.
 * @param kind - Assignment kind.
 * @returns Intent at the reviewed source.
 */
function intent(f: Fixture, kind: JobIntent['kind'] = 'review'): JobIntent {
  return { role: 'qa-1', kind, taskId: f.task.id, featureId: null, head: HEAD, base: BASE, step: 'review-1' };
}

/**
 * Offer one assignment to the guard.
 *
 * @param guard - Guard under test.
 * @param f - Fixture.
 * @param offered - Assignment.
 * @returns Whether it started.
 */
async function didStart(guard: IssueGuard, f: Fixture, offered: JobIntent = intent(f)): Promise<boolean> {
  let isStarted = false;
  await guard.launch(f.context, offered, () => {
    isStarted = true;
  });
  return isStarted;
}

await test('a closed issue parks a delivery before any paid review starts', async (t) => {
  const f = fixture(t);
  f.github.issue = { state: 'closed', stateReason: 'completed' };
  assert.equal(await didStart(new IssueGuard(), f), false);
  const parked = f.context.repository.task(f.task.id);
  assert.equal(parked.phase, 'blocked');
  assert.match(parked.error ?? '', /^Issue #7 is closed \(state_reason: completed\), so no review assignment/v);
});

await test('a merged or closed PR starts no paid run and says why', async (t) => {
  const f = fixture(t);
  const guard = new IssueGuard();
  f.github.pr = 'MERGED';
  assert.equal(await didStart(guard, f), false);
  assert.equal(f.context.repository.task(f.task.id).phase, 'review', 'reconciliation adopts the merge');
  assert.match(guard.waitingReason(f.context.repository) ?? '', /^PR #3 is merged on GitHub, so no paid review/v);
  f.github.pr = 'CLOSED';
  f.context.repository.editTask(f.task.id, (current) => ({ ...current, phase: 'merge_ready' }));
  assert.equal(await didStart(guard, f, intent(f, 'final')), false);
  assert.match(guard.waitingReason(f.context.repository) ?? '', /PR #3 is closed on GitHub, so no paid final test/v);
});

await test('an open read is reused for one reconcile interval and verification is not guarded', async (t) => {
  const f = fixture(t);
  const guard = new IssueGuard();
  assert.equal(await didStart(guard, f), true);
  assert.deepEqual(f.reads, ['issue', 'pr']);
  assert.equal(await didStart(guard, f), true);
  assert.deepEqual(f.reads, ['issue', 'pr'], 'the confirmation is cached');
  f.clock.now += f.context.settings.reconcileMs + 1;
  assert.equal(await didStart(guard, f), true);
  assert.deepEqual(f.reads, ['issue', 'pr', 'issue', 'pr']);
  f.context.repository.editTask(f.task.id, (current) => ({ ...current, phase: 'verifying' }));
  assert.equal(await didStart(guard, f, intent(f, 'verify')), true);
  assert.equal(f.reads.length, 4, 'verification runs after the merge closes the issue');
});
