/**
 * Checkpoint decisions: a held or ceiling-stopped productive attempt asks
 * once, its step waits while the decision is pending, a `continue` grants one
 * bounded attempt without the extension gate, and `wait` returns the step to
 * normal retries. No provider CLI runs.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { run } from '../src/database.ts';
import {
  askForDecision,
  hasContinuation,
  isAwaitingDecision,
  shouldAskOperator,
  useContinuation,
} from '../src/factory/checkpoint-decisions.ts';
import { FactoryRepository } from '../src/factory/repository.ts';
import { isBackingOff, RETRY_POLICY } from '../src/factory/retry-policy.ts';
import { factoryConfigSchema, jobSchema, taskSchema } from '../src/factory/schema.ts';
import { Store } from '../src/store.ts';

import { createCleanup, createProject } from './helpers.ts';

import type { Checkpoint, JobLiveness, LivenessPolicy } from '../src/factory/liveness-schema.ts';
import type { FactoryJob, FactoryTask } from '../src/factory/schema.ts';
import type { TestContext } from 'node:test';

process.env['AGENTMESH_LOG_LEVEL'] = 'silent';

/** One minute. */
const MINUTE = 60_000;
/** A ten-minute interval, five-minute stall window and 25-minute ceiling. */
const POLICY: LivenessPolicy = { intervalMs: 10 * MINUTE, stallMs: 5 * MINUTE, maxMs: 25 * MINUTE, sampleMs: MINUTE };

/** A project ledger with one delivery in review on head `h1`. */
interface Fixture {
  /** Project ledger. */
  readonly repository: FactoryRepository;
  /** The delivery. */
  readonly task: FactoryTask;
  /** The step's scope. */
  readonly scope: { kind: 'review'; taskId: string; featureId: null; head: string; step: string };
  /** Reopen the project as a restarted broker would. */
  readonly reopen: () => FactoryRepository;
}

/**
 * Build the ledger and its delivery.
 *
 * @param t - Owns cleanup.
 * @returns Ledger, delivery and step scope.
 */
function fixture(t: TestContext): Fixture {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  const store = new Store(mesh);
  defer(() => {
    store.close();
  });
  const reopen = (): FactoryRepository => {
    const restarted = new Store(mesh);
    defer(() => {
      restarted.close();
    });
    return new FactoryRepository(restarted);
  };
  const repository = new FactoryRepository(store);
  repository.configure(
    factoryConfigSchema.parse({
      testCommands: [{ file: process.execPath }],
      endToEndCommands: [{ file: process.execPath }],
    }),
  );
  const task = taskSchema.parse({
    id: randomUUID(),
    featureId: null,
    issue: 7,
    parentIssue: 1,
    key: 'review-me',
    title: 'Review the parser',
    description: 'A long review.',
    acceptanceCriteria: ['Reviewed'],
    dependencies: [],
    phase: 'review',
    developer: 'developer-1',
    branch: null,
    worktree: null,
    head: 'h1',
    base: 'b1',
    pr: null,
    prUrl: null,
    merge: null,
    reviews: [],
    feedback: [],
    attempts: 1,
    version: 0,
    error: null,
    updatedAt: 1,
  });
  repository.addTask(task);
  return {
    repository,
    task,
    scope: { kind: 'review', taskId: task.id, featureId: null, head: 'h1', step: 'qa-1' },
    reopen,
  };
}

/**
 * Insert one review attempt of the fixture step.
 *
 * @param f - Fixture.
 * @param fields - Overrides.
 * @returns The stored attempt.
 */
function attempt(f: Fixture, fields: Partial<FactoryJob> = {}): FactoryJob {
  const job = jobSchema.parse({
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
    ...fields,
  });
  run(
    f.repository.store.db,
    'INSERT INTO factory_jobs(id, role, state, data) VALUES (?, ?, ?, ?)',
    job.id,
    job.role,
    job.state,
    JSON.stringify(job),
  );
  return job;
}

/** A held liveness record that progressed at minute 9. */
const HELD: JobLiveness = {
  state: 'held',
  extensions: 1,
  lastProgressAt: 9 * MINUTE,
  lastSignal: 'tool Bash',
  awaiting: null,
  nextCheckpointAt: 10 * MINUTE,
  ceilingAt: 25 * MINUTE,
  stopReason: 'no extension: codex quota reading is stale',
};

/**
 * Stop a running attempt held at its checkpoint, asking for a decision, and settle it.
 *
 * @param f - Fixture.
 * @returns The settled attempt with its pending decision.
 */
