/**
 * Objective definitions of done and progress logs, and USD spend caps: the
 * operator's checklist fences completion, agents propose or check items only
 * with evidence, the log pages newest first, and a reached cap stops new
 * attempts on its scope until it is raised.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { run } from '../src/database.ts';
import { consoleView } from '../src/factory/console-view.ts';
import { isClaimEligible } from '../src/factory/delivery-controls.ts';
import { isDefinitionMet, noteObjective, saveDefinition } from '../src/factory/objective-goals.ts';
import { logObjective, readObjectiveLog } from '../src/factory/objective-log.ts';
import { queueObjective } from '../src/factory/objectives.ts';
import { savePrices } from '../src/factory/price-table.ts';
import { jobIntents } from '../src/factory/scheduler.ts';
import { factoryConfigSchema, jobSchema, taskSchema } from '../src/factory/schema.ts';
import { FactoryService } from '../src/factory/service.ts';
import {
  announceSpendBlocks,
  drainSpend,
  refreshSpend,
  saveCaps,
  spendGate,
  spendStatus,
} from '../src/factory/spend.ts';
import { ProjectGitHub } from '../src/github.ts';
import { ProjectLearning } from '../src/learning.ts';
import { Store } from '../src/store.ts';

import { createCleanup, createProject, registration } from './helpers.ts';

import type { MeshConfig } from '../src/config.ts';
import type { FactoryRepository } from '../src/factory/repository.ts';
import type { FactoryJob, FactoryTask, Feature } from '../src/factory/schema.ts';
import type { TestContext } from 'node:test';

/** Fixed test clock. */
const NOW = Date.UTC(2026, 9, 1, 12);
/** Settings shared by every scenario. */
const SETTINGS = factoryConfigSchema.parse({
  testCommands: [{ file: process.execPath }],
  endToEndCommands: [{ file: process.execPath }],
});

/**
 * A configured project with a supervisor service.
 *
 * @param t - Owns cleanup.
 * @returns Project paths, store, service and repository.
 */
function project(t: TestContext): {
  mesh: MeshConfig;
  store: Store;
  factory: FactoryService;
  repository: FactoryRepository;
} {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  const store = new Store(mesh, { now: () => NOW });
  const factory = new FactoryService(
    mesh,
    store,
    { github: new ProjectGitHub(mesh), learning: new ProjectLearning(mesh) },
    { home: mesh.root },
  );
  defer(async () => {
    await factory.close();
    store.close();
  });
  const { repository } = factory;
  repository.configure(SETTINGS);
  repository.prepareSender();
  return { mesh, store, factory, repository };
}

/**
 * Store a delivery.
 *
 * @param repository - Project ledger.
 * @param overrides - Scenario state.
 * @returns Stored delivery.
 */
function delivery(repository: FactoryRepository, overrides: Partial<FactoryTask> = {}): FactoryTask {
  const task = taskSchema.parse({
    id: randomUUID(),
    featureId: null,
    issue: repository.tasks().length + 10,
    parentIssue: 1,
    key: `key-${String(repository.tasks().length)}`,
    title: 'Card',
    description: 'Card',
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
    updatedAt: NOW,
    ...overrides,
  });
  repository.addTask(task);
  return task;
}

/**
 * Record one finished attempt, with a provider-reported cost when given.
 *
 * @param context - Project paths and ledger.
 * @param context.mesh - Project paths.
 * @param context.repository - Project ledger.
 * @param fields - Job fields.
 * @param costUsd - Reported cost, or undefined for an unpriced attempt without a stream.
 * @returns The stored attempt.
 */
function attempt(
  context: { mesh: MeshConfig; repository: FactoryRepository },
  fields: Partial<FactoryJob>,
  costUsd?: number,
): FactoryJob {
  const id = randomUUID();
  const job = jobSchema.parse({
    id,
    role: 'developer-1',
    provider: 'claude',
    kind: 'develop',
    taskId: null,
    featureId: null,
    token: randomUUID(),
    state: 'succeeded',
    startedAt: NOW - 60_000,
    finishedAt: NOW - 30_000,
    expiresAt: 0,
    reservation: 0,
    usageTokens: null,
    pid: null,
    head: null,
    base: null,
    summary: null,
    artifact: path.join(context.mesh.directory, 'factory', 'jobs', id),
    step: null,
    ...fields,
  });
  if (costUsd !== undefined) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- The directory is inside the test's own temporary project.
    mkdirSync(job.artifact, { recursive: true });
    const result = {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'ok',
      usage: { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      total_cost_usd: costUsd,
      num_turns: 1,
    };
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- The file is inside the test's own temporary project.
    writeFileSync(path.join(job.artifact, 'stdout.log'), JSON.stringify(result));
  }
  run(
    context.repository.store.db,
    'INSERT INTO factory_jobs VALUES(?,?,?,?)',
    job.id,
    job.role,
    job.state,
    JSON.stringify(job),
  );
  return job;
}

