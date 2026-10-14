/**
 * Read-only admission evidence: cached sampling, effective ceilings and dispatch blockers.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { z } from 'zod';

import { AdmissionPool } from '../src/factory/admission.ts';
import { FactoryRepository } from '../src/factory/repository.ts';
import { ResourceSampler, admissionBlocker, admissionEvidence } from '../src/factory/resources.ts';
import { factoryConfigSchema, jobSchema } from '../src/factory/schema.ts';
import { FactoryService } from '../src/factory/service.ts';
import { ProjectGitHub } from '../src/github.ts';
import { ProjectLearning } from '../src/learning.ts';
import { Store } from '../src/store.ts';

import { createCleanup, createProject } from './helpers.ts';

import type { Defer } from './helpers.ts';
import type { DeliveryRemote } from '../src/factory/remote.ts';
import type { ResourceSample, ResourceSnapshot } from '../src/factory/resources.ts';
import type { FactoryJob } from '../src/factory/schema.ts';

/** Measured counters as reported by status. */
const sampleSchema = z.object({ cpuPercent: z.number().nullable(), observedAt: z.number() });
/** Configured thresholds as reported by status. */
const limitsSchema = z.object({ maxCpuPercent: z.number() }).nullable();
/** Status fields this delivery adds. */
const evidenceSchema = z.object({
  resources: sampleSchema,
  admission: z.object({ sample: sampleSchema, limits: limitsSchema }),
});
/** Project policy with a single admissible provider. */
const policy = factoryConfigSchema.parse({
  testCommands: [{ file: process.execPath }],
  endToEndCommands: [{ file: process.execPath }],
  providers: { codex: { executable: 'fixture', concurrency: 2 }, claude: { executable: 'fixture', enabled: false } },
  resources: { maxActiveJobs: 4, minFreeMemoryMb: 1000, minFreeMemoryPercent: 10, maxCpuPercent: 80 },
});
/** Ample machine counters. */
const idle: ResourceSample = { freeMemoryMb: 8000, totalMemoryMb: 16_000, cpuPercent: 10, observedAt: 1 };

/**
 * Fail every remote call; dispatch is never reached in these fixtures.
 *
 * @returns Nothing; always rejects.
 */
async function offline(): Promise<never> {
  await delay(0);
  throw new Error('Fixture remote is offline.');
}
/** Offline remote that never touches the network. */
const remote: DeliveryRemote = {
  verify: offline,
  provision: offline,
  pullRequest: offline,
  inspect: offline,
  merge: offline,
  effect: offline,
  readyIssues: offline,
  parentComplete: offline,
};

/**
 * Build a running pipeline fixture.
 *
 * @param fields - Overrides.
 * @returns Valid durable job.
 */
function job(fields: Partial<FactoryJob> = {}): FactoryJob {
  return jobSchema.parse({
    id: randomUUID(),
    role: 'developer-1',
    provider: 'codex',
    kind: 'develop',
    taskId: null,
    featureId: null,
    token: randomUUID(),
    state: 'running',
    startedAt: 1,
    finishedAt: null,
    expiresAt: 10_000,
    reservation: 1,
    usageTokens: null,
    pid: null,
    head: null,
    base: null,
    summary: null,
    artifact: 'fixture',
    ...fields,
  });
}

/**
 * Configured project ledger with a controllable clock.
 *
 * @param defer - Cleanup registration.
 * @returns Repository and clock.
 */
function ledger(defer: Defer): { repository: FactoryRepository; clock: { now: number } } {
  const clock = { now: 1000 };
  const store = new Store(createProject(defer), { now: () => clock.now });
  defer(() => {
    store.close();
  });
  const repository = new FactoryRepository(store);
  repository.configure(policy);
  return { repository, clock };
}

