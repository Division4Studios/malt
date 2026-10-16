/**
 * Sampling cycles must not rebuild the console view; other admission changes must.
 * DOM-free: imports compiled browser modules, so `npm run build:web` runs first.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { admissionLines, admissionSample } from '../web/dist/admission-ui.js';
import { processUsageRows, quotaUsage, stableFactory } from '../web/dist/capacity-details.js';

const limits = { maxActiveJobs: 2 };

/**
 * Build a factory snapshot with a given sample and admission shape.
 *
 * @param overrides - Admission fields to replace.
 * @param cpu - Sampled CPU percentage.
 * @returns Factory snapshot.
 */
function factory(overrides: Record<string, unknown> = {}, cpu = 10): Record<string, unknown> {
  return {
    resources: { freeMemoryMb: 4000, cpuPercent: cpu },
    processUsage: [{ role: 'developer-1', sample: { processes: [{ pid: 7, memoryMb: cpu, cpuPercent: cpu }] } }],
    admission: {
      sample: { freeMemoryMb: 4000, cpuPercent: cpu },
      limits,
      running: [],
      brokerReservations: 0,
      providers: null,
      blocker: null,
      ...overrides,
    },
    tasks: [],
  };
}

const key = (value: Record<string, unknown>): string => JSON.stringify(stableFactory(value));

void test('a sample-only change keeps the render key stable', () => {
  assert.equal(key(factory({}, 10)), key(factory({}, 90)));
});

void test('any non-sample admission change alters the render key', () => {
  const base = key(factory());
  for (const change of [
    { limits: { maxActiveJobs: 3 } },
    { blocker: { gate: 'memory' } },
    { providers: { codex: null } },
    { running: [{ id: 'a' }] },
    { brokerReservations: 1 },
  ]) {
    assert.notEqual(key(factory(change)), base, JSON.stringify(change));
  }
});

void test('process sample figures follow the newest snapshot', () => {
  assert.deepEqual(processUsageRows(factory({}, 90)).rows, [['developer-1', '7', '90.0', '90.0%']]);
});

void test('subscription zero, reached and unknown remain distinct without color', () => {
  assert.equal(quotaUsage(0), '0% used');
  assert.equal(quotaUsage(100), '100% used · limit reached');
  assert.equal(quotaUsage(42), '42% used');
  for (const value of [undefined, null, -1, 101, NaN, Infinity, '0']) {
    assert.equal(quotaUsage(value), 'usage unknown');
  }
});

void test('admission separates simultaneous objectives and anonymous broker reservations', () => {
  const state = factory({
    running: [
      { role: 'developer-1', kind: 'develop', state: 'running', featureId: 'a', taskId: 'one', provider: 'codex' },
      { role: 'product-owner', kind: 'plan', state: 'running', featureId: 'b', provider: 'claude' },
    ],
    brokerReservations: 3,
    blocker: 'provider_cap',
    limits: { maxActiveJobs: 4, providers: { codex: { concurrency: 1 }, claude: { concurrency: 2 } } },
    providers: { codex: 'concurrency', claude: null },
  });
  state['features'] = [
    { id: 'a', objective: '<img src=x>' },
    { id: 'b', objective: 'Other objective' },
  ];
  state['tasks'] = [{ id: 'one', title: 'First scope' }];
  const lines = admissionLines(state).join('\n');
  assert.match(lines, /developer-1 · develop · running · objective: <img src=x> · ticket: First scope/v);
  assert.match(lines, /product-owner · plan · running · objective: Other objective/v);
  assert.match(lines, /Other broker pipelines\/reservations: 1 \(identities private\)/v);
  assert.match(lines, /providers\.codex\.concurrency 1/v);
  assert.match(lines, /process activity, not delivery success/v);
});

void test('admission explains each gate and preserves unknown or stale measurements', () => {
  for (const [blocker, expected = ''] of [
    ['job_cap', 'resources.maxActiveJobs'],
    ['provider_cap', 'providers.<name>.concurrency'],
    ['cpu', 'resources.maxCpuPercent'],
    ['memory', 'resources.minFreeMemoryMb'],
    ['provider_cooldown', 'cooldown'],
    ['provider_unavailable', 'No provider'],
    ['none', 'eligible work'],
  ]) {
    assert.ok(admissionLines(factory({ blocker })).some((line) => line.includes(expected)));
  }
  assert.match(admissionLines({}).join('\n'), /Admission evidence unavailable/v);
  assert.match(admissionSample({}, 1000), /unknown MiB free memory · CPU sampling \/ unknown.*sample age unknown/v);
  assert.match(
    admissionSample({ admission: { sample: { observedAt: 1, cpuPercent: null } } }, 32_000),
    /31s old · stale/v,
  );
  assert.match(
    admissionSample({ admission: { sample: { observedAt: 1000, cpuPercent: 0 } } }, 1000),
    /CPU 0%.*0s old · current/v,
  );
  assert.match(admissionSample({ admission: { sample: { observedAt: 2000 } } }, 1000), /sample age unknown/v);
});