/**
 * Read one objective.
 *
 * @param repository - Project ledger.
 * @param featureId - Objective to read.
 * @returns The stored objective.
 */
function objective(repository: FactoryRepository, featureId: string): Feature {
  const found = repository.features().find((candidate) => candidate.id === featureId);
  assert.ok(found !== undefined);
  return found;
}

/**
 * A running claim on a delivery, for admission checks.
 *
 * @param taskId - Delivery.
 * @returns Proposed claim.
 */
function claimOn(taskId: string): FactoryJob {
  return jobSchema.parse({
    id: randomUUID(),
    role: 'developer-1',
    provider: 'codex',
    kind: 'develop',
    taskId,
    featureId: null,
    token: randomUUID(),
    state: 'running',
    startedAt: NOW,
    finishedAt: null,
    expiresAt: NOW + 60_000,
    reservation: 1,
    usageTokens: null,
    pid: null,
    head: null,
    base: null,
    summary: null,
    artifact: 'fixture',
  });
}

await test('a reached delivery cap stops new attempts until the operator raises it', async (t) => {
  const context = project(t);
  const { repository } = context;
  const spent = delivery(repository);
  const other = delivery(repository);
  attempt(context, { taskId: spent.id }, 0.75);
  attempt(context, { taskId: spent.id }, 0.5);
  assert.equal(await refreshSpend(repository, context.mesh), 2);
  assert.equal(await refreshSpend(repository, context.mesh), 0, 'Recorded attempts are not priced again.');

  assert.equal(spendGate(repository).block({ taskId: spent.id, featureId: null }), null, 'No caps, no block.');
  saveCaps(repository, { caps: { deliveryDefault: 1 }, expectedRevision: 0 });
  assert.throws(() => saveCaps(repository, { caps: {}, expectedRevision: 0 }), { code: 'INVALID_REVISION' });
  const block = spendGate(repository).block({ taskId: spent.id, featureId: null });
  assert.ok(block !== null);
  assert.deepEqual([block.scope, block.reason], ['delivery', 'cap']);
  assert.match(block.message, /\$1\.25 of \$1\.00/v);
  assert.equal(spendGate(repository).block({ taskId: other.id, featureId: null }), null);
  assert.equal(isClaimEligible(repository, claimOn(spent.id)), false, 'The claim transaction honours the cap.');
  assert.equal(isClaimEligible(repository, claimOn(other.id)), true);

  const gate = spendGate(repository);
  const intents = jobIntents({
    config: SETTINGS,
    tasks: repository.tasks(),
    features: [],
    jobs: [],
    skillRequests: [],
    now: NOW,
    isSpendBlocked: (target) => gate.block(target) !== null,
  });
  assert.ok(
    intents.every((intent) => intent.taskId !== spent.id),
    'Scheduling skips the capped delivery.',
  );
  assert.ok(intents.some((intent) => intent.taskId === other.id));

  assert.equal(announceSpendBlocks(repository, gate).length, 1);
  assert.equal(announceSpendBlocks(repository, gate).length, 0, 'Each stopped scope is announced once per revision.');
  const item = consoleView(repository).inbox.open.find((entry) => entry.kind === 'spend_cap');
  assert.equal(item?.taskId, spent.id);

  const status = spendStatus(repository);
  assert.deepEqual(
    status.usage.filter((row) => row.scope === 'delivery').map((row) => [row.id, row.usd, row.cap, row.blocked]),
    [
      [spent.id, 1.25, 1, 'cap'],
      [other.id, 0, 1, null],
    ],
  );
  assert.deepEqual(
    status.choices.filter((choice) => choice.scope === 'delivery'),
    [],
    'Capped deliveries are not offered again.',
  );

  saveCaps(repository, { caps: { deliveryDefault: 1, deliveries: { [spent.id]: 2 } }, expectedRevision: 1 });
  assert.equal(spendGate(repository).block({ taskId: spent.id, featureId: null }), null, 'Raising the cap resumes it.');
  saveCaps(repository, { caps: { project: 1, windowDays: 7 }, expectedRevision: 2 });
  assert.equal(spendGate(repository).block({ taskId: null, featureId: null })?.scope, 'project');
  const offered = spendStatus(repository).choices.filter((choice) => choice.scope === 'delivery');
  assert.deepEqual(
    offered.map((choice) => choice.id).toSorted((left, right) => left.localeCompare(right)),
    [spent.id, other.id].toSorted((left, right) => left.localeCompare(right)),
    'Uncapped deliveries can be capped, including one that has not run.',
  );
});