await test('status reads the cached sample; only the scheduling cycle advances the CPU baseline', async (t) => {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  const clock = { now: 1000 };
  const store = new Store(mesh, { now: () => clock.now });
  const readings = [null, 42, 55];
  let calls = 0;
  const probe = (): ResourceSnapshot => {
    const cpuPercent = readings[Math.min(calls, readings.length - 1)] ?? null;
    calls += 1;
    return { ...idle, cpuPercent };
  };
  const factory = new FactoryService(
    mesh,
    store,
    { github: new ProjectGitHub(mesh), learning: new ProjectLearning(mesh) },
    { home: mesh.root, resources: probe, remote },
  );
  defer(async () => {
    await factory.close();
    store.close();
  });
  assert.equal(calls, 1, 'The supervisor takes one baseline sample at construction.');
  await factory.execute('factory_setup', policy);
  const beforeReads = store.db.prepare('SELECT total_changes() AS count').get();
  for (let read = 0; read < 3; read += 1) {
    const first = evidenceSchema.parse(factory.status()).admission;
    assert.equal(first.sample.cpuPercent, null, 'CPU stays unknown before a valid delta, never 0.');
    assert.equal(first.sample.observedAt, 1000);
  }
  assert.equal(calls, 1, 'Status reads must not touch the stateful probe.');
  assert.deepEqual(store.db.prepare('SELECT total_changes() AS count').get(), beforeReads);
  clock.now = 6000;
  factory.repository.setActive(true);
  await factory.tick();
  assert.equal(calls, 2, 'One scheduling cycle advances the sampler once.');
  for (let read = 0; read < 3; read += 1) {
    const cycled = evidenceSchema.parse(factory.status());
    assert.equal(cycled.admission.sample.cpuPercent, 42);
    assert.equal(cycled.admission.sample.observedAt, 6000);
    assert.equal(cycled.resources.cpuPercent, 42, 'The legacy resources field reads the same cached sample.');
    assert.equal(cycled.admission.limits?.maxCpuPercent, 80, 'Configured thresholds are separate from measurements.');
  }
  assert.equal(calls, 2);
  assert.equal(factory.repository.jobs().length, 0, 'Reading evidence claims no job.');
  clock.now = 7000;
  await factory.tick();
  assert.equal(calls, 3);
  assert.equal(evidenceSchema.parse(factory.status()).admission.sample.cpuPercent, 55);
});

await test('invalid CPU readings stay unknown and in-range values pass through', () => {
  let cpuPercent: number | null = NaN;
  const sampler = new ResourceSampler(() => ({ ...idle, cpuPercent }), 1);
  assert.equal(sampler.latest.cpuPercent, null);
  cpuPercent = 0;
  assert.equal(sampler.sample(2).cpuPercent, 0, 'A measured idle CPU is a real zero.');
  cpuPercent = Infinity;
  assert.equal(sampler.sample(3).cpuPercent, null);
  assert.equal(sampler.latest.observedAt, 3);
  cpuPercent = -1;
  assert.equal(sampler.sample(4).cpuPercent, null);
  cpuPercent = 101;
  assert.equal(sampler.sample(5).cpuPercent, null);
});

await test('effective ceilings follow the broker pool and other projects stay an anonymous count', (t) => {
  const { repository } = ledger(createCleanup(t));
  const pool = new AdmissionPool();
  const foreignTask = randomUUID();
  const foreignFeature = randomUUID();
  const foreign = job({
    taskId: foreignTask,
    featureId: foreignFeature,
    state: 'succeeded',
    finishedAt: 2,
    summary: 'Foreign objective secret',
    artifact: '/other/project/secret-artifact',
  });
  pool.add(
    foreign,
    factoryConfigSchema.parse({
      ...policy,
      resources: { ...policy.resources, maxActiveJobs: 1 },
      providers: { ...policy.providers, codex: { ...policy.providers.codex, concurrency: 1 } },
    }),
  );
  const evidence = admissionEvidence(repository, pool, idle, new Map());
  assert.equal(evidence.limits?.maxActiveJobs, pool.policy(policy).resources.maxActiveJobs);
  assert.equal(evidence.limits.maxActiveJobs, 1);
  assert.equal(evidence.limits.providers.codex.concurrency, pool.policy(policy).providers.codex.concurrency);
  assert.equal(evidence.limits.providers.codex.concurrency, 1);
  assert.equal(evidence.brokerReservations, 1, 'A tearing-down pipeline still holds its reservation.');
  assert.deepEqual(evidence.running, [], 'Another project is never listed as an owned job.');
  assert.equal(evidence.blocker, 'job_cap');
  const serialized = JSON.stringify(evidence);
  for (const secret of [foreign.id, foreignTask, foreignFeature, 'secret-artifact', 'Foreign']) {
    assert.ok(!serialized.includes(secret), `Evidence leaked ${secret}.`);
  }
  const own = job({ role: 'qa-1', kind: 'review' });
  repository.claim(own, policy);
  pool.add(own, policy);
  const owned = admissionEvidence(repository, pool, idle, new Map([[own.id, null]]));
  assert.deepEqual(
    owned.running.map((entry) => entry.id),
    [own.id],
  );
  assert.equal(owned.brokerReservations, 2);
});

