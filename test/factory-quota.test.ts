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
import { accountQuota, claudeQuota } from '../src/factory/quota-windows.ts';
import { codexQuota } from '../src/factory/quota.ts';

import { createCleanup, createProject } from './helpers.ts';

import type { ProcessSpec, ProcessResult } from '../src/factory/processes.ts';

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
  const reading = { usedPercent: 9, resetAt: Date.now() + 60_000 };
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
  const results = await Promise.all([
    codexQuota({ mesh: config, executable, signal, processes }),
    codexQuota({ mesh: config, executable, signal, processes }),
  ]);
  assert.equal(starts, 1);
  assert.deepEqual(results, [reading, reading]);
});
