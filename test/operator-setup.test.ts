/**
 * Exercise the compiled native UI's connection and quiet-dispatch boundaries.
 * The standard check builds these browser modules before running regression.
 *
 * @file
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { z } from 'zod';

/**
 * Compiled browser module URL, never a project-supplied executable path. The
 * segments are joined so lint gives the same result whether web/dist is built.
 */
const connectionModule = new URL(['..', 'web', 'dist', 'organization-ui.js'].join('/'), import.meta.url);
/** JSON return boundary shared with native browser controls. */
const dataSchema = z.record(z.unknown());
/** Native browser validator with checked arguments and returned JSON. */
const connection = z
  .object({
    githubConnectionInput: z.function().args(z.string(), z.string(), z.string()).returns(dataSchema),
    factoryPolicyInput: z.function().args(z.string(), z.string()).returns(dataSchema),
  })
  .parse(await import(connectionModule.href));
/** Compiled factual dispatch-message renderer, independent of a DOM. */
const dispatchModule = new URL(['..', 'web', 'dist', 'brand-ui.js'].join('/'), import.meta.url);
/** Checked plain text messages from the compiled browser module. */
const messagesSchema = z.array(z.string());
/** Bounded objective rows returned by the public overview selector. */
const objectivesSchema = z.array(dataSchema);
/** Checked callable export; no unsafe browser-module cast. */
const dispatch = z
  .object({
    dispatchSummary: z.function().args(dataSchema).returns(messagesSchema),
    objectivePreview: z.function().args(objectivesSchema, z.number()).returns(objectivesSchema),
  })
  .parse(await import(dispatchModule.href));

await test('connection form derives the actual owner and Project number from user and organization URLs', () => {
  assert.deepEqual(
    connection.githubConnectionInput(
      'Division4Studios/malt',
      'https://github.com/users/Division4Studios/projects/10',
      'Status',
    ),
    {
      repository: 'Division4Studios/malt',
      owner: 'Division4Studios',
      projectNumber: 10,
      statusFieldName: 'Status',
    },
  );
  assert.deepEqual(
    connection.githubConnectionInput(' example/repo ', 'https://github.com/orgs/example/projects/42/', ' Workflow '),
    {
      repository: 'example/repo',
      owner: 'example',
      projectNumber: 42,
      statusFieldName: 'Workflow',
    },
  );
});

await test('native PR-size policy preserves resource settings and rejects invalid limits', () => {
  const policy = { maxDiffLines: 700, resources: { maxActiveJobs: 2 }, providers: { codex: { budgetTokens: null } } };
  assert.deepEqual(connection.factoryPolicyInput(JSON.stringify(policy), '500'), { ...policy, maxDiffLines: 500 });
  for (const invalid of ['', '0', '-1', '1.5', 'Infinity', '9007199254740992']) {
    assert.throws(() => connection.factoryPolicyInput(JSON.stringify(policy), invalid));
  }
});

await test('connection form rejects credential-bearing, foreign-host and ambiguous Project URLs', () => {
  const insecure = new URL('https://github.com/users/example/projects/10');
  insecure.protocol = 'http:';
  for (const url of [
    insecure.href,
    'https://github.com.attacker.invalid/users/example/projects/10',
    'https://secret@github.com/users/example/projects/10',
    'https://github.com:443/users/example/projects/10',
    'https://github.com:0443/users/example/projects/10',
    'https://github.com:8443/users/example/projects/10',
    'https://github.com/users/example/projects/10?token=secret',
    'https://github.com/users/example/projects/10#fragment',
    'https://github.com/example/repo/issues/10',
    'https://github.com/users/example/projects/0',
    'https://github.com/users/example/projects/9007199254740992',
  ]) {
    assert.throws(() => connection.githubConnectionInput('example/repo', url, 'Status'));
  }
  assert.throws(() =>
    connection.githubConnectionInput('owner/target repo', 'https://github.com/users/example/projects/10', 'Status'),
  );
});

await test('quiet coordinator explains a local budget gate independently of subscription quota and expires it truthfully', () => {
  const future = Date.now() + 60_000;
  const capacity = {
    provider: 'codex',
    usedTokens: 101,
    reservedTokens: 0,
    resetAt: future,
    subscriptionUsedPercent: 1,
  };
  const settings = { providers: { codex: { budgetTokens: 100, reservationTokens: 10 } } };
  const messages = dispatch.dispatchSummary({
    active: true,
    settings,
    capacities: [capacity],
    tasks: [{ issue: 13, phase: 'blocked', error: 'spawn EPERM' }],
  });
  assert.ok(messages.some((message) => message.includes('configured scheduling budget exhausted')));
  assert.ok(messages.some((message) => message.includes('separate from subscription quota')));
  assert.ok(messages.some((message) => message.includes('Issue #13 blocked: spawn EPERM')));
  const expired = dispatch.dispatchSummary({ active: true, settings, capacities: [{ ...capacity, resetAt: 1 }] });
  assert.ok(expired.every((message) => !message.includes('budget exhausted')));
});

await test('product overview retains older pending objectives beyond the old four-row tail', () => {
  const pending = Array.from({ length: 9 }, (_, index) => ({ id: `pending-${String(index)}`, phase: 'queued' }));
  const completed = Array.from({ length: 8 }, (_, index) => ({ id: `done-${String(index)}`, phase: 'done' }));
  const visible = dispatch.objectivePreview([...pending, ...completed], 4);
  assert.deepEqual(visible.slice(0, pending.length), pending);
  assert.deepEqual(visible.slice(pending.length), completed.slice(-4));
  assert.equal(
    dispatch.objectivePreview(
      Array.from({ length: 100 }, () => ({ phase: 'queued' })),
      4,
    ).length,
    50,
  );
});