await test('every settled attempt is recorded before a capped scope is admitted again', async (t) => {
  const context = project(t);
  const { repository } = context;
  const busy = delivery(repository);
  saveCaps(repository, { caps: { deliveryDefault: 2.05 }, expectedRevision: 0 });
  for (let index = 0; index < 25; index += 1) {
    attempt(context, { taskId: busy.id }, 0.1);
  }
  await drainSpend(repository, context.mesh);
  assert.equal(await refreshSpend(repository, context.mesh), 0, 'Nothing is left unrecorded.');
  assert.equal(
    spendGate(repository).block({ taskId: busy.id, featureId: null })?.reason,
    'cap',
    'The 21st and later attempts count before admission, not a pass later.',
  );
});

await test('unpriced attempts block a capped scope only under the block policy, and prices re-estimate', async (t) => {
  const context = project(t);
  const { repository } = context;
  const feature = queueObjective(repository, { objective: 'Billing retries' });
  const task = delivery(repository, { featureId: feature.featureId });
  attempt(context, { taskId: task.id, provider: 'codex' });
  await refreshSpend(repository, context.mesh);
  saveCaps(repository, { caps: { objectiveDefault: 5 }, expectedRevision: 0 });
  assert.equal(spendGate(repository).block({ taskId: task.id, featureId: null }), null, 'Ignored by default.');
  saveCaps(repository, { caps: { objectiveDefault: 5, unpriced: 'block' }, expectedRevision: 1 });
  const block = spendGate(repository).block({ taskId: task.id, featureId: null });
  assert.ok(block !== null);
  assert.deepEqual([block.scope, block.reason], ['objective', 'unpriced']);
  assert.equal(spendGate(repository).block({ taskId: null, featureId: feature.featureId })?.reason, 'unpriced');

  savePrices(repository.store, { prices: [], expectedRevision: 0 });
  assert.equal(await refreshSpend(repository, context.mesh), 1, 'A new price table re-estimates unpriced spend.');
});

await test('an attempt that ran no provider costs nothing and never blocks as unpriced', async (t) => {
  const context = project(t);
  const { repository } = context;
  const feature = queueObjective(repository, { objective: 'Waits for CI' });
  const task = delivery(repository, { featureId: feature.featureId });
  // An unpaid gate settles with zero usage and no provider stream.
  attempt(context, { taskId: task.id, state: 'failed', usageTokens: 0 });
  await refreshSpend(repository, context.mesh);
  saveCaps(repository, { caps: { objectiveDefault: 5, unpriced: 'block' }, expectedRevision: 0 });
  assert.equal(spendGate(repository).block({ taskId: task.id, featureId: null }), null);
  assert.equal(spendGate(repository).block({ taskId: null, featureId: feature.featureId }), null);
});

await test('the definition of done fences completion and every change is logged', (t) => {
  const { repository } = project(t);
  const { featureId } = queueObjective(repository, { objective: 'Checkout redesign' });
  const feature = (): Feature => objective(repository, featureId);
  assert.equal(isDefinitionMet(feature()), true, 'An empty checklist is met.');
  const saved = saveDefinition(repository, {
    featureId,
    expectedUpdatedAt: feature().updatedAt,
    items: [
      { text: 'Mobile checkout passes the accessibility audit', state: 'open' },
      { text: 'Conversion dashboard updated', state: 'waived', evidence: 'Tracked separately' },
    ],
  });
  assert.deepEqual([saved.met, saved.total], [1, 2]);
  assert.equal(isDefinitionMet(feature()), false);
  assert.throws(
    () => saveDefinition(repository, { featureId, expectedUpdatedAt: feature().updatedAt - 1, items: [] }),
    { code: 'INVALID_REVISION' },
  );
  const [first, second] = feature().definitionOfDone ?? [];
  assert.ok(first !== undefined && second !== undefined);
  assert.equal(second.by, 'operator');
  saveDefinition(repository, {
    featureId,
    expectedUpdatedAt: feature().updatedAt,
    items: [
      { id: first.id, text: first.text, state: 'checked', evidence: 'Audit report #12' },
      { id: second.id, text: second.text, state: 'waived' },
    ],
  });
  assert.equal(isDefinitionMet(feature()), true);
  assert.equal(feature().definitionOfDone?.[1]?.evidence, 'Tracked separately', 'Unchanged items keep their evidence.');
  assert.throws(
    () => {
      saveDefinition(repository, {
        featureId,
        expectedUpdatedAt: feature().updatedAt,
        items: [
          { id: first.id, text: first.text, state: 'checked' },
          { id: first.id, text: 'Another requirement', state: 'checked' },
        ],
      });
    },
    { code: 'INVALID_INPUT' },
    'An item id appears once.',
  );
  saveDefinition(repository, {
    featureId,
    expectedUpdatedAt: feature().updatedAt,
    items: [
      { id: first.id, text: 'Desktop checkout passes the audit', state: 'checked' },
      { id: second.id, text: second.text, state: 'waived' },
    ],
  });
  const edited = feature().definitionOfDone?.[0];
  assert.equal(edited?.by, 'operator', 'An edited checked item is the operator’s claim.');
  assert.equal(edited.evidence, null, 'Evidence for the old text is not kept.');
  noteObjective(repository, { featureId, note: 'Design review moved to Friday.' });
  for (let index = 0; index < 5; index += 1) {
    logObjective(repository.store, featureId, {
      kind: 'check_in',
      actor: 'developer-1',
      body: `step ${String(index)}`,
    });
  }
  const page = readObjectiveLog(repository, { featureId, limit: 3 });
  assert.equal(page.total, 9);
  assert.deepEqual(
    page.entries.map((entry) => entry.body),
    ['step 4', 'step 3', 'step 2'],
  );
  assert.ok(page.next !== null);
  const older = readObjectiveLog(repository, { featureId, before: page.next, limit: 10 });
  assert.equal(older.next, null);
  assert.deepEqual(
    older.entries.map((entry) => entry.kind),
    ['check_in', 'check_in', 'note', 'criteria', 'criteria', 'criteria'],
  );
  assert.throws(() => noteObjective(repository, { featureId: randomUUID(), note: 'x' }), { code: 'NOT_FOUND' });
});

