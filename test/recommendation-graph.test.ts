/** @file Approved consolidations move dependents onto the survivor and park retired deliveries without losing work. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { advanceRecommendations } from '../src/factory/recommendation-execution.ts';
import { FactoryRepository } from '../src/factory/repository.ts';
import { jobIntents } from '../src/factory/scheduler.ts';
import { factoryConfigSchema, taskSchema } from '../src/factory/schema.ts';
import { Store } from '../src/store.ts';

import { proposal, readObservation } from './fixtures/recommendations.ts';
import { createCleanup, createProject } from './helpers.ts';

import type { ExecutionContext } from '../src/factory/recommendation-execution.ts';
import type { FactoryTask, RecommendationBody } from '../src/factory/schema.ts';
import type { TestContext } from 'node:test';

/** Observed revision recorded in every fixture proposal. */
const REVISION = 'a'.repeat(64);
/** Minimal project policy. */
const settings = factoryConfigSchema.parse({
  testCommands: [{ file: process.execPath }],
  endToEndCommands: [{ file: process.execPath }],
});

/**
 * A stored delivery for one ticket.
 *
 * @param repository - Project ledger.
 * @param issue - Ticket number.
 * @param fields - Phase, dependencies and owned source.
 * @returns The stored delivery.
 */
function delivery(repository: FactoryRepository, issue: number, fields: Partial<FactoryTask> = {}): FactoryTask {
  const task = taskSchema.parse({
    id: randomUUID(),
    featureId: null,
    issue,
    parentIssue: 1,
    key: `issue-${String(issue)}`,
    title: `Delivery ${String(issue)}`,
    description: 'Fixture delivery.',
    acceptanceCriteria: ['Works'],
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
    updatedAt: 1,
    ...fields,
  });
  repository.addTask(task);
  return repository.task(task.id);
}

/** A ledger with one approved consolidation and its three deliveries. */
interface Fixture {
  /** Project ledger. */
  readonly repository: FactoryRepository;
  /** Executor context with a fixture issue reader. */
  readonly context: ExecutionContext;
  /** Recommendation id. */
  readonly id: string;
  /** Survivor's delivery (#10). */
  readonly survivor: FactoryTask;
  /** Retired delivery (#11), with owned source. */
  readonly retired: FactoryTask;
  /** Delivery that depended on the retired one (#12). */
  readonly dependent: FactoryTask;
}

/**
 * A configured project ledger with an approved consolidation of #11 into #10.
 *
 * @param t - Owns cleanup.
 * @param assignments - Recorded affected deliveries, or the actual ones when omitted.
 * @returns Ledger, record id and the three deliveries.
 */
function fixture(t: TestContext, assignments?: (ids: string[]) => string[]): Fixture {
  const defer = createCleanup(t);
  const store = new Store(createProject(defer));
  defer(() => {
    store.close();
  });
  const repository = new FactoryRepository(store);
  repository.configure(settings);
  const survivor = delivery(repository, 10);
  const retired = delivery(repository, 11, {
    phase: 'development',
    developer: 'developer-1',
    branch: 'malt/issue-11',
    worktree: '/work/issue-11',
    head: 'b'.repeat(40),
  });
  const dependent = delivery(repository, 12, { dependencies: [retired.id] });
  const ids = [survivor.id, retired.id];
  const body: RecommendationBody = {
    ...proposal,
    kind: 'consolidate',
    tickets: [10, 11],
    observedIssues: [10, 11].map((issue) => ({ issue, revision: REVISION })),
    survivor: 10,
    affectedAssignments: assignments === undefined ? ids : assignments(ids),
  };
  const record = repository.recommendations.propose(body);
  const fence = { id: record.id, revision: record.revision, reason: 'Fixture' };
  repository.recommendations.transition({ ...fence, state: 'proposed', next: 'awaiting_human' });
  repository.recommendations.transition({ ...fence, state: 'awaiting_human', next: 'approved' });
  const context = { repository, remote: { observedIssue: readObservation } };
  return { repository, context, id: record.id, survivor, retired, dependent };
}

