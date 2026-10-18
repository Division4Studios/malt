/**
 * Operator continue-or-wait decisions at a checkpoint: a held or ceiling-stopped
 * productive attempt asks once, its step waits while the decision is pending,
 * `continue` grants one bounded attempt without the extension gate, `wait`
 * returns the step to normal retries, and decisions are idempotent and fenced
 * against stale sources, stages and newer attempts. No provider CLI runs.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { run } from '../src/database.ts';
import {
  askForDecision,
  decideCheckpoint,
  hasContinuation,
  isAwaitingDecision,
  shouldAskOperator,
  useContinuation,
} from '../src/factory/checkpoint-decisions.ts';
import { checkpointItems } from '../src/factory/checkpoint-view.ts';
import { OPERATOR_ONLY_OPERATIONS } from '../src/factory/operator-only.ts';
import { FactoryRepository } from '../src/factory/repository.ts';
import { isBackingOff, RETRY_POLICY } from '../src/factory/retry-policy.ts';
import { factoryConfigSchema, jobSchema, taskSchema } from '../src/factory/schema.ts';
import { Store } from '../src/store.ts';

import { createCleanup, createProject } from './helpers.ts';

import type { JobLiveness, LivenessPolicy } from '../src/factory/liveness-schema.ts';
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
  assert.ok(OPERATOR_ONLY_OPERATIONS.has('factory_checkpoint_decide'), 'agents can never decide their own checkpoint');
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
  const items = checkpointItems(f.repository.jobs(), [f.task]);
  assert.equal(items.length, 1);
  const [item] = items;
  assert.ok(item !== undefined);
  assert.equal(item.requestId, held.id);
  assert.equal(item.head, 'h1');
  assert.match(item.title, /#7 Review the parser/v);
});

await test('continue grants one bounded attempt without the gate; wait returns to normal retries', (t) => {
  const f = fixture(t);
  const held = heldAttempt(f);
  assert.throws(() => decideCheckpoint(f.repository, { jobId: held.id, requestId: randomUUID(), action: 'continue' }), {
    code: 'INVALID_INPUT',
  });
  const requestId = randomUUID();
  const decision = { jobId: held.id, requestId, action: 'continue', minutes: 30, expectedHead: 'h1' } as const;
  assert.equal(decideCheckpoint(f.repository, decision).result, 'decided');
  assert.equal(
    decideCheckpoint(f.repository, decision).result,
    'repeated',
    'a retried request reports the first result',
  );
  assert.throws(() => decideCheckpoint(f.repository, { ...decision, requestId: randomUUID(), action: 'wait' }), {
    code: 'FACTORY_GATED',
  });
  assert.equal(isAwaitingDecision(f.repository.jobs(), f.scope), false);
  assert.equal(hasContinuation(f.repository.jobs(), f.scope), true);
  assert.equal(isBackingOff(f.repository.jobs(), f.scope, { now: 10 * MINUTE, reconcileMs: MINUTE }), false);
  const next = attempt(f, { startedAt: 11 * MINUTE });
  const granted = useContinuation(f.repository, next, POLICY);
  assert.deepEqual(granted, { ...POLICY, maxMs: 30 * MINUTE });
  assert.equal(useContinuation(f.repository, attempt(f, { role: 'qa-2' }), POLICY), null, 'a grant is used once');
  assert.equal(f.repository.jobs().find((job) => job.id === held.id)?.checkpoint?.consumedBy, next.id);

  const g = fixture(t);
  const waiting = heldAttempt(g);
  decideCheckpoint(g.repository, { jobId: waiting.id, requestId: randomUUID(), action: 'wait' });
  const timing = { now: 10 * MINUTE + 1, reconcileMs: MINUTE };
  assert.equal(isBackingOff(g.repository.jobs(), g.scope, timing), true, 'wait follows the held backoff');
  const after = { ...timing, now: 10 * MINUTE + (RETRY_POLICY.held.baseMs ?? 0) };
  assert.equal(isBackingOff(g.repository.jobs(), g.scope, after), false);
  assert.equal(useContinuation(g.repository, attempt(g), POLICY), null, 'wait grants nothing');
});

await test('stale decisions are refused: a moved head, another stage or a newer attempt', (t) => {
  const stopping = fixture(t);
  const running = attempt(stopping);
  askForDecision(stopping.repository, running, HELD);
  assert.deepEqual(checkpointItems(stopping.repository.jobs(), [stopping.task]), [], 'hidden while it stops');
  assert.throws(
    () => decideCheckpoint(stopping.repository, { jobId: running.id, requestId: randomUUID(), action: 'wait' }),
    {
      code: 'FACTORY_GATED',
      message: /still stopping/v,
    },
  );
  assert.equal(
    stopping.repository.jobs().find((job) => job.id === running.id)?.checkpoint?.state,
    'pending',
    'a decision during the stop never marks the checkpoint stale',
  );

  const moved = fixture(t);
  const first = heldAttempt(moved);
  moved.repository.editTask(moved.task.id, (task) => ({ ...task, head: 'h2' }));
  assert.throws(
    () =>
      decideCheckpoint(moved.repository, { jobId: first.id, requestId: randomUUID(), action: 'continue', minutes: 30 }),
    { code: 'FACTORY_GATED', message: /source changed/v },
  );
  assert.equal(moved.repository.jobs().find((job) => job.id === first.id)?.checkpoint?.state, 'stale');

  const fenced = fixture(t);
  const seen = heldAttempt(fenced);
  assert.throws(
    () => {
      return decideCheckpoint(fenced.repository, {
        jobId: seen.id,
        requestId: randomUUID(),
        action: 'continue',
        minutes: 30,
        expectedHead: 'h0',
      });
    },
    { code: 'FACTORY_GATED' },
  );

  const staged = fixture(t);
  const reviewed = heldAttempt(staged);
  staged.repository.editTask(staged.task.id, (task) => ({ ...task, phase: 'merge_ready' }));
  assert.throws(
    () => decideCheckpoint(staged.repository, { jobId: reviewed.id, requestId: randomUUID(), action: 'wait' }),
    {
      code: 'FACTORY_GATED',
      message: /another stage/v,
    },
  );

  const replaced = fixture(t);
  const older = heldAttempt(replaced);
  replaced.repository.saveJob({ ...attempt(replaced, { role: 'qa-2' }), state: 'failed', finishedAt: 11 * MINUTE });
  assert.throws(
    () => decideCheckpoint(replaced.repository, { jobId: older.id, requestId: randomUUID(), action: 'wait' }),
    {
      code: 'FACTORY_GATED',
      message: /newer attempt/v,
    },
  );
  assert.throws(
    () => decideCheckpoint(replaced.repository, { jobId: randomUUID(), requestId: randomUUID(), action: 'wait' }),
    {
      code: 'NOT_FOUND',
    },
  );
});
