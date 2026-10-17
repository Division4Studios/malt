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
import { isDefinitionMet, noteObjective, saveDefinition } from '../src/factory/objective-goals.ts';
import { logObjective, readObjectiveLog } from '../src/factory/objective-log.ts';
import { queueObjective } from '../src/factory/objectives.ts';
import { savePrices } from '../src/factory/price-table.ts';
import { factoryConfigSchema, jobSchema, taskSchema } from '../src/factory/schema.ts';
import { FactoryService } from '../src/factory/service.ts';
import { refreshSpend, saveCaps, spendGate } from '../src/factory/spend.ts';
import { ProjectGitHub } from '../src/github.ts';
import { ProjectLearning } from '../src/learning.ts';
import { Store } from '../src/store.ts';

import { createCleanup, createProject } from './helpers.ts';

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
  noteObjective(repository, { featureId, note: 'Design review moved to Friday.' });
  for (let index = 0; index < 5; index += 1) {
    logObjective(repository.store, featureId, {
      kind: 'check_in',
      actor: 'developer-1',
      body: `step ${String(index)}`,
    });
  }
  const page = readObjectiveLog(repository, { featureId, limit: 3 });
  assert.equal(page.total, 8);
  assert.deepEqual(
    page.entries.map((entry) => entry.body),
    ['step 4', 'step 3', 'step 2'],
  );
  assert.ok(page.next !== null);
  const older = readObjectiveLog(repository, { featureId, before: page.next, limit: 10 });
  assert.equal(older.next, null);
  assert.deepEqual(
    older.entries.map((entry) => entry.kind),
    ['check_in', 'check_in', 'note', 'criteria', 'criteria'],
  );
  assert.throws(() => noteObjective(repository, { featureId: randomUUID(), note: 'x' }), { code: 'NOT_FOUND' });
});