await test('dependents move to the survivor and the retired delivery is parked with its work intact', async (t) => {
  const { repository, context, id, survivor, retired, dependent } = fixture(t);
  await advanceRecommendations(context);
  assert.equal(repository.recommendations.get(id)?.state, 'applying');
  assert.deepEqual(repository.task(dependent.id).dependencies, [survivor.id]);
  const parked = repository.task(retired.id);
  assert.match(parked.hold?.reason ?? '', /Consolidated into #10/v);
  assert.deepEqual(
    [parked.phase, parked.branch, parked.worktree, parked.head, parked.developer],
    ['development', 'malt/issue-11', '/work/issue-11', 'b'.repeat(40), 'developer-1'],
  );
  const before = JSON.stringify(repository.tasks());
  await advanceRecommendations(context);
  assert.equal(JSON.stringify(repository.tasks()), before, 'replay changes nothing');
  repository.editTask(survivor.id, (task) => ({ ...task, phase: 'done' }));
  const intents = jobIntents({
    config: settings,
    tasks: repository.tasks(),
    features: [],
    jobs: [],
    skillRequests: [],
    now: Date.now(),
  });
  assert.ok(
    intents.some((intent) => intent.taskId === dependent.id),
    'the dependent runs once the survivor is done',
  );
  assert.ok(
    intents.every((intent) => intent.taskId !== retired.id),
    'the parked delivery does not start again',
  );
});

await test('changed affected deliveries, an orphaned dependent or a cycle make the record stale before any change', async (t) => {
  const changed = fixture(t, (ids) => ids.slice(0, 1));
  await advanceRecommendations(changed.context);
  assert.equal(changed.repository.recommendations.get(changed.id)?.state, 'stale');
  assert.equal(changed.repository.task(changed.retired.id).hold, null);
  assert.deepEqual(changed.repository.task(changed.dependent.id).dependencies, [changed.retired.id]);
  assert.ok(changed.repository.effects().every((effect) => !effect.id.startsWith('recommendation-')));

  const orphan = fixture(t);
  const other = orphan.repository.recommendations.get(orphan.id);
  assert.ok(other !== null);
  orphan.repository.recommendations.transition({
    id: other.id,
    revision: other.revision,
    state: 'approved',
    next: 'stale',
    reason: 'Fixture',
  });
  const duplicate = orphan.repository.recommendations.propose({
    ...proposal,
    kind: 'duplicate',
    tickets: [11, 14],
    observedIssues: [11, 14].map((issue) => ({ issue, revision: REVISION })),
    survivor: 14,
    affectedAssignments: [orphan.retired.id],
  });
  const fence = { id: duplicate.id, revision: duplicate.revision, reason: 'Fixture' };
  orphan.repository.recommendations.transition({ ...fence, state: 'proposed', next: 'awaiting_human' });
  orphan.repository.recommendations.transition({ ...fence, state: 'awaiting_human', next: 'approved' });
  await advanceRecommendations(orphan.context);
  assert.match(orphan.repository.recommendations.get(duplicate.id)?.audit.at(-1)?.reason ?? '', /no local delivery/v);
  assert.equal(orphan.repository.task(orphan.retired.id).hold, null);

  const cyclic = fixture(t);
  cyclic.repository.editTask(cyclic.survivor.id, (task) => ({ ...task, dependencies: [cyclic.dependent.id] }));
  await advanceRecommendations(cyclic.context);
  const record = cyclic.repository.recommendations.get(cyclic.id);
  assert.equal(record?.state, 'stale');
  assert.match(record.audit.at(-1)?.reason ?? '', /cycle/v);
  assert.deepEqual(cyclic.repository.task(cyclic.dependent.id).dependencies, [cyclic.retired.id]);
});
