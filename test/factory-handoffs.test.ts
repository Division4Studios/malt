/**
 * Durable manager reporting handoffs carry structured purpose, recipient and result provenance.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { z } from 'zod';

import { recoverUnownedClaims } from '../src/factory/controls.ts';
import { HANDOFF_SUMMARY_MAX, handoffSchema, settlementEvidence } from '../src/factory/handoffs.ts';
import { FactoryRepository } from '../src/factory/repository.ts';
import { factoryConfigSchema, featureSchema, jobSchema, taskSchema } from '../src/factory/schema.ts';
import { Store } from '../src/store.ts';

import { createCleanup, createProject } from './helpers.ts';

import type { Handoff } from '../src/factory/handoffs.ts';
import type { FactoryJob } from '../src/factory/schema.ts';

/** Public instruction history fields relevant to reporting handoffs. */
const historySchema = z.array(
  z.object({ id: z.string(), role: z.string(), body: z.string(), handoff: handoffSchema.nullable() }),
);
/** Fixture configuration with inert checks. */
const settings = factoryConfigSchema.parse({
  testCommands: [{ file: process.execPath }],
  endToEndCommands: [{ file: process.execPath }],
});

/**
 * Open a configured project ledger.
 *
 * @param t - Test context for cleanup.
 * @returns Repository and a reopen function for persistence checks.
 */
function openLedger(t: Parameters<typeof createCleanup>[0]): {
  repository: FactoryRepository;
  reopen: () => FactoryRepository;
} {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  let store = new Store(mesh);
  defer(() => {
    store.close();
  });
  const repository = new FactoryRepository(store);
  repository.configure(settings);
  return {
    repository,
    reopen: () => {
      store.close();
      store = new Store(mesh);
      return new FactoryRepository(store);
    },
  };
}

/**
 * Build a running assignment with a frozen reporting relationship.
 *
 * @param overrides - Job identity, scope and frozen manager.
 * @returns Claimable job.
 */
function fixtureJob(overrides: Partial<FactoryJob> & { reportsTo?: string | null } = {}): FactoryJob {
  const { reportsTo = 'team-lead', ...rest } = overrides;
  return jobSchema.parse({
    id: randomUUID(),
    role: 'qa-1',
    routing: {
      tier: 'standard',
      model: null,
      reason: 'Fixture profile routing',
      skillNames: [],
      organization: { revision: 'rev-1', type: 'general', label: 'QA', instructions: '', reportsTo },
    },
    provider: 'codex',
    kind: 'review',
    taskId: null,
    featureId: null,
    token: randomUUID(),
    state: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    expiresAt: Date.now(),
    reservation: 7,
    usageTokens: null,
    pid: null,
    head: null,
    base: null,
    summary: null,
    artifact: 'unused',
    ...rest,
  });
}

/**
 * Insert a delivery so reports can cite its issue and title.
 *
 * @param repository - Project ledger.
 * @param title - Name the report should cite.
 * @returns Task identity.
 */
function addDelivery(repository: FactoryRepository, title: string): string {
  const id = randomUUID();
  repository.addTask(
    taskSchema.parse({
      id,
      featureId: null,
      issue: 18,
      parentIssue: 17,
      key: 'handoff-result-context',
      title,
      description: 'Fixture delivery.',
      acceptanceCriteria: ['Observable behavior.'],
      dependencies: [],
      phase: 'review',
      developer: 'developer-1',
      branch: null,
      worktree: null,
      head: null,
      base: null,
      pr: null,
      prUrl: null,
      merge: null,
      reviews: [],
      feedback: [],
      attempts: 1,
      version: 0,
      error: null,
      updatedAt: Date.now(),
    }),
  );
  return id;
}

/**
 * Read every reporting handoff currently addressed to a role.
 *
 * @param repository - Project ledger.
 * @param role - Intended manager.
 * @returns Provenance, newest first.
 */
function reports(repository: FactoryRepository, role = 'team-lead'): Handoff[] {
  return historySchema
    .parse(repository.instructionLedger.recent())
    .filter((entry) => entry.role === role)
    .flatMap((entry) => (entry.handoff === null ? [] : [entry.handoff]));
}

