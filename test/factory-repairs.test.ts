/**
 * CI-failure and merge-conflict repair rounds: log extraction and redaction,
 * idempotent bounded rounds, real Git conflicts and repair-aware scheduling.
 * No paid inference and no network.
 *
 * @file
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { actionsJobId, checkState, ciFinding, excerptLog, failedChecks, redactLog } from '../src/factory/ci-logs.ts';
import { MergeConflictError } from '../src/factory/merge-conflict.ts';
import { REPAIR_FINDING_MAX, attemptBudget } from '../src/factory/repair-schema.ts';
import { jobIntents } from '../src/factory/scheduler.ts';
import { factoryConfigSchema, featureSchema, taskSchema } from '../src/factory/schema.ts';

import type { RawCheck } from '../src/factory/ci-logs.ts';
import type { FactoryConfig, FactoryTask } from '../src/factory/schema.ts';

/** A GitHub token shape the redactor must remove. */
const LEAKED = `ghp_${'a1B2c3D4'.repeat(5)}`;
/** A failed Actions job as GitHub reports it in the rollup. */
const FAILED_CHECK: RawCheck = {
  name: 'check (ubuntu-latest)',
  status: 'COMPLETED',
  conclusion: 'FAILURE',
  detailsUrl: 'https://github.com/fixture/app/actions/runs/7/job/42',
};
/** A passing check alongside it. */
const PASSING_CHECK: RawCheck = { name: 'docker', status: 'COMPLETED', conclusion: 'SUCCESS' };

await test('check states: pending waits, cancelled and skipped never count, failures are unique by name', () => {
  assert.equal(checkState({ name: 'a', status: 'IN_PROGRESS', conclusion: null }).state, 'pending');
  assert.equal(checkState({ context: 'ci/legacy', state: 'PENDING' }).state, 'pending');
  assert.equal(checkState({ name: 'a', status: 'COMPLETED', conclusion: 'CANCELLED' }).state, 'ignored');
  assert.equal(checkState({ context: 'ci/legacy', state: 'ERROR' }).state, 'failed');
  assert.equal(checkState({ name: 'a', status: 'COMPLETED', conclusion: 'TIMED_OUT' }).state, 'failed');
  assert.equal(failedChecks([FAILED_CHECK, { name: 'b', status: 'QUEUED' }]), null);
  assert.deepEqual(failedChecks([{ name: 'a', status: 'COMPLETED', conclusion: 'CANCELLED' }, PASSING_CHECK]), []);
  assert.deepEqual(
    failedChecks([FAILED_CHECK, FAILED_CHECK, { context: 'a-legacy', state: 'FAILURE' }])?.map((check) => check.name),
    ['a-legacy', 'check (ubuntu-latest)'],
  );
  assert.equal(actionsJobId(FAILED_CHECK.detailsUrl ?? null), '42');
  assert.equal(actionsJobId('https://ci.example.invalid/build/1'), null);
  assert.equal(actionsJobId(null), null);
});

await test('logs lose control codes, timestamps, known secrets, token shapes and URL credentials', () => {
  const raw = [
    '2026-10-17T01:02:03.4567890Z \u{1B}[32mRunning npm test\u{1B}[0m\r',
    `2026-10-17T01:02:04.0000000Z token=${LEAKED}`,
    'fetch https://bot:hunter2@github.com/fixture/app.git',
    'Authorization: Bearer abc.def.ghi',
    'mesh-secret-value appears here',
    'Unexpected token in JSON at position 4',
  ].join('\n');
  const clean = redactLog(raw, ['mesh-secret-value']);
  assert.ok(!clean.includes('\u{1B}') && !clean.includes('\r'));
  assert.doesNotMatch(clean, /2026-10-17T/v);
  assert.ok(!clean.includes(LEAKED));
  assert.doesNotMatch(clean, /hunter2|abc\.def\.ghi|mesh-secret-value/v);
  assert.match(clean, /https:\/\/\[REDACTED\]@github\.com/v);
  assert.match(clean, /^Authorization: \[REDACTED\]/mv);
  assert.match(clean, /^Running npm test$/mv);
  assert.match(clean, /Unexpected token in JSON/v, 'ordinary prose keeps its words');
});

await test('excerpts keep the first error with context and the final lines, within the bound', () => {
  const lines = Array.from({ length: 400 }, (_value, index) => `line ${String(index)}`);
  lines[200] = 'src/app.ts(3,1): error TS2304: Cannot find name';
  const excerpt = excerptLog(lines.join('\n'));
  assert.match(excerpt, /line 186\n/v);
  assert.match(excerpt, /error TS2304/v);
  assert.match(excerpt, /line 399$/v);
  assert.doesNotMatch(excerpt, /line 10\n/v);
  assert.match(excerpt, /lines omitted/v);
  const huge = excerptLog(`${'x'.repeat(390)} error\n`.repeat(2000), 500);
  assert.ok(huge.length <= 500);
  const check = checkState(FAILED_CHECK);
  const finding = ciFinding(check, 'error everywhere\n'.repeat(5000), 'a'.repeat(40));
  assert.ok(finding.length <= REPAIR_FINDING_MAX);
  assert.match(finding, /^\[P1\] CI check "check \(ubuntu-latest\)" failed on a{40}/v);
  assert.match(ciFinding(check, null, 'b'), /No log was available/v);
});

await test('each repair round grants the developer one more attempt', () => {
  const config: FactoryConfig = factoryConfigSchema.parse({
    testCommands: [{ file: process.execPath }],
    endToEndCommands: [{ file: process.execPath }],
  });
  const objective = featureSchema.parse({
    id: randomUUID(),
    objective: 'Fixture',
    phase: 'active',
    productPlan: null,
    plan: null,
    parentIssue: null,
    error: null,
    createdAt: 1,
    updatedAt: 1,
  });
  const exhausted = taskSchema.parse({
    id: randomUUID(),
    featureId: objective.id,
    issue: 1,
    parentIssue: 2,
    key: 'fixture',
    title: 'Fixture',
    description: 'Fixture',
    acceptanceCriteria: [],
    dependencies: [],
    phase: 'development',
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
    attempts: config.maxAttempts,
    version: 0,
    error: null,
    updatedAt: 1,
  });
  const repaired: FactoryTask = {
    ...exhausted,
    repairs: [
      { kind: 'ci', key: 'ci:x:y', head: 'x', base: 'y', at: 2, checks: ['y'], files: [], findings: [], summary: 'y' },
    ],
  };
  assert.equal(attemptBudget(repaired, config), config.maxAttempts + 1);
  const intents = (tasks: FactoryTask[]): string[] => {
    return jobIntents({ config, features: [objective], tasks, jobs: [], skillRequests: [], now: 10 })
      .filter((intent) => intent.kind === 'develop')
      .map((intent) => intent.role);
  };
  assert.deepEqual(intents([exhausted]), []);
  assert.deepEqual(intents([repaired]), ['developer-1']);
});

await test('conflict errors keep a bounded path list for the round', () => {
  const error = new MergeConflictError({
    files: Array.from({ length: 80 }, (_value, index) => `file-${String(index)}.ts`),
    head: 'h',
    base: 'b',
  });
  assert.equal(error.files.length, 50);
  assert.equal(error.code, 'FACTORY_GATED');
  assert.match(error.message, /file-0\.ts, file-1\.ts/v);
});