await test('managed planning roles propose and verification roles check items, only with a live claim', async (t) => {
  const { store, factory, repository } = project(t);
  const { featureId } = queueObjective(repository, { objective: 'Search relevance' });
  const current = (): Feature => objective(repository, featureId);
  saveDefinition(repository, {
    featureId,
    expectedUpdatedAt: current().updatedAt,
    items: [{ text: 'Top-10 precision above 0.8', state: 'open' }],
  });
  const task = delivery(repository, { featureId, phase: 'merge_ready', head: 'h', base: 'b' });
  const lead = store.register({ ...registration('factory-team-lead'), runtime: 'factory-managed' });
  const tester = store.register({ ...registration('factory-final-tester'), runtime: 'factory-managed' });
  const running = (role: FactoryJob['role'], kind: FactoryJob['kind'], scope: Partial<FactoryJob>): FactoryJob => {
    const job = jobSchema.parse({
      ...claimOn(task.id),
      role,
      kind,
      taskId: null,
      featureId: null,
      ...scope,
    });
    run(store.db, 'INSERT INTO factory_jobs VALUES(?,?,?,?)', job.id, job.role, job.state, JSON.stringify(job));
    return job;
  };
  const evidence = 'Measured on the fixture corpus: 0.84.';
  await assert.rejects(factory.execute('factory_objective_check', { text: 'Latency budget', evidence }, lead.id), {
    code: 'FACTORY_GATED',
  });
  running('team-lead', 'refine', { featureId });
  const proposal = await factory.execute(
    'factory_objective_check',
    { text: 'p95 latency below 300 ms', evidence: 'The objective mentions interactive search.' },
    lead.id,
  );
  assert.deepEqual(
    objective(repository, featureId).definitionOfDone?.map((item) => item.state),
    ['open', 'proposed'],
  );
  assert.ok(typeof proposal === 'object' && proposal !== null);
  await assert.rejects(
    factory.execute('factory_objective_check', { itemId: current().definitionOfDone?.[0]?.id, evidence }, lead.id),
    { code: 'FACTORY_GATED' },
    'Planning roles may not check items.',
  );
  await assert.rejects(factory.execute('factory_objective_check', { evidence }, lead.id), { code: 'INVALID_INPUT' });

  running('final-tester', 'final', { taskId: task.id });
  const target = current().definitionOfDone?.[0];
  assert.ok(target !== undefined);
  await factory.execute('factory_objective_check', { itemId: target.id, evidence }, tester.id);
  assert.equal(current().definitionOfDone?.[0]?.by, 'final-tester');
  const view = consoleView(repository);
  assert.equal(view.goals.find((goal) => goal.featureId === featureId)?.definition.proposed, 1);
  assert.equal(view.inbox.open.find((item) => item.kind === 'done_criteria')?.featureId, featureId);
  const kinds = readObjectiveLog(repository, { featureId }).entries.map((entry) => entry.body.slice(0, 8));
  assert.deepEqual(kinds, ['Checked ', 'Proposed', 'Definiti']);
});
