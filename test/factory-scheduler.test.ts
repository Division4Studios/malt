/**
 * Pure multi-objective candidate ordering and unchanged eligibility gates.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { jobIntents } from '../src/factory/scheduler.ts';
import { factoryConfigSchema, featureSchema, jobSchema, taskSchema } from '../src/factory/schema.ts';

import type { JobIntent } from '../src/factory/scheduler.ts';
import type { FactoryJob, FactoryTask, Feature } from '../src/factory/schema.ts';

const config = factoryConfigSchema.parse({
  testCommands: [{ file: process.execPath }],
  endToEndCommands: [{ file: process.execPath }],
});
const now = 100_000;
const plan = { outcome: 'success', summary: 'Ready', findings: [], deliveries: [] };

/**
 * Create a product objective with an explicit FIFO timestamp.
 *
 * @param createdAt - Creation order.
 * @param overrides - Scenario state.
 * @returns Valid objective.
 */
function feature(createdAt: number, overrides: Partial<Feature> = {}): Feature {
  return featureSchema.parse({
    id: randomUUID(),
    objective: 'Fixture',
    phase: 'active',
    productPlan: null,
    plan: null,
    parentIssue: null,
    error: null,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  });
}

/**
 * Create one independent delivery in repository insertion order.
 *
 * @param parent - Owning objective.
 * @param overrides - Scenario state.
 * @returns Valid delivery.
 */
function task(parent: Feature, overrides: Partial<FactoryTask> = {}): FactoryTask {
  return taskSchema.parse({
    id: randomUUID(),
    featureId: parent.id,
    issue: 1,
    parentIssue: 2,
    key: 'fixture',
    title: 'Fixture',
    description: 'Fixture',
    acceptanceCriteria: [],
    dependencies: [],
    phase: 'ready',
    developer: null,
    branch: null,
    worktree: null,
    head: null,
    base: null,
    pr: null,
    prUrl: null,
    merge: null,
    reviews: [],
    feedback: [],
    attempts: 0,
    version: 0,
    error: null,
    updatedAt: now,
    ...overrides,
  });
}

/**
 * Create an occupied role or failed attempt.
 *
 * @param overrides - Job scenario.
 * @returns Valid job.
 */
function job(overrides: Partial<FactoryJob>): FactoryJob {
  return jobSchema.parse({
    id: randomUUID(),
    role: 'developer-1',
    provider: 'codex',
    kind: 'develop',
    taskId: null,
    featureId: null,
    token: randomUUID(),
    state: 'running',
    startedAt: 0,
    finishedAt: null,
    expiresAt: now + 1,
    reservation: 0,
    usageTokens: null,
    pid: null,
    head: null,
    base: null,
    summary: null,
    artifact: 'fixture',
    ...overrides,
  });
}

/**
 * Schedule without processes or remote boundaries.
 *
 * @param features - Objectives.
 * @param tasks - Deliveries in creation order.
 * @param jobs - Existing claims and failures.
 * @returns Ordered eligible intents.
 */
function schedule(features: Feature[], tasks: FactoryTask[], jobs: FactoryJob[] = []): JobIntent[] {
  return jobIntents({ config, features, tasks, jobs, skillRequests: [], now });
}

await test('development alternates objectives and roles with stable feature and task creation order', () => {
  const a = feature(1);
  const b = feature(2);
  const a1 = task(a);
  const a2 = task(a, { updatedAt: 0 });
  const b1 = task(b);
  const b2 = task(b);
  const tasks = [b1, b2, a1, a2];
  const result = schedule([b, a], tasks);
  assert.deepEqual(
    result.slice(0, 4).map((intent) => intent.taskId),
    [a1.id, b1.id, a2.id, b2.id],
  );
  assert.deepEqual(
    result.slice(0, 2).map((intent) => intent.role),
    ['developer-1', 'developer-2'],
  );
  assert.deepEqual(schedule([b, a], tasks), result);
  assert.deepEqual(tasks, [b1, b2, a1, a2], 'Scheduling does not mutate storage order.');
  assert.equal(result.length, 8, 'Keep alternative role candidates for transactional admission.');
});

await test('both planning roles precede the second developer and each is emitted only once', () => {
  const a = feature(1);
  const b = feature(2, { phase: 'queued' });
  const c = feature(3, {
    phase: 'refining',
    productPlan: { ...plan, outcome: 'success', skillActions: [], instructionReceipts: [] },
  });
  const result = schedule([a, c, b, feature(4, { phase: 'queued' }), { ...c, id: randomUUID() }], [task(a), task(a)]);
  assert.deepEqual(
    result.slice(0, 4).map((intent) => intent.kind),
    ['develop', 'plan', 'refine', 'develop'],
  );
  assert.equal(result.filter((intent) => intent.role === 'product-owner').length, 1);
  assert.equal(result.filter((intent) => intent.role === 'team-lead').length, 1);
});

