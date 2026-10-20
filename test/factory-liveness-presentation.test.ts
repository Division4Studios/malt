/**
 * How recorded assignment liveness reaches the operator and the delivery
 * manager: the quota reading the extension gate trusts (or `unknown`), the
 * console's running and stopped attempts, the mission brief and its text,
 * checkpoint decisions in the brief and the attempt listing's decision state.
 * Fixtures only; no provider CLI runs.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { z } from 'zod/v3';

import { run, selectAll } from '../src/database.ts';
import { listAttempts } from '../src/factory/attempts.ts';
import { askForDecision } from '../src/factory/checkpoint-decisions.ts';
import { consoleView } from '../src/factory/console-view.ts';
import { quotaView } from '../src/factory/extension-gate.ts';
import { briefText, DECISION_ROUTES, missionBrief, STALL_MS } from '../src/factory/manager-brief.ts';
import { QUOTA_REFRESH_MS } from '../src/factory/quota-windows.ts';
import { FactoryRepository } from '../src/factory/repository.ts';
import { factoryConfigSchema, jobSchema, taskSchema } from '../src/factory/schema.ts';
import { Store } from '../src/store.ts';

import { createCleanup, createProject } from './helpers.ts';

import type { MeshConfig } from '../src/config.ts';
import type { JobLiveness } from '../src/factory/liveness-schema.ts';
import type { Capacity, FactoryJob, FactoryTask } from '../src/factory/schema.ts';
import type { TestContext } from 'node:test';

process.env['AGENTMESH_LOG_LEVEL'] = 'silent';

/** A checkpoint decision event's payload. */
const decisionEventSchema = z.object({ data: z.string() });

/** One minute. */
const MINUTE = 60_000;
/** Fixed ledger clock. */
const NOW = 1000 * MINUTE;

/** A configured ledger on a fixed clock. */
interface Fixture {
  /** Project paths. */
  readonly mesh: MeshConfig;
  /** Project ledger. */
  readonly repository: FactoryRepository;
}

/**
 * Build a configured ledger.
 *
 * @param t - Owns cleanup.
 * @returns Ledger and project paths.
 */
function fixture(t: TestContext): Fixture {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  const store = new Store(mesh, { now: () => NOW });
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
  return { mesh, repository };
}

/**
 * Add one delivery in development.
 *
 * @param f - Fixture.
 * @param issue - Issue number.
 * @returns A delivery titled after its issue, on head `head-<issue>`.
 */