function heldAttempt(f: Fixture): FactoryJob {
  const job = attempt(f);
  askForDecision(f.repository, job, HELD);
  const stored = f.repository.jobs().find((candidate) => candidate.id === job.id);
  assert.ok(stored !== undefined);
  const settled: FactoryJob = { ...stored, state: 'interrupted', finishedAt: 10 * MINUTE, failureClass: 'held' };
  f.repository.saveJob(settled);
  return settled;
}

await test('only held or ceiling-stopped productive attempts ask the operator', () => {
  assert.equal(shouldAskOperator(HELD, POLICY, 10 * MINUTE), true);
  assert.equal(shouldAskOperator({ ...HELD, state: 'ceiling' }, POLICY, 10 * MINUTE), true);
  assert.equal(shouldAskOperator({ ...HELD, state: 'ceiling', lastProgressAt: 0 }, POLICY, 10 * MINUTE), false);
  assert.equal(shouldAskOperator({ ...HELD, state: 'stalled' }, POLICY, 10 * MINUTE), false);
});

await test('a pending decision holds the step, and a replaced token never records one', (t) => {
  const f = fixture(t);
  const stale = attempt(f);
  askForDecision(f.repository, { ...stale, token: randomUUID() }, HELD);
  assert.equal(f.repository.jobs().find((job) => job.id === stale.id)?.checkpoint, undefined);
  f.repository.saveJob({ ...stale, state: 'interrupted', finishedAt: 1 });
  const held = heldAttempt(f);
  assert.equal(held.checkpoint?.state, 'pending');
  assert.equal(held.checkpoint.reason, HELD.stopReason);
  assert.equal(isAwaitingDecision(f.repository.jobs(), f.scope), true);
  assert.equal(isAwaitingDecision(f.reopen().jobs(), f.scope), true, 'a restart keeps the pending decision');
  for (let index = 0; index < 250; index += 1) {
    const other = attempt(f, { role: 'qa-2', taskId: null, head: null, step: null, kind: 'learn' });
    f.repository.saveJob({ ...other, state: 'succeeded', finishedAt: 20 * MINUTE + index });
  }
  assert.equal(
    isAwaitingDecision(f.repository.jobs(), f.scope),
    true,
    'the pending attempt stays visible however many other attempts follow',
  );
  // The step is not offered again however long it waits: no paid retry bypasses the operator.
  assert.equal(isBackingOff(f.repository.jobs(), f.scope, { now: 10 * 24 * 60 * MINUTE, reconcileMs: MINUTE }), true);
});

/**
 * Record a decision on a held attempt, as the operator control will.
 *
 * @param f - Fixture.
 * @param job - Held attempt.
 * @param decision - Decided fields.
 */
function decide(f: Fixture, job: FactoryJob, decision: Partial<Checkpoint>): void {
  const stored = f.repository.jobs().find((candidate) => candidate.id === job.id);
  assert.ok(stored?.checkpoint !== undefined);
  f.repository.saveJob({
    ...stored,
    checkpoint: { ...stored.checkpoint, requestId: randomUUID(), decidedAt: 11 * MINUTE, ...decision },
  });
}

await test('continue grants one bounded attempt without the gate; wait returns to normal retries', (t) => {
  const f = fixture(t);
  const held = heldAttempt(f);
  decide(f, held, { state: 'continue', minutes: 30 });
  assert.equal(isAwaitingDecision(f.repository.jobs(), f.scope), false);
  assert.equal(hasContinuation(f.repository.jobs(), f.scope), true);
  assert.equal(isBackingOff(f.repository.jobs(), f.scope, { now: 10 * MINUTE, reconcileMs: MINUTE }), false);
  const next = attempt(f, { startedAt: 11 * MINUTE });
  assert.deepEqual(useContinuation(f.repository, next, POLICY), { ...POLICY, maxMs: 30 * MINUTE });
  assert.equal(useContinuation(f.repository, attempt(f, { role: 'qa-2' }), POLICY), null, 'a grant is used once');
  assert.equal(f.repository.jobs().find((job) => job.id === held.id)?.checkpoint?.consumedBy, next.id);
  assert.equal(hasContinuation(f.repository.jobs(), f.scope), false);

  const g = fixture(t);
  const waiting = heldAttempt(g);
  decide(g, waiting, { state: 'wait' });
  const timing = { now: 10 * MINUTE + 1, reconcileMs: MINUTE };
  assert.equal(isBackingOff(g.repository.jobs(), g.scope, timing), true, 'wait follows the held backoff');
  const after = { ...timing, now: 10 * MINUTE + (RETRY_POLICY.held.baseMs ?? 0) };
  assert.equal(isBackingOff(g.repository.jobs(), g.scope, after), false);
  assert.equal(useContinuation(g.repository, attempt(g), POLICY), null, 'wait grants nothing');
});
