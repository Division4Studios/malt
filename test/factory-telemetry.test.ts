/**
 * Attempt metrics, cost sources, the revision-fenced price table, cost
 * aggregation (including a DST day boundary and waste), attempt filtering
 * and pagination, transcript pages and artifact confinement.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { run } from '../src/database.ts';
import { FactoryRepository } from '../src/factory/repository.ts';
import { jobSchema, taskSchema } from '../src/factory/schema.ts';
import * as telemetry from '../src/factory/telemetry-controls.ts';
import { attemptPageSchema, costSummarySchema, transcriptPageSchema } from '../src/factory/telemetry-schema.ts';
import { MeshError } from '../src/protocol.ts';
import { Store } from '../src/store.ts';

import { createCleanup, createProject } from './helpers.ts';

import type { MeshConfig } from '../src/config.ts';
import type { FactoryJob } from '../src/factory/schema.ts';
import type { TestContext } from 'node:test';

/** Fixed test clock: 2026-03-09T12:00:00Z, the Monday after the 2026 US DST change. */
const NOW = Date.UTC(2026, 2, 9, 12);

/**
 * Open an isolated project ledger with a fixed clock.
 *
 * @param t - Running test.
 * @returns Project paths and its repository.
 */
function project(t: TestContext): { mesh: MeshConfig; repository: FactoryRepository } {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  const store = new Store(mesh, { now: () => NOW });
  defer(() => {
    store.close();
  });
  return { mesh, repository: new FactoryRepository(store) };
}

/**
 * Record one attempt and optionally its provider stream.
 *
 * @param context - Project and repository.
 * @param fields - Job fields overriding the defaults.
 * @param stream - Provider events written to stdout.log, or undefined for no stream.
 * @returns The stored attempt.
 */
