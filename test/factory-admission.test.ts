/**
 * Broker-wide provider concurrency and critical-pressure admission, without inference.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { AdmissionPool } from '../src/factory/admission.ts';
import { FactoryRepository } from '../src/factory/repository.ts';
import { resourceBlocker, hasCriticalMemoryPressure } from '../src/factory/resources.ts';
import { chooseProvider } from '../src/factory/scheduler.ts';
import {
  capacitySchema,
  factoryConfigSchema,
  isTokenCapExceeded,
  jobSchema,
  providerSchema,
} from '../src/factory/schema.ts';
import { Store } from '../src/store.ts';

import { createCleanup, createProject } from './helpers.ts';

/** Conservative first-project policy. */
const strict = factoryConfigSchema.parse({
  testCommands: [{ file: process.execPath }],
  endToEndCommands: [{ file: process.execPath }],
  providers: { codex: { executable: 'fixture', concurrency: 1 }, claude: { executable: 'fixture', enabled: false } },
  resources: { maxActiveJobs: 1, minFreeMemoryMb: 1000, minFreeMemoryPercent: 10 },
});
/** A second project's larger ceilings must not erase a live project's policy. */
const permissive = factoryConfigSchema.parse({
  ...strict,
  providers: { ...strict.providers, codex: { ...strict.providers.codex, concurrency: 4 } },
  resources: { ...strict.resources, maxActiveJobs: 4 },
});
/** Unknown quota stays unknown; configurable budgets are separate. */
const unknownCapacity = capacitySchema.parse({
  provider: 'codex',
  usedTokens: 0,
  reservedTokens: 0,
  resetAt: 10_000,
  cooldownUntil: 0,
  subscriptionUsedPercent: null,
  subscriptionResetAt: null,
  telemetrySource: null,
  updatedAt: 1,
});

await test('idle provider accounting keeps stable reset boundaries across repeated observations', (t) => {
  const defer = createCleanup(t);
  const config = createProject(defer);
  let now = 100;
  const store = new Store(config, { now: () => now });
  defer(() => {
    store.close();
  });
  const repository = new FactoryRepository(store);
  const settings = factoryConfigSchema.parse({
    ...strict,
    providers: { ...strict.providers, codex: { ...strict.providers.codex, windowMs: 1000 } },
  });
  const initial = repository.capacity('codex', settings);
  now = 200;
  assert.equal(repository.capacity('codex', settings).resetAt, initial.resetAt);
  repository.saveCapacity({ ...initial, usedTokens: 50 });
  now = 1200;
  const reset = repository.capacity('codex', settings);
  assert.equal(reset.usedTokens, 0);
  assert.equal(reset.subscriptionUsedPercent, null);
  now = 1300;
  assert.equal(repository.capacity('codex', settings).resetAt, reset.resetAt);
  now = 2800;
  assert.equal(repository.capacity('codex', settings).resetAt, 3100);
});

await test('a second project cannot evade a live provider or machine concurrency ceiling', () => {
  const pool = new AdmissionPool();
  const job = jobSchema.parse({
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
  });
  pool.add(job, strict);
  const policy = pool.policy(permissive);
  assert.equal(policy.resources.maxActiveJobs, 1);
  assert.equal(policy.providers.codex.concurrency, 1);
  const resources = { freeMemoryMb: 2000, totalMemoryMb: 10_000, cpuPercent: null };
  assert.match(resourceBlocker(policy, resources, pool.size) ?? '', /concurrency/v);
  assert.equal(chooseProvider({ config: policy, capacities: [unknownCapacity], jobs: pool.jobs(), now: 1 }), null);
  assert.throws(() => {
    pool.add(job, permissive);
  }, /already owns/v);
  pool.delete(job.id);
  assert.equal(pool.size, 0);
  assert.equal(
    chooseProvider({ config: pool.policy(permissive), capacities: [unknownCapacity], jobs: pool.jobs(), now: 1 }),
    'codex',
  );
  assert.equal(permissive.resources.maxActiveJobs, 4, 'Admission must not rewrite project policy.');
});

await test('cooldowns and native quota observations apply to other projects and expire truthfully', () => {
  const pool = new AdmissionPool();
  pool.capacities(
    [
      {
        ...unknownCapacity,
        cooldownUntil: 500,
        subscriptionUsedPercent: 100,
        subscriptionResetAt: 1000,
        telemetrySource: 'native CLI fixture',
        updatedAt: 10,
      },
    ],
    20,
  );
  const observed = pool.capacities([{ ...unknownCapacity, updatedAt: 20 }], 30);
  assert.equal(observed[0]?.subscriptionUsedPercent, 100);
  assert.equal(observed[0].cooldownUntil, 500);
  assert.equal(chooseProvider({ config: strict, capacities: observed, jobs: [], now: 30 }), null);
  const reset = pool.capacities([unknownCapacity], 1001);
  assert.equal(
    reset[0]?.subscriptionUsedPercent,
    null,
    'A reset needs fresh telemetry; do not invent available quota.',
  );
  assert.equal(chooseProvider({ config: strict, capacities: reset, jobs: [], now: 1001 }), 'codex');
});

await test('memory admission and critical stop thresholds are distinct from temporary CPU pressure', () => {
  const base = { freeMemoryMb: 800, totalMemoryMb: 10_000, cpuPercent: null };
  assert.match(resourceBlocker(strict, base, 0) ?? '', /memory/v);
  assert.equal(hasCriticalMemoryPressure(strict, base), false);
  assert.equal(hasCriticalMemoryPressure(strict, { ...base, freeMemoryMb: 400 }), true);
  assert.equal(hasCriticalMemoryPressure(strict, { ...base, freeMemoryMb: 2000, cpuPercent: 100 }), false);
});