await test('equal feature timestamps and standalone tasks preserve stable insertion order', () => {
  const a = feature(1);
  const b = feature(1);
  const a1 = task(a);
  const b1 = task(b);
  const standalone = task(a, { featureId: null });
  const unknown = task(a, { featureId: randomUUID() });
  const result = schedule([b, a], [standalone, a1, b1, unknown]);
  assert.deepEqual(
    result.slice(0, 4).map((intent) => intent.taskId),
    [b1.id, a1.id, standalone.id, unknown.id],
  );
  const queued = feature(1, { phase: 'queued' });
  assert.deepEqual(
    schedule([queued], []).map((intent) => intent.kind),
    ['plan'],
  );
});

await test('verify final and review retain precedence over development and planning', () => {
  const a = feature(1);
  const final = task(a, {
    phase: 'merge_ready',
    head: 'head',
    base: 'base',
    reviews: (['qa-1', 'qa-2'] as const).map((role) => {
      return {
        role,
        head: 'head',
        base: 'base',
        outcome: 'success',
        summary: 'Approved',
        jobId: randomUUID(),
      };
    }),
  });
  const result = schedule(
    [a, feature(2, { phase: 'queued' })],
    [task(a), task(a, { phase: 'verifying' }), final, task(a, { phase: 'review' })],
  );
  assert.deepEqual(
    result.map((intent) => intent.kind),
    ['verify', 'final', 'review', 'review', 'develop', 'plan', 'develop'],
  );
});

await test('occupied roles and original-owner rework stay exclusive while other objectives proceed', () => {
  const a = feature(1);
  const b = feature(2);
  const repair = task(a, { phase: 'development', developer: 'developer-2', feedback: ['Repair'] });
  const ready = task(b);
  const result = schedule([a, b], [repair, ready]);
  assert.deepEqual(
    result.slice(0, 2).map((intent) => [intent.taskId, intent.role]),
    [
      [repair.id, 'developer-2'],
      [ready.id, 'developer-1'],
    ],
  );
  assert.deepEqual(
    result.filter((intent) => intent.taskId === repair.id).map((intent) => intent.role),
    ['developer-2'],
  );
  const occupied = schedule([a, b], [repair, ready], [job({ role: 'developer-2', taskId: repair.id })]);
  assert.deepEqual(
    occupied.filter((intent) => intent.kind === 'develop').map((intent) => [intent.taskId, intent.role]),
    [[ready.id, 'developer-1']],
  );
  const queued = feature(3, { phase: 'queued' });
  assert.deepEqual(schedule([queued], [], [job({ role: 'product-owner', kind: 'plan' })]), []);
  assert.deepEqual(schedule([queued], [], [job({ role: 'team-lead', kind: 'refine', featureId: queued.id })]), []);
});

await test('dependency completion attempts cooldown and scope replacements still gate candidates', () => {
  const a = feature(1);
  const dependency = task(a, { phase: 'verifying', merge: 'merged' });
  const child = task(a, { dependencies: [dependency.id] });
  const failed = task(a);
  const exhausted = task(a, { attempts: config.maxAttempts });
  const replaced = task(a, { scopeReplacement: randomUUID() });
  const missing = task(a, { dependencies: [randomUUID()] });
  const tasks = [dependency, child, failed, exhausted, replaced, missing];
  const failure = job({ taskId: failed.id, state: 'failed', finishedAt: now });
  assert.deepEqual(
    schedule([a], tasks, [failure]).filter((intent) => intent.kind === 'develop'),
    [],
  );
  const complete = { ...dependency, phase: 'done' as const };
  assert.deepEqual(
    schedule([a], [complete, child])
      .filter((intent) => intent.kind === 'develop')
      .map((intent) => intent.taskId),
    [child.id, child.id],
  );
  assert.equal(schedule([a], [failed], [{ ...failure, finishedAt: now - config.reconcileMs }]).length, 2);
  const replacedFeature = feature(2, { phase: 'queued', scopeReplacement: randomUUID() });
  assert.deepEqual(schedule([replacedFeature], []), []);
});

await test('running development counts toward the slot that queued planning competes for', () => {
  const a = feature(1);
  const b = feature(2, { phase: 'queued' });
  const c = feature(3, {
    phase: 'refining',
    productPlan: { ...plan, outcome: 'success', skillActions: [], instructionReceipts: [] },
  });
  const a1 = task(a, { phase: 'development', developer: 'developer-1' });
  const a2 = task(a);
  const running = [job({ role: 'developer-1', taskId: a1.id, featureId: a.id })];
  const result = schedule([a, b, c], [a1, a2], running);
  assert.deepEqual(
    result.map((intent) => [intent.kind, intent.role]),
    [
      ['plan', 'product-owner'],
      ['refine', 'team-lead'],
      ['develop', 'developer-2'],
    ],
  );
  assert.deepEqual(schedule([a, b, c], [a1, a2], running), result);
  const reviewing = schedule([a, b], [a1, a2, task(a, { phase: 'review' })], running);
  assert.deepEqual(
    reviewing.map((intent) => intent.kind),
    ['review', 'review', 'plan', 'develop'],
  );
});