await test('the blocker follows dispatch order for every admission gate', (t) => {
  const { repository, clock } = ledger(createCleanup(t));
  const pool = new AdmissionPool();
  const blocker = (sample: ResourceSample): string | null =>
    admissionEvidence(repository, pool, sample, new Map()).blocker;
  assert.equal(blocker(idle), 'none');
  assert.equal(blocker({ ...idle, cpuPercent: null }), 'none', 'Unknown CPU never parks work.');
  assert.equal(blocker({ ...idle, cpuPercent: 81 }), 'cpu');
  assert.equal(blocker({ ...idle, cpuPercent: 80 }), 'none', 'The CPU threshold itself still admits.');
  assert.equal(blocker({ ...idle, freeMemoryMb: 999 }), 'memory');
  assert.equal(blocker({ ...idle, freeMemoryMb: 1500 }), 'memory', 'The percentage floor applies independently.');
  repository.saveCapacity({ ...repository.capacity('codex', policy), cooldownUntil: clock.now + 1 });
  assert.equal(blocker(idle), 'provider_cooldown');
  clock.now += 2;
  assert.equal(blocker(idle), 'none', 'An expired cooldown admits again.');
  pool.add(job(), policy);
  pool.add(job({ role: 'developer-2' }), policy);
  assert.equal(blocker(idle), 'provider_cap');
  assert.equal(admissionEvidence(repository, pool, idle, new Map()).providers?.codex, 'concurrency');
  assert.equal(blocker({ ...idle, cpuPercent: 90 }), 'cpu', 'Machine gates precede provider gates, as in dispatch.');
  assert.equal(repository.jobs().length, 0, 'Reading evidence claims no job.');
});

await test('provider categories distinguish caps, cooldowns and unavailable families', () => {
  assert.equal(admissionBlocker(policy, idle, 0, { codex: null, claude: 'disabled' }), 'none');
  assert.equal(admissionBlocker(policy, idle, 0, { codex: 'concurrency', claude: 'cooldown' }), 'provider_cap');
  assert.equal(admissionBlocker(policy, idle, 0, { codex: 'subscription', claude: 'disabled' }), 'provider_cooldown');
  assert.equal(admissionBlocker(policy, idle, 0, { codex: 'budget', claude: 'disabled' }), 'provider_unavailable');
  assert.equal(admissionBlocker(policy, idle, 4, { codex: null, claude: null }), 'job_cap');
});

await test('admission evidence ignores uncapped diagnostic usage and retains explicit token caps', (t) => {
  const { repository } = ledger(createCleanup(t));
  const pool = new AdmissionPool();
  repository.saveCapacity({ ...repository.capacity('codex', policy), usedTokens: 10_000_000 });
  const uncapped = admissionEvidence(repository, pool, idle, new Map());
  assert.equal(uncapped.blocker, 'none');
  assert.equal(uncapped.providers?.codex, null);
  const capped = factoryConfigSchema.parse({
    ...policy,
    providers: { ...policy.providers, codex: { ...policy.providers.codex, budgetTokens: 1000 } },
  });
  repository.configure(capped);
  const limited = admissionEvidence(repository, pool, idle, new Map());
  assert.equal(limited.blocker, 'provider_unavailable');
  assert.equal(limited.providers?.codex, 'budget');
});

await test('admission evidence leaves durable accounting and shared telemetry unchanged', (t) => {
  const { repository } = ledger(createCleanup(t));
  const pool = new AdmissionPool();
  const changes = (): unknown => repository.store.db.prepare('SELECT total_changes() AS count').get();
  const before = changes();
  admissionEvidence(repository, pool, idle, new Map());
  admissionEvidence(repository, pool, idle, new Map());
  assert.deepEqual(changes(), before, 'Read-only evidence must not initialize durable accounting.');
  const capacity = repository.capacity('codex', policy);
  const observed = { ...capacity, cooldownUntil: 5000, telemetrySource: 'fixture', updatedAt: 2000 };
  assert.equal(pool.preview([observed], 1000)[0]?.cooldownUntil, 5000);
  assert.equal(pool.preview([capacity], 1000)[0]?.cooldownUntil, 0, 'Preview does not record telemetry.');
  assert.deepEqual(pool.capacities([observed], 1000), pool.preview([observed], 1000));
});
