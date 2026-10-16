/**
 * Sampling cycles must not rebuild the console view; other admission changes must.
 * DOM-free: imports compiled browser modules, so `npm run build:web` runs first.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

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