await test('reports cite delivery purpose and keep process state separate from a changes_requested outcome', (t) => {
  const { repository, reopen } = openLedger(t);
  const taskId = addDelivery(repository, 'Include recorded purpose');
  const job = fixtureJob({ taskId });
  assert.equal(repository.claim(job, settings), true);
  const result = { outcome: 'changes_requested', summary: 'Missing regression for replay.', findings: [] };
  assert.equal(repository.finishJob(job, 3, 'succeeded', { result }), true);
  const [report] = reports(repository);
  assert.ok(report !== undefined);
  assert.equal(report.jobId, job.id);
  assert.equal(report.from, 'qa-1');
  assert.equal(report.to, 'team-lead');
  assert.equal(report.processState, 'succeeded');
  assert.equal(report.resultOutcome, 'changes_requested');
  assert.equal(report.verifiedDelivery, false);
  assert.equal(report.context.issue, 18);
  assert.equal(report.context.title?.text, 'Include recorded purpose');
  assert.equal(report.context.objective, null);
  assert.deepEqual(report.summary, { text: 'Missing regression for replay.', truncated: false });
  assert.equal(report.summaryStatus, 'recorded');
  const body = repository.instructions('team-lead', null)[0]?.body ?? '';
  assert.match(body, /reported outcome changes_requested \(agent report, not independent delivery verification\)/v);
  assert.match(body, /Purpose: delivery #18 "Include recorded purpose"/v);
  const reopened = reopen();
  assert.deepEqual(reports(reopened), [report], 'Provenance persists with its instruction after reopen.');
});

await test('planning reports cite the objective; failures and recovery record reasons, never fabricated summaries', (t) => {
  const { repository } = openLedger(t);
  const feature = featureSchema.parse({
    id: randomUUID(),
    objective: 'Explain each handoff purpose and recipient.',
    phase: 'refining',
    productPlan: null,
    plan: null,
    parentIssue: null,
    error: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  repository.saveFeature(feature);
  const failed = fixtureJob({ role: 'product-owner', kind: 'plan', featureId: feature.id });
  assert.equal(repository.claim(failed, settings), true);
  repository.finishJob(failed, null, 'failed', { result: null, reason: 'Project test command 1 failed.' });
  const interrupted = fixtureJob({ featureId: feature.id });
  assert.equal(repository.claim(interrupted, settings), true);
  recoverUnownedClaims(repository, new Map());
  const [recovered, failure] = reports(repository);
  assert.equal(failure?.context.objective?.text, feature.objective);
  assert.equal(failure.context.issue, null);
  assert.equal(failure.summary, null);
  assert.equal(failure.summaryStatus, 'unavailable');
  assert.equal(failure.reason?.text, 'Project test command 1 failed.');
  assert.equal(recovered?.processState, 'interrupted');
  assert.equal(recovered.resultOutcome, null);
  assert.match(recovered.reason?.text ?? '', /supervisor restart/v);
  const bodies = repository.instructions('team-lead', null).map((instruction) => instruction.body);
  assert.ok(bodies.some((body) => body.includes('Failure reason: Project test command 1 failed.')));
  assert.ok(bodies.some((body) => body.includes('Summary unavailable.') && body.includes('Cancellation reason:')));
});

await test('missing, malformed and oversized evidence fall back explicitly without breaking settlement', (t) => {
  const { repository } = openLedger(t);
  const oversized = fixtureJob();
  const missing = fixtureJob({ role: 'qa-2' });
  const malformed = fixtureJob({ role: 'final-tester', kind: 'final' });
  const long = `${'x'.repeat(HANDOFF_SUMMARY_MAX - 2)}😀tail`;
  const settlements = [
    [oversized, 'succeeded', { result: { outcome: 'success', summary: long } }],
    [missing, 'interrupted', {}],
    [malformed, 'succeeded', { result: { outcome: 'shipped', summary: 4 } }],
  ] as const;
  for (const [job, state, evidence] of settlements) {
    assert.equal(repository.claim(job, settings), true);
    assert.equal(repository.finishJob(job, 1, state, evidence), true);
  }
  const byJob = new Map(reports(repository).map((report) => [report.jobId, report]));
  const bounded = byJob.get(oversized.id)?.summary;
  assert.equal(bounded?.truncated, true);
  assert.equal(bounded.text, `${'x'.repeat(HANDOFF_SUMMARY_MAX - 2)}…`, 'Truncation must not split a surrogate pair.');
  assert.equal(byJob.get(missing.id)?.summaryStatus, 'unavailable');
  assert.equal(byJob.get(missing.id)?.reason, null);
  assert.equal(byJob.get(malformed.id)?.summaryStatus, 'malformed');
  assert.equal(byJob.get(malformed.id)?.resultOutcome, null);
  const bodies = repository.instructions('team-lead', null).map((instruction) => instruction.body);
  assert.ok(bodies.some((body) => body.includes('Summary unavailable (malformed result).')));
  assert.ok(bodies.some((body) => body.includes('Cancellation reason unavailable.')));
});

await test('frozen recipients, null managers, stale tokens and replay cannot reroute or duplicate reports', (t) => {
  const { repository } = openLedger(t);
  const frozen = fixtureJob({ reportsTo: 'product-owner' });
  const unmanaged = fixtureJob({ role: 'qa-2', reportsTo: null });
  for (const job of [frozen, unmanaged]) {
    assert.equal(repository.claim(job, settings), true);
  }
  const used = repository.capacity('codex', settings).usedTokens;
  assert.equal(repository.finishJob({ ...frozen, token: randomUUID() }, 5, 'succeeded'), false, 'Stale token.');
  assert.equal(
    repository.finishJob(frozen, 5, 'succeeded', { result: { outcome: 'success', summary: 'Done.' } }),
    true,
  );
  assert.equal(
    repository.finishJob(frozen, 5, 'succeeded', { result: { outcome: 'success', summary: 'Done.' } }),
    false,
  );
  recoverUnownedClaims(repository, new Map([[unmanaged.id, null]]));
  assert.equal(repository.finishJob(unmanaged, 5, 'failed', { reason: 'Gate rejected.' }), true);
  assert.equal(
    repository.capacity('codex', settings).usedTokens,
    used + 10,
    'Accounting is charged exactly once per job.',
  );
  assert.equal(reports(repository, 'product-owner').length, 1);
  assert.equal(reports(repository, 'product-owner')[0]?.to, 'product-owner');
  assert.equal(reports(repository).length, 0, 'Current organization settings must not reroute the frozen manager.');
  const all = historySchema.parse(repository.instructionLedger.recent());
  assert.equal(all.length, 1, 'A null manager creates no report.');
});

await test('legacy and operator instructions expose no fabricated provenance', (t) => {
  const { repository } = openLedger(t);
  repository.instruct('team-lead', null, 'Reporting handoff from developer-1: assignment old succeeded.');
  const [legacy] = historySchema.parse(repository.instructionLedger.recent());
  assert.equal(legacy?.handoff, null);
});

await test('settlement evidence reports supervisor-observed reasons without reading artifacts', () => {
  const now = Date.now();
  const completion = {
    result: null,
    usageTokens: null,
    cooldownUntil: now + 60_000,
    subscriptionUsedPercent: null,
    subscriptionResetAt: null,
    process: { exitCode: 0, stdout: '', stderr: '', interrupted: false },
  };
  const cooled = settlementEvidence(
    { execution: { completion, snapshot: null, checks: [], waiting: null }, state: 'interrupted', reason: null },
    false,
    now,
  );
  assert.equal(cooled.cooldown, now + 60_000);
  assert.match(cooled.reason ?? '', /Provider cooldown until/v);
  const parked = settlementEvidence(
    {
      execution: { completion: null, snapshot: null, checks: [], waiting: 'Awaiting CI.' },
      state: 'failed',
      reason: null,
    },
    false,
    now,
  );
  assert.equal(parked.reason, 'Awaiting CI.');
  assert.match(
    settlementEvidence({ execution: null, state: 'interrupted', reason: null }, true, now).reason ?? '',
    /Supervisor stopped/v,
  );
  assert.equal(settlementEvidence({ execution: null, state: 'interrupted', reason: null }, false, now).reason, null);
  assert.equal(
    settlementEvidence({ execution: null, state: 'interrupted', reason: 'Assignment exceeded timeout.' }, true, now)
      .reason,
    'Assignment exceeded timeout.',
  );
});
