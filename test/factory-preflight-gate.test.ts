/**
 * Zero-model preflight before a paid turn: an unsealed or unreadable source
 * view, a checkout where Git fails and a check command that cannot start each
 * stop the attempt with one named reason; a healthy environment passes.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { assignmentPreflight, canStart } from '../src/factory/assignment-preflight.ts';
import { runProcess } from '../src/factory/processes.ts';
import { FactoryRepository } from '../src/factory/repository.ts';
import { factoryConfigSchema } from '../src/factory/schema.ts';
import { sealSource } from '../src/factory/source-reader.ts';
import { ProjectLearning } from '../src/learning.ts';
import { Store } from '../src/store.ts';

import { fixture } from './delivery-fixture.ts';

import type { FactoryContext } from '../src/factory/context.ts';
import type { FactoryConfig } from '../src/factory/schema.ts';
import type { TestContext } from 'node:test';

/**
 * A remote call preflight never makes.
 *
 * @returns Never; it always rejects.
 */
async function refuse(): Promise<never> {
  await delay(0);
  throw new Error('Preflight makes no remote call.');
}

/**
 * Factory services over the delivery fixture's real repository.
 *
 * @param t - Owns cleanup.
 * @param settings - Project policy overrides.
 * @returns Context, the attempt, its checkout and its prepared head.
 */
async function setup(
  t: TestContext,
  settings: Partial<FactoryConfig> = {},
): Promise<{
  context: FactoryContext;
  job: Awaited<ReturnType<typeof fixture>>['job'];
  directory: string;
  head: string;
}> {
  const f = await fixture(t);
  const store = new Store(f.mesh);
  f.defer(() => {
    store.close();
  });
  const policy = {
    ...factoryConfigSchema.parse({
      testCommands: [{ file: process.execPath }],
      endToEndCommands: [{ file: process.execPath }],
    }),
    ...settings,
  };
  const repository = new FactoryRepository(store);
  repository.configure(policy);
  // The sealed view references the attempt, which references its delivery.
  repository.addTask(f.task);
  assert.equal(repository.claim(f.job, policy), true);
  const context: FactoryContext = {
    mesh: f.mesh,
    home: f.mesh.root,
    settings: policy,
    workspaces: f.workspaces,
    repository,
    learning: new ProjectLearning(f.mesh),
    processes: runProcess,
    agent: refuse,
    remote: {
      verify: refuse,
      provision: refuse,
      readyIssues: refuse,
      inspect: refuse,
      merge: refuse,
      effect: refuse,
      issueState: refuse,
      parentComplete: refuse,
      pullRequest: refuse,
    },
  };
  const head = await f.workspaces.git(['rev-parse', 'HEAD'], f.directory);
  return { context, job: f.job, directory: f.directory, head };
}

await test('a healthy environment passes and an unsealed or unreadable source view stops the turn', async (t) => {
  const { context, job, directory, head } = await setup(t);
  assert.match((await assignmentPreflight(context, job, directory)) ?? '', /source view was not sealed/v);
  sealSource(context.repository, job, { directory, head, status: '' });
  assert.equal(await assignmentPreflight(context, job, directory), null);
  sealSource(context.repository, job, { directory, head: 'f'.repeat(40), status: '' });
  assert.match(
    (await assignmentPreflight(context, job, directory)) ?? '',
    /^Preflight stopped this develop attempt before any paid turn: the sealed source view at f+ cannot be read/v,
  );
});

await test('a checkout where Git fails or a check command that cannot start stops the turn', async (t) => {
  const missing = await setup(t, { endToEndCommands: [{ file: 'malt-no-such-check', args: [] }] });
  sealSource(missing.context.repository, missing.job, { directory: missing.directory, head: missing.head, status: '' });
  assert.match(
    (await assignmentPreflight(missing.context, missing.job, missing.directory)) ?? '',
    /check command malt-no-such-check cannot be started/v,
  );
  const outside = mkdtempSync(path.join(tmpdir(), 'malt-preflight-'));
  t.after(() => {
    rmSync(outside, { recursive: true, force: true });
  });
  const broken = await setup(t);
  sealSource(broken.context.repository, broken.job, { directory: broken.directory, head: broken.head, status: '' });
  assert.match((await assignmentPreflight(broken.context, broken.job, outside)) ?? '', /Git does not work/v);
});

await test('executables are found by path or on PATH without running them', () => {
  assert.equal(canStart(process.execPath, tmpdir()), true);
  assert.equal(canStart('node', tmpdir()), true);
  assert.equal(canStart('malt-no-such-check', tmpdir()), false);
  assert.equal(canStart('./missing/tool', tmpdir()), false);
});
