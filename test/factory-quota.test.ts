/**
 * Supported native quota observations and bounded metadata-only probes.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { test } from 'node:test';

import { decodeCompletion } from '../src/factory/providers.ts';
import { accountQuota, accountObservation, claudeQuota, windowFreshness } from '../src/factory/quota-windows.ts';
import { codexQuota, QuotaObserver } from '../src/factory/quota.ts';
import { FactoryRepository } from '../src/factory/repository.ts';
import { capacitySchema, factoryConfigSchema, jobSchema } from '../src/factory/schema.ts';
import { Store } from '../src/store.ts';

import { createCleanup, createProject } from './helpers.ts';

import type { ProcessSpec, ProcessResult } from '../src/factory/processes.ts';

await test('Codex observations retain independent windows and age without inventing allowance', () => {
  const observation = accountObservation(
    {
      rateLimits: {
        primary: { usedPercent: 0, resetsAt: 50 },
        secondary: { usedPercent: 125, resetsAt: null },
        credits: { balance: 999 },
      },
    },
    1000,
  );
  assert.deepEqual(observation, {
    usedPercent: 100,
    resetAt: null,
    windows: [
      { id: 'primary', usedPercent: 0, resetAt: 50_000, observedAt: 1000, source: 'codex-app-server' },
      { id: 'secondary', usedPercent: 100, resetAt: null, observedAt: 1000, source: 'codex-app-server' },
    ],
  });
  const [primary, secondary] = observation.windows;
  assert.ok(primary !== undefined);
  assert.ok(secondary !== undefined);
  assert.equal(windowFreshness(primary, 49_999), 'current');
  assert.equal(windowFreshness(primary, 50_000), 'stale');
  assert.equal(windowFreshness(secondary, 301_000), 'stale');
  assert.equal(
    accountObservation({ rateLimits: { primary: { usedPercent: -1, resetsAt: null }, secondary: null } }),
    null,
  );
});

await test('window persistence preserves legacy accounting and never uses updatedAt as observation time', (t) => {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  let now = 1000;
  const settings = factoryConfigSchema.parse({
    testCommands: [{ file: 'node' }],
    endToEndCommands: [{ file: 'node' }],
  });
  let store = new Store(mesh, { now: () => now });
  defer(() => {
    store.close();
  });
  let repository = new FactoryRepository(store);
  const legacy = { ...repository.capacity('codex', settings), usedTokens: 42, reservedTokens: 12, cooldownUntil: 9000 };
  delete legacy.subscriptionWindows;
  repository.saveCapacity(legacy);
  assert.deepEqual(repository.capacity('codex', settings).subscriptionWindows, []);
  const observation = accountObservation(
    { rateLimits: { primary: { usedPercent: 0, resetsAt: null }, secondary: null } },
    now,
  );
  assert.ok(observation !== null);
  repository.saveCapacity({ ...legacy, subscriptionWindows: observation.windows });
  store.close();
  store = new Store(mesh, { now: () => now });
  repository = new FactoryRepository(store);
  now = 301_000;
  repository.saveCapacity({ ...repository.capacity('codex', settings), updatedAt: now });
  const restored = repository.capacity('codex', settings);
  assert.equal(restored.usedTokens, 42);
  assert.equal(restored.reservedTokens, 12);
  assert.equal(restored.cooldownUntil, 9000);
  assert.equal(restored.subscriptionWindows?.[0]?.observedAt, 1000);
  assert.equal(restored.subscriptionWindows[0].freshness, 'stale');
  repository.configure(settings);
  const job = jobSchema.parse({
    id: randomUUID(),
    token: randomUUID(),
    role: 'product-owner',
    provider: 'codex',
    kind: 'plan',
    taskId: null,
    featureId: null,
    state: 'running',
    startedAt: now,
    finishedAt: null,
    expiresAt: now + 60_000,
    reservation: 10,
    usageTokens: null,
    pid: null,
    head: null,
    base: null,
    summary: null,
    artifact: mesh.directory,
  });
  assert.equal(repository.claim(job, settings), true);
  assert.equal(repository.capacity('codex', settings).subscriptionWindows?.[0]?.observedAt, 1000);
  now += 1000;
  assert.equal(repository.finishJob(job, 5, 'succeeded'), true);
  assert.equal(repository.capacity('codex', settings).subscriptionWindows?.[0]?.observedAt, 1000);
  const sanitized = capacitySchema.parse({
    ...legacy,
    subscriptionWindows: [{ ...observation.windows[0], credits: 999, token: 'secret' }],
  });
  assert.deepEqual(sanitized.subscriptionWindows, observation.windows);
  for (const windows of [
    Array.from({ length: 17 }, () => observation.windows[0]),
    [{ ...observation.windows[0], id: '<script>' }],
    [{ ...observation.windows[0], observedAt: null }],
  ]) {
    assert.deepEqual(capacitySchema.parse({ ...legacy, subscriptionWindows: windows }).subscriptionWindows, []);
  }
});

await test('failed and cancelled observations cannot refresh prior windows or clear a cooldown', async (t) => {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  const store = new Store(mesh);
  defer(() => {
    store.close();
  });
  const repository = new FactoryRepository(store);
  const settings = factoryConfigSchema.parse({
    testCommands: [{ file: 'node' }],
    endToEndCommands: [{ file: 'node' }],
  });
  const observation = accountObservation({
    rateLimits: { primary: { usedPercent: 100, resetsAt: null }, secondary: null },
  });
  assert.ok(observation !== null);
  const prior = {
    ...repository.capacity('codex', settings),
    cooldownUntil: Date.now() + 60_000,
    subscriptionWindows: observation.windows,
  };
  repository.saveCapacity(prior);
  settings.providers.codex.executable = `failure-${randomUUID()}`;
  const failureObserver = new QuotaObserver();
  await failureObserver.observe({
    mesh,
    repository,
    settings,
    processes: async () => {
      await Promise.resolve();
      return { stdout: '', stderr: '', exitCode: 1, interrupted: false };
    },
  });
  assert.deepEqual(repository.capacity('codex', settings).subscriptionWindows, []);
  assert.equal(repository.capacity('codex', settings).subscriptionUsedPercent, null);
  assert.equal(repository.capacity('codex', settings).cooldownUntil, prior.cooldownUntil);
  repository.saveCapacity(prior);
  settings.providers.codex.executable = `cancel-${randomUUID()}`;
  const observer = new QuotaObserver();
  await observer.observe({
    mesh,
    repository,
    settings,
    processes: async () => {
      await Promise.resolve();
      observer.cancel();
      return { stdout: '', stderr: '', exitCode: 1, interrupted: true };
    },
  });
  assert.equal(
    repository.capacity('codex', settings).subscriptionWindows?.[0]?.observedAt,
    prior.subscriptionWindows[0]?.observedAt,
  );
});

await test('expired windows remain stale and scalar ties retain the later restrictive deadline', () => {
  const response = {
    rateLimits: { primary: { usedPercent: 100, resetsAt: 50 }, secondary: { usedPercent: 100, resetsAt: 80 } },
  };
  assert.deepEqual(accountQuota(response, 1000), { usedPercent: 100, resetAt: 80_000 });
  const expired = accountObservation(response, 90_000);
  assert.ok(expired !== null);
  assert.equal(expired.usedPercent, null);
  assert.equal(expired.windows.length, 2);
  assert.ok(expired.windows.every((window) => windowFreshness(window, 90_000) === 'stale'));
  assert.equal(accountObservation({ credits: { balance: 100 } }), null);
});

await test('malformed and credit-only helper output is unavailable', async (t) => {
  const mesh = createProject(createCleanup(t));
  const { signal } = new AbortController();
  for (const stdout of ['not-json', '{"credits":999}', '{"usedPercent":0,"resetAt":null,"windows":[]}']) {
    const result = await codexQuota({
      mesh,
      executable: `malformed-${randomUUID()}`,
      signal,
      processes: async () => {
        await Promise.resolve();
        return { stdout, stderr: '', exitCode: 0, interrupted: false };
      },
    });
    assert.equal(result, null);
  }
});

await test('native account windows distinguish zero usage, unknown data and expired observations', () => {
  assert.equal(accountQuota({}), null);
  assert.equal(accountQuota({ rateLimits: null }), null);
  assert.deepEqual(accountQuota({ rateLimits: { primary: { usedPercent: 0, resetsAt: 50 }, secondary: null } }, 1000), {
    usedPercent: 0,
    resetAt: 50_000,
  });
  assert.deepEqual(
    accountQuota(
      { rateLimits: { primary: { usedPercent: 80, resetsAt: 50 }, secondary: { usedPercent: 100, resetsAt: 80 } } },
      1000,
    ),
    { usedPercent: 100, resetAt: 80_000 },
  );
  assert.equal(
    accountQuota({ rateLimits: { primary: { usedPercent: 100, resetsAt: 1 }, secondary: null } }, 2000),
    null,
  );
});

await test('actual unified Claude quota windows reach provider telemetry and retain the restrictive reset', (t) => {
  const config = createProject(createCleanup(t));
  const info = {
    status: 'allowed',
    resetsAt: 50,
    unifiedWindows: {
      five_hour: { utilization: 0.2, resetsAt: 50 },
      seven_day: { utilization: 0.75, resetsAt: 80 },
    },
  };
  assert.deepEqual(claudeQuota(info, 1000), { usedPercent: 75, resetAt: 80_000 });
  assert.equal(claudeQuota({ status: 'allowed' }, 1000), null);
  const completion = decodeCompletion(
    {
      stdout: JSON.stringify({ type: 'rate_limit_event', rate_limit_info: info }),
      stderr: '',
      exitCode: 0,
      interrupted: false,
    },
    path.join(config.directory, 'absent-result.json'),
    1000,
  );
  assert.equal(completion.subscriptionUsedPercent, 75);
  assert.equal(completion.subscriptionResetAt, 80_000);
  assert.equal(completion.usageTokens, null, 'Quota percentages do not fabricate token usage.');
});

await test('projects share a bounded native quota probe without starting a model assignment', async (t) => {
  const config = createProject(createCleanup(t));
  const executable = `fixture-codex-${randomUUID()}`;
  const { signal } = new AbortController();
  const reading = accountObservation({ rateLimits: { primary: { usedPercent: 9, resetsAt: null }, secondary: null } });
  assert.ok(reading !== null);
  let starts = 0;
  const processes = async (spec: ProcessSpec): Promise<ProcessResult> => {
    starts += 1;
    assert.equal(spec.file, process.execPath);
    assert.match(spec.args[0] ?? '', /codex-quota-probe\.ts$/v);
    assert.equal(spec.args[1], executable);
    assert.equal(spec.input, '');
    assert.equal(spec.processLimit, 8);
    assert.ok(spec.timeoutMs <= 15_000);
    await Promise.resolve();
    return { stdout: JSON.stringify(reading), stderr: '', exitCode: 0, interrupted: false };
  };
  const otherProject = createProject(createCleanup(t));
  const results = await Promise.all([
    codexQuota({ mesh: otherProject, executable, signal, processes }),
    codexQuota({ mesh: config, executable, signal, processes }),
  ]);
  assert.equal(starts, 1);
  assert.deepEqual(results, [reading, reading]);
});