function delivery(f: Fixture, issue: number): FactoryTask {
  const task = taskSchema.parse({
    id: randomUUID(),
    featureId: null,
    issue,
    parentIssue: 1,
    key: `task-${String(issue)}`,
    title: `Delivery ${String(issue)}`,
    description: 'Work.',
    acceptanceCriteria: ['Done'],
    dependencies: [],
    phase: 'development',
    developer: 'developer-1',
    branch: `feat/${String(issue)}`,
    worktree: null,
    head: `head-${String(issue)}`,
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
  f.repository.addTask(task);
  return task;
}

/**
 * Insert one implementation attempt of a delivery.
 *
 * @param f - Fixture.
 * @param task - Delivery.
 * @param fields - Overrides.
 * @returns The stored attempt.
 */
function attempt(f: Fixture, task: FactoryTask, fields: Partial<FactoryJob> = {}): FactoryJob {
  const job = jobSchema.parse({
    id: randomUUID(),
    role: 'developer-1',
    provider: 'codex',
    kind: 'develop',
    taskId: task.id,
    featureId: null,
    head: task.head,
    base: 'b1',
    step: null,
    token: randomUUID(),
    state: 'running',
    startedAt: NOW - 12 * MINUTE,
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

/** A productive running attempt: tool progress two minutes ago, one extension. */
const PROGRESSING: JobLiveness = {
  state: 'progressing',
  extensions: 1,
  lastProgressAt: NOW - 2 * MINUTE,
  lastSignal: 'tool Bash',
  awaiting: null,
  nextCheckpointAt: NOW + 8 * MINUTE,
  ceilingAt: NOW + 60 * MINUTE,
  stopReason: null,
};

/**
 * A provider snapshot.
 *
 * @param fields - Overrides.
 * @returns Capacity without any reading unless given.
 */
function capacity(fields: Partial<Capacity> = {}): Capacity {
  return {
    provider: 'codex',
    usedTokens: 0,
    reservedTokens: 0,
    resetAt: NOW + 60 * MINUTE,
    cooldownUntil: 0,
    subscriptionUsedPercent: null,
    subscriptionResetAt: null,
    subscriptionWindows: [],
    telemetrySource: null,
    updatedAt: NOW - MINUTE,
    ...fields,
  };
}

await test('the quota view is the reading the extension gate trusts, never an inferred number', () => {
  const window = {
    id: 'primary',
    usedPercent: 40,
    resetAt: null,
    observedAt: NOW - MINUTE,
    source: 'codex-app-server',
  } as const;
  assert.deepEqual(quotaView(capacity({ subscriptionWindows: [window] }), NOW), {
    freshness: 'current',
    headroomPercent: 60,
    observedAt: NOW - MINUTE,
  });
  const second = { ...window, id: 'secondary', usedPercent: 70, observedAt: NOW - 2 * MINUTE };
  assert.deepEqual(
    quotaView(capacity({ subscriptionWindows: [window, second] }), NOW),
    { freshness: 'current', headroomPercent: 30, observedAt: NOW - 2 * MINUTE },
    'the most used window and the oldest observation decide',
  );
  const old = { ...window, observedAt: NOW - QUOTA_REFRESH_MS };
  assert.deepEqual(quotaView(capacity({ subscriptionWindows: [old] }), NOW), {
    freshness: 'stale',
    headroomPercent: null,
    observedAt: NOW - QUOTA_REFRESH_MS,
  });
  assert.deepEqual(quotaView(capacity(), NOW), { freshness: 'unknown', headroomPercent: null, observedAt: null });
  assert.deepEqual(quotaView(capacity({ subscriptionUsedPercent: 25 }), NOW), {
    freshness: 'current',
    headroomPercent: 75,
    observedAt: NOW - MINUTE,
  });
});

await test('the console and the brief show a running attempt’s liveness, elapsed time and quota', (t) => {
  const f = fixture(t);
  const settings = f.repository.config();
  assert.ok(settings !== null);
  const codex = f.repository.capacity('codex', settings);
  f.repository.saveCapacity({
    ...codex,
    subscriptionWindows: [
      { id: 'primary', usedPercent: 40, resetAt: null, observedAt: NOW - MINUTE, source: 'codex-app-server' },
    ],
  });
  const working = delivery(f, 11);
  const job = attempt(f, working, { liveness: PROGRESSING });
  const fresh = delivery(f, 12);
  attempt(f, fresh, { role: 'developer-2', provider: 'claude', startedAt: NOW - MINUTE });

  const cards = consoleView(f.repository).deliveries;
  const card = cards.find((candidate) => candidate.taskId === working.id);
  assert.equal(card?.running?.jobId, job.id);
  assert.equal(card.running.startedAt, NOW - 12 * MINUTE);
  assert.deepEqual(card.running.quota, { freshness: 'current', headroomPercent: 60, observedAt: NOW - MINUTE });
  assert.equal(card.running.liveness?.extensions, 1);
  assert.equal(card.stop, null);
  const unknown = cards.find((candidate) => candidate.taskId === fresh.id);
  assert.equal(unknown?.running?.liveness, null, 'no liveness is invented before the first sample');
  assert.equal(unknown.running.quota?.freshness, 'unknown');

  const brief = missionBrief(f.repository, [], NOW);
  const shown = brief.deliveries.find((candidate) => candidate.taskId === working.id);
  assert.equal(shown?.job?.liveness?.state, 'progressing');
  assert.equal(shown.job.isPossiblyStalled, false);
  assert.equal(shown.job.quota.headroomPercent, 60);
  const text = briefText(brief);
  assert.match(
    text,
    /#11 Delivery 11 .*developer-1 is running develop \(12 min\)\. Liveness: progressing, tool Bash 2 min ago, next checkpoint in 8 min, extended 1×; quota headroom 60% \(read 1 min ago\)\./v,
  );
  assert.match(text, /#12 Delivery 12 .*Liveness not recorded yet; quota unknown\./v);
});

await test('every recorded liveness state reads truthfully in the brief', (t) => {
  const f = fixture(t);
  const task = delivery(f, 21);
  const job = attempt(f, task, { liveness: PROGRESSING });
  const line = (liveness: JobLiveness): string => {
    f.repository.saveJob({ ...job, liveness });
    return briefText(missionBrief(f.repository, [], NOW));
  };
  assert.match(
    line({ ...PROGRESSING, state: 'awaiting_input', awaiting: 'Permission not granted for a tool call' }),
    /Liveness: awaiting input, tool Bash 2 min ago, awaiting Permission not granted for a tool call,/v,
  );
  assert.match(
    line({ ...PROGRESSING, state: 'idle', lastSignal: null, lastProgressAt: NOW - 12 * MINUTE }),
    /Liveness: idle, no progress yet, next checkpoint in 8 min.* POSSIBLY STALLED\./v,
  );
  assert.match(line({ ...PROGRESSING, state: 'stalled', stopReason: 'stalled 16 min' }), /Liveness: stalled,/v);
  assert.match(line({ ...PROGRESSING, state: 'ceiling', stopReason: 'hard ceiling' }), /Liveness: ceiling,/v);
  assert.match(line({ ...PROGRESSING, state: 'held', stopReason: 'no extension: quota' }), /Liveness: held,/v);
  // Output growth alone is activity, not progress: recorded liveness decides.
  const quiet = missionBrief(f.repository, [], NOW + STALL_MS);
  assert.equal(quiet.deliveries[0]?.job?.isPossiblyStalled, true);
});

await test('a stopped attempt shows its recorded stop reason and its pending decision', async (t) => {
  const f = fixture(t);
  const stalled = delivery(f, 31);
  attempt(f, stalled, {
    state: 'interrupted',
    finishedAt: NOW - 3 * MINUTE,
    failureClass: 'stalled',
    liveness: { ...PROGRESSING, state: 'stalled', stopReason: 'stalled 16 min' },
  });
  const held = delivery(f, 32);
  const asking = attempt(f, held, { role: 'developer-2' });
  askForDecision(f.repository, asking, { ...PROGRESSING, state: 'held', stopReason: 'hard ceiling' });
  const stored = f.repository.jobs().find((candidate) => candidate.id === asking.id);
  assert.ok(stored !== undefined);
  f.repository.saveJob({ ...stored, state: 'interrupted', finishedAt: NOW - MINUTE, failureClass: 'held' });

  const events = selectAll(
    f.repository.store.db,
    decisionEventSchema,
    "SELECT data FROM events WHERE type='FACTORY_CHECKPOINT_DECISION'",
  );
  assert.equal(events.length, 1);
  const event: unknown = JSON.parse(events[0]?.data ?? '{}');
  assert.deepEqual(
    event,
    {
      jobId: asking.id,
      role: 'developer-2',
      issue: 32,
      label: '#32',
      taskId: held.id,
      featureId: null,
      step: null,
      reason: 'hard ceiling',
    },
    'the manager is told who stopped, on which delivery and why',
  );

  const cards = consoleView(f.repository).deliveries;
  assert.deepEqual(cards.find((card) => card.taskId === stalled.id)?.stop, {
    jobId: f.repository.jobs().find((job) => job.taskId === stalled.id)?.id,
    reason: 'stalled 16 min',
    at: NOW - 3 * MINUTE,
    isAwaitingDecision: false,
  });
  assert.equal(cards.find((card) => card.taskId === held.id)?.stop?.isAwaitingDecision, true);

  const brief = missionBrief(f.repository, [], NOW);
  const decision = brief.decisions.find((candidate) => candidate.kind === 'checkpoint');
  assert.equal(decision?.id, asking.id);
  assert.equal(decision.head, 'head-32', 'the decision is fenced to the head the attempt stopped on');
  assert.equal(decision.resolveView, DECISION_ROUTES.checkpoint.view);
  assert.match(decision.title, /^Continue or wait · developer-2 on #32 Delivery 32$/v);
  assert.match(decision.detail, /hard ceiling\. Last progress: tool Bash\. Extended 1 times\. The worktree is kept\./v);
  const text = briefText(brief);
  assert.match(text, /#31 Delivery 31 .* Last attempt stopped: stalled 16 min\./v);
  assert.match(
    text,
    /#32 Delivery 32 .* Last attempt stopped: hard ceiling; awaiting the operator's continue-or-wait decision\./v,
  );
  assert.match(text, /- checkpoint: Continue or wait · developer-2 on #32/v);

  const page = await listAttempts(f.repository, f.mesh, {});
  const states = new Map(page.attempts.map((row) => [row.task?.issue, row.checkpoint]));
  assert.equal(states.get(31), null);
  assert.equal(states.get(32), 'pending');
});