await test('subscription-only defaults do not block large diagnostic token counts but still enforce actual quota and optional explicit caps', (t) => {
  const defer = createCleanup(t);
  const config = createProject(defer);
  const store = new Store(config, { now: () => 100 });
  defer(() => {
    store.close();
  });
  const repository = new FactoryRepository(store);
  assert.equal(strict.providers.codex.budgetTokens, null);
  repository.configure(strict);
  const measured = {
    ...unknownCapacity,
    usedTokens: 10_000_000,
    subscriptionUsedPercent: 20,
    subscriptionResetAt: 1000,
  };
  repository.saveCapacity(measured);
  assert.equal(chooseProvider({ config: strict, capacities: [measured], jobs: [], now: 100 }), 'codex');
  const job = jobSchema.parse({
    id: randomUUID(),
    role: 'product-owner',
    provider: 'codex',
    kind: 'plan',
    taskId: null,
    featureId: null,
    token: randomUUID(),
    state: 'running',
    startedAt: 100,
    finishedAt: null,
    expiresAt: 1000,
    reservation: 1,
    usageTokens: null,
    pid: null,
    head: null,
    base: null,
    summary: null,
    artifact: 'fixture',
  });
  assert.equal(repository.claim(job, strict), true);
  assert.equal(repository.finishJob(job, 0, 'succeeded'), true);
  const cooling = { ...measured, cooldownUntil: 500 };
  repository.saveCapacity(cooling);
  assert.equal(repository.claim({ ...job, id: randomUUID() }, strict), false);
  assert.equal(chooseProvider({ config: strict, capacities: [cooling], jobs: [], now: 100 }), null);
  repository.saveCapacity({ ...measured, subscriptionUsedPercent: 100 });
  assert.equal(repository.claim({ ...job, id: randomUUID() }, strict), false);
  assert.equal(
    chooseProvider({ config: strict, capacities: [{ ...measured, subscriptionUsedPercent: 100 }], jobs: [], now: 100 }),
    null,
  );
  const explicit = factoryConfigSchema.parse({
    ...strict,
    providers: { ...strict.providers, codex: { ...strict.providers.codex, budgetTokens: 1000, reservationTokens: 1 } },
  });
  const capped = { ...measured, usedTokens: 900, reservedTokens: 100 };
  repository.saveCapacity(capped);
  assert.equal(repository.claim({ ...job, id: randomUUID() }, explicit), false);
  assert.equal(chooseProvider({ config: explicit, capacities: [capped], jobs: [], now: 100 }), null);
  repository.saveCapacity({ ...capped, reservedTokens: 99 });
  assert.equal(repository.claim({ ...job, id: randomUUID() }, explicit), true);
  repository.configure(explicit);
  assert.equal(repository.config()?.providers.codex.budgetTokens, 1000);
});

await test('provider token caps are optional positive integers with an inclusive ceiling', () => {
  assert.equal(providerSchema.parse({ executable: 'fixture' }).budgetTokens, null);
  assert.equal(providerSchema.parse({ executable: 'fixture', budgetTokens: null }).budgetTokens, null);
  assert.equal(providerSchema.parse({ executable: 'fixture', budgetTokens: 1000 }).budgetTokens, 1000);
  for (const budgetTokens of [0, -1, 1.5]) {
    assert.equal(providerSchema.safeParse({ executable: 'fixture', budgetTokens }).success, false);
  }
  for (const usage of [0, 1000, 10_000_000, Number.MAX_VALUE]) {
    assert.equal(isTokenCapExceeded(null, usage), false);
  }
  assert.equal(isTokenCapExceeded(1000, 1001), true);
  assert.equal(isTokenCapExceeded(1000, 1000), false);
});

await test('uncapped provider ordering follows subscription utilization despite diagnostic totals', () => {
  const config = factoryConfigSchema.parse({
    ...strict,
    providers: { codex: { executable: 'fixture' }, claude: { executable: 'fixture' } },
  });
  for (const lower of ['codex', 'claude'] as const) {
    const capacities = (['codex', 'claude'] as const).map((provider) => {
      return {
        ...unknownCapacity,
        provider,
        usedTokens: provider === lower ? 10_000_000 : 0,
        subscriptionUsedPercent: provider === lower ? 20 : 80,
      };
    });
    assert.equal(chooseProvider({ config, capacities, jobs: [], now: 100 }), lower);
  }
});

await test('observing a never-used provider reports a stable window and stores nothing', (t) => {
  const defer = createCleanup(t);
  const config = createProject(defer);
  let now = 2100;
  const store = new Store(config, { now: () => now });
  defer(() => {
    store.close();
  });
  const repository = new FactoryRepository(store);
  const settings = factoryConfigSchema.parse({
    ...strict,
    providers: { ...strict.providers, claude: { ...strict.providers.claude, windowMs: 1000 } },
  });
  const first = repository.capacity('claude', settings, false);
  now = 2900;
  const second = repository.capacity('claude', settings, false);
  assert.deepEqual(second, first, 'Console snapshots must not change while nothing happened.');
  assert.equal(first.resetAt, 3000);
  now = 3100;
  assert.equal(repository.capacity('claude', settings, false).resetAt, 4000);
  assert.equal(repository.capacity('claude', settings).resetAt, 4100, 'A created window still starts at first use.');
});
