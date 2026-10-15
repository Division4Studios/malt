/**
 * Durable manager reporting handoffs carry structured purpose, recipient and result provenance.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { z } from 'zod/v3';

import { recoverUnownedClaims } from '../src/factory/controls.ts';
import { HANDOFF_SUMMARY_MAX, handoffSchema } from '../src/factory/handoffs.ts';
import { FactoryRepository } from '../src/factory/repository.ts';
import { factoryConfigSchema, featureSchema, jobSchema, taskSchema } from '../src/factory/schema.ts';
import { FactoryService } from '../src/factory/service.ts';
import { ProjectGitHub } from '../src/github.ts';
import { ProjectLearning } from '../src/learning.ts';
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
  assert.equal(repository.claim(frozen, settings), true);
  assert.equal(repository.claim(unmanaged, settings), true);
  const changed = factoryConfigSchema.parse(settings);
  changed.organization.members['qa-1'] = { type: 'general', reportsTo: null };
  repository.configure(changed);
  const used = repository.capacity('codex', settings).usedTokens;
  assert.equal(repository.finishJob({ ...frozen, token: randomUUID() }, 5, 'succeeded'), false, 'Stale token.');
  const evidence = { result: { outcome: 'success', summary: 'Done.' } };
  assert.equal(repository.finishJob(frozen, 5, 'succeeded', evidence), true);
  assert.equal(repository.finishJob(frozen, 5, 'succeeded', evidence), false);
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
  assert.equal(historySchema.parse(repository.instructionLedger.recent()).length, 1, 'No null-manager report.');
});

await test('legacy and operator instructions expose no fabricated provenance', (t) => {
  const { repository } = openLedger(t);
  repository.instruct('team-lead', null, 'Reporting handoff from developer-1: assignment old succeeded.');
  const [legacy] = historySchema.parse(repository.instructionLedger.recent());
  assert.equal(legacy?.handoff, null);
});

for (const mode of ['timeout', 'operator'] as const) {
  await test(`service preserves ${mode} reason when the agent resolves after abort`, { timeout: 20_000 }, async (t) => {
    const defer = createCleanup(t);
    const mesh = createProject(defer);
    const store = new Store(mesh);
    defer(() => {
      store.close();
    });
    const started = Promise.withResolvers<string>();
    const settled = Promise.withResolvers<undefined>();
    const factory = new FactoryService(
      mesh,
      store,
      { github: new ProjectGitHub(mesh), learning: new ProjectLearning(mesh) },
      {
        home: mesh.root,
        resources: () => ({ freeMemoryMb: 10_000, totalMemoryMb: 20_000, cpuPercent: 1 }),
        agent: async (request) => {
          started.resolve(request.job.id);
          await new Promise<void>((resolve) => {
            request.signal.addEventListener(
              'abort',
              () => {
                resolve();
              },
              { once: true },
            );
          });
          return {
            result: null,
            usageTokens: 1,
            cooldownUntil: 0,
            subscriptionUsedPercent: null,
            subscriptionResetAt: null,
            process: { exitCode: null, stdout: '', stderr: '', interrupted: true },
          };
        },
      },
    );
    defer(async () => factory.close());
    const configured = factoryConfigSchema.parse({ ...settings, jobTimeoutMs: 5000 });
    configured.organization.members['product-owner'] = { type: 'general', reportsTo: 'team-lead' };
    configured.organization.members['team-lead'] = { type: 'general', reportsTo: null };
    factory.repository.configure(configured);
    const context = factory.configured();
    t.mock.method(context.remote, 'verify', async () => {
      await delay(0);
    });
    t.mock.method(context.remote, 'readyIssues', async () => await delay(0, []));
    const finish = factory.repository.finishJob.bind(factory.repository);
    t.mock.method(factory.repository, 'finishJob', (...args: Parameters<typeof finish>) => {
      const isFinished = finish(...args);
      settled.resolve(undefined);
      return isFinished;
    });
    await context.workspaces.git(['init', '--initial-branch=main']);
    await context.workspaces.git(['config', 'user.name', 'Handoff fixture']);
    await context.workspaces.git(['config', 'user.email', 'fixture@example.invalid']);
    await context.workspaces.git(['add', '.']);
    await context.workspaces.git(['commit', '-m', 'Fixture baseline']);
    const origin = path.join(mesh.directory, 'origin.git');
    await context.workspaces.git(['init', '--bare', origin]);
    await context.workspaces.git(['remote', 'add', 'origin', origin]);
    await context.workspaces.git(['push', '-u', 'origin', 'main']);
    await factory.execute('factory_request', { objective: 'Explain cancellation.' });
    factory.repository.setActive(true);
    await factory.tick();
    const jobId = await started.promise;
    if (mode === 'operator') {
      await factory.execute('factory_cancel_job', { jobId });
    }
    await settled.promise;
    await factory.close();
    const [report] = reports(factory.repository);
    assert.equal(report?.jobId, jobId);
    assert.equal(report.processState, 'interrupted');
    assert.equal(report.resultOutcome, null);
    assert.equal(
      report.reason?.text,
      mode === 'timeout'
        ? 'Assignment exceeded its 5000 ms timeout.'
        : 'Operator cancelled this attempt; explicit retry required.',
    );
  });
}