function attempt(
  context: { mesh: MeshConfig; repository: FactoryRepository },
  fields: Partial<FactoryJob>,
  stream?: unknown[],
): FactoryJob {
  const id = fields.id ?? randomUUID();
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
  if (stream !== undefined) {
    writeArtifact(job.artifact, 'stdout.log', stream.map((event) => JSON.stringify(event)).join('\n'));
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
 * Write one file into a test-owned directory.
 *
 * @param directory - Directory inside the test's temporary project.
 * @param file - File name.
 * @param content - File content.
 */
function writeArtifact(directory: string, file: string, content: string): void {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- The directory is inside the test's own temporary project.
  mkdirSync(directory, { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- The file is inside the test's own temporary project.
  writeFileSync(path.join(directory, file), content);
}

/**
 * A Claude final event with optional reported cost.
 *
 * @param cost - Provider-reported cost, or undefined to omit it.
 * @returns Result event.
 */
function claudeResult(cost?: number): Record<string, unknown> {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'ok',
    usage: { input_tokens: 1000, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    ...(cost !== undefined && { total_cost_usd: cost }),
    num_turns: 1,
  };
}

/** A Codex turn with 2M uncached input, 1M cached input and 1M output tokens. */
const codexTurn = {
  type: 'turn.completed',
  usage: { input_tokens: 3_000_000, cached_input_tokens: 1_000_000, output_tokens: 1_000_000 },
};

/** A price row for the fixture Codex model. */
const price = { model: 'gpt-fixture', input: 2, cachedInput: 0.5, cacheWrite: 2.5, output: 8 };

void test('cost source is reported, estimated from an exact model price, or explicitly unpriced', async (t) => {
  const context = project(t);
  const { mesh, repository } = context;
  attempt(context, { startedAt: NOW - 4000 }, [
    { type: 'system', subtype: 'init', model: 'claude-fixture' },
    claudeResult(1.5),
  ]);
  const estimated = attempt(
    context,
    {
      provider: 'codex',
      startedAt: NOW - 3000,
      finishedAt: NOW - 1000,
      routing: { tier: 'standard', model: 'gpt-fixture', reason: 'r', skillNames: [] },
    },
    [codexTurn],
  );
  attempt(
    context,
    {
      provider: 'codex',
      startedAt: NOW - 2000,
      routing: { tier: 'standard', model: 'gpt-other', reason: 'r', skillNames: [] },
    },
    [codexTurn],
  );
  attempt(context, { startedAt: NOW - 1000, usageTokens: 42 });
  assert.deepEqual(telemetry.prices(repository, { prices: [price], expectedRevision: 0 }).revision, 1);
  const page = attemptPageSchema.parse(await telemetry.attempts(repository, mesh, {}));
  const byStart = page.attempts.map((row) => [row.model, row.metrics.cost.source, row.metrics.cost.usd]);
  assert.deepEqual(byStart, [
    [null, 'unpriced', null],
    ['gpt-other', 'unpriced', null],
    ['gpt-fixture', 'estimated', 2 * 2 + 1 * 0.5 + 1 * 8],
    ['claude-fixture', 'reported', 1.5],
  ]);
  const missing = page.attempts[0]?.metrics;
  assert.ok(missing !== undefined);
  assert.equal(missing.stream.available, false);
  assert.equal(missing.tokens.total, 42, 'Without a stream, only the settled total is known.');
  assert.equal(missing.tokens.input, null);
  const codex = page.attempts[2]?.metrics;
  assert.deepEqual(codex?.tokens, {
    input: 2_000_000,
    cacheRead: 1_000_000,
    cacheWrite: 0,
    output: 1_000_000,
    reasoning: null,
    total: 4_000_000,
  });
  assert.equal(codex.durationMs, 2000);
  const transcript = transcriptPageSchema.parse(await telemetry.transcript(repository, mesh, { jobId: estimated.id }));
  assert.equal(transcript.metrics.cost.source, 'estimated');
});

void test('the price table is revision-fenced, validated and ships empty', (t) => {
  const { repository } = project(t);
  assert.deepEqual(costSummarySchema.shape.prices.parse({ revision: 0, prices: [], updatedAt: null }), {
    revision: 0,
    prices: [],
    updatedAt: null,
  });
  const saved = telemetry.prices(repository, { prices: [price], expectedRevision: 0 });
  assert.deepEqual(saved, { revision: 1, prices: [price], updatedAt: NOW });
  assert.throws(
    () => telemetry.prices(repository, { prices: [], expectedRevision: 0 }),
    (thrown: unknown) => thrown instanceof MeshError && thrown.code === 'INVALID_REVISION',
  );
  assert.throws(() => telemetry.prices(repository, { prices: [price, price], expectedRevision: 1 }));
  assert.throws(() => telemetry.prices(repository, { prices: [{ ...price, input: -1 }], expectedRevision: 1 }));
  assert.equal(telemetry.prices(repository, { prices: [], expectedRevision: 1 }).revision, 2);
});

void test('costs bucket calendar days across a DST change and report waste and coverage', async (t) => {
  const context = project(t);
  const { mesh, repository } = context;
  const task = taskSchema.parse({
    id: randomUUID(),
    featureId: null,
    issue: 7,
    parentIssue: 1,
    key: 'costed',
    title: 'Costed delivery',
    description: 'd',
    acceptanceCriteria: ['a'],
    dependencies: [],
    phase: 'development',
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
  });
  repository.addTask(task);
  // 2026-03-08 04:30Z is 23:30 EST on March 7.
  attempt(context, { startedAt: Date.UTC(2026, 2, 8, 4, 30), role: 'qa-1', kind: 'review' }, [claudeResult(1)]);
  // 2026-03-08 05:30Z is 00:30 EST on March 8 (before the 02:00 change).
  attempt(context, { startedAt: Date.UTC(2026, 2, 8, 5, 30), state: 'failed', taskId: task.id }, [claudeResult(2)]);
  // 2026-03-09 03:30Z is 23:30 EDT on March 8, though already March 9 in UTC.
  attempt(context, { startedAt: Date.UTC(2026, 2, 9, 3, 30), state: 'interrupted', taskId: task.id }, [
    claudeResult(4),
  ]);
  attempt(context, { startedAt: Date.UTC(2026, 2, 9, 11), provider: 'codex' }, [codexTurn]);
  attempt(context, { startedAt: Date.UTC(2026, 1, 1) }, [claudeResult(100)]);
  const summary = costSummarySchema.parse(
    await telemetry.costs(repository, mesh, { days: 7, timeZone: 'America/New_York' }),
  );
  assert.equal(summary.from, '2026-03-03');
  assert.equal(summary.to, '2026-03-09');
  const days = Object.fromEntries(summary.daily.map((day) => [day.day, [day.totalUsd, day.attempts]]));
  assert.deepEqual(days['2026-03-07'], [1, 1]);
  assert.deepEqual(days['2026-03-08'], [6, 2]);
  assert.deepEqual(days['2026-03-09'], [0, 1]);
  assert.equal(summary.daily.length, 7);
  assert.deepEqual(summary.daily.find((day) => day.day === '2026-03-08')?.byRole, { 'developer-1': 6 });
  assert.deepEqual(summary.totals, {
    costUsd: 7,
    attempts: 4,
    pricedAttempts: 3,
    reportedAttempts: 3,
    estimatedAttempts: 0,
    unpricedAttempts: 1,
    averagePerPricedAttempt: 7 / 3,
    wasteUsd: 6,
    wasteAttempts: 2,
  });
  assert.deepEqual(summary.roles, ['developer-1', 'qa-1']);
  assert.deepEqual(
    summary.byDelivery.map((group) => [group.label, group.costUsd, group.attempts]),
    [
      ['#7 Costed delivery', 6, 2],
      ['Planning and maintenance', 1, 2],
    ],
  );
  assert.deepEqual(
    summary.topAttempts.map((row) => row.costUsd),
    [4, 2, 1],
  );
  assert.equal(summary.byModel.find((group) => group.key === 'codex/unknown model')?.unpricedAttempts, 1);
  assert.equal(summary.tokens.cacheRead, 1_000_000);
  assert.equal(summary.tokens.cacheHitPercent, (1_000_000 / (3000 + 2_000_000 + 1_000_000)) * 100);
  const utc = costSummarySchema.parse(await telemetry.costs(repository, mesh, { days: 1, timeZone: 'UTC' }));
  assert.deepEqual([utc.from, utc.totals.attempts, utc.totals.costUsd], ['2026-03-09', 2, 4]);
  await assert.rejects(telemetry.costs(repository, mesh, { days: 3 }));
  await assert.rejects(telemetry.costs(repository, mesh, { days: 7, timeZone: 'Mars/Olympus' }));
});

void test('attempt listings filter, search and paginate with a stable cursor', async (t) => {
  const context = project(t);
  const { mesh, repository } = context;
  const featureId = randomUUID();
  const task = taskSchema.parse({
    id: randomUUID(),
    featureId,
    issue: 9,
    parentIssue: 1,
    key: 'searchable',
    title: 'Searchable widget',
    description: 'd',
    acceptanceCriteria: ['a'],
    dependencies: [],
    phase: 'review',
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
  });
  repository.addTask(task);
  const tie = NOW - 5000;
  const jobs = [
    attempt(context, { startedAt: tie, role: 'qa-1', kind: 'review', taskId: task.id, state: 'failed' }),
    attempt(context, { startedAt: tie, role: 'qa-2', kind: 'review', taskId: task.id }),
    attempt(context, { startedAt: NOW - 4000, role: 'team-lead', kind: 'plan', featureId }),
    attempt(context, { startedAt: NOW - 3000, role: 'developer-1', summary: 'Implemented the parser' }),
    attempt(context, {
      startedAt: NOW - 2000,
      role: 'developer-2',
      provider: 'codex',
      state: 'running',
      finishedAt: null,
    }),
  ];
  const seen: string[] = [];
  let cursor: string | undefined;
  do {
    const page = attemptPageSchema.parse(
      await telemetry.attempts(repository, mesh, { limit: 2, ...(cursor !== undefined && { cursor }) }),
    );
    assert.ok(page.attempts.length <= 2);
    seen.push(...page.attempts.map((row) => row.id));
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  const tied = jobs
    .slice(0, 2)
    .map((job) => job.id)
    .toSorted((left, right) => left.localeCompare(right))
    .toReversed();
  assert.deepEqual(seen, [jobs[4]?.id, jobs[3]?.id, jobs[2]?.id, ...tied]);

  /**
   * List ids for one filter.
   *
   * @param filters - Listing filters.
   * @returns Matching ids, newest first.
   */
  const ids = async (filters: Record<string, unknown>): Promise<string[]> => {
    const page = attemptPageSchema.parse(await telemetry.attempts(repository, mesh, filters));
    return page.attempts.map((row) => row.id);
  };
  assert.deepEqual(await ids({ role: 'qa-1' }), [jobs[0]?.id]);
  assert.deepEqual(await ids({ state: 'running' }), [jobs[4]?.id]);
  assert.deepEqual(await ids({ provider: 'codex' }), [jobs[4]?.id]);
  assert.deepEqual(await ids({ kind: 'plan' }), [jobs[2]?.id]);
  assert.deepEqual((await ids({ featureId })).length, 3, 'Objective filters include its deliveries.');
  assert.deepEqual(
    (await ids({ taskId: task.id })).toSorted((left, right) => left.localeCompare(right)),
    tied.toSorted((left, right) => left.localeCompare(right)),
  );
  assert.deepEqual(await ids({ query: 'PARSER' }), [jobs[3]?.id]);
  assert.deepEqual((await ids({ query: 'widget' })).length, 2);
  assert.deepEqual(await ids({ since: NOW - 3500, until: NOW - 2500 }), [jobs[3]?.id]);
  const rows = attemptPageSchema.parse(await telemetry.attempts(repository, mesh, { role: 'qa-1' })).attempts;
  const [qaRow] = rows;
  assert.ok(qaRow !== undefined);
  assert.deepEqual(qaRow.task, { issue: 9, label: '#9', title: 'Searchable widget' });
  assert.equal(qaRow.featureId, featureId);
  await assert.rejects(telemetry.attempts(repository, mesh, { limit: 101 }));
  await assert.rejects(telemetry.attempts(repository, mesh, { cursor: 'nope' }));
});

void test('transcript pages advance by node cursor and artifacts outside the project are refused', async (t) => {
  const context = project(t);
  const { mesh, repository } = context;
  const events: unknown[] = [];
  for (let index = 0; index < 5; index += 1) {
    events.push({ type: 'assistant', message: { content: [{ type: 'text', text: `step ${String(index)}` }] } });
  }
  const job = attempt(context, {}, events);
  writeArtifact(job.artifact, 'prompt.md', 'Implement the thing.\nCarefully.');
  const first = transcriptPageSchema.parse(await telemetry.transcript(repository, mesh, { jobId: job.id, limit: 4 }));
  assert.deepEqual(
    first.nodes.map((node) => node.kind),
    ['input', 'assistant', 'assistant', 'assistant'],
  );
  assert.equal(first.nodes[0]?.text, 'Implement the thing.\nCarefully.');
  assert.equal(first.nextCursor, 4);
  assert.equal(first.totalNodes, 6);
  const second = transcriptPageSchema.parse(
    await telemetry.transcript(repository, mesh, { jobId: job.id, cursor: 4, limit: 4 }),
  );
  assert.deepEqual(
    second.nodes.map((node) => node.text),
    ['step 3', 'step 4'],
  );
  assert.equal(second.nextCursor, null);
  await assert.rejects(
    telemetry.transcript(repository, mesh, { jobId: randomUUID() }),
    (thrown: unknown) => thrown instanceof MeshError && thrown.code === 'NOT_FOUND',
  );
  const outside = path.join(mesh.root, 'elsewhere');
  writeArtifact(outside, 'stdout.log', '');
  const foreign = attempt(context, { artifact: outside, role: 'qa-2' });
  await assert.rejects(telemetry.transcript(repository, mesh, { jobId: foreign.id }), /outside this project/v);
});
