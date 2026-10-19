/**
 * Main's baseline: the project's test commands run once per main head in an
 * immutable snapshot, failures are recorded with a redacted tail, and
 * assignments are told which failures already exist on main.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { baselineEvidence, baselineFor, cancelBaseline, refreshBaseline } from '../src/factory/baseline.ts';
import { assignmentPrompt } from '../src/factory/prompts.ts';
import { FactoryRepository } from '../src/factory/repository.ts';
import { factoryConfigSchema } from '../src/factory/schema.ts';
import { ProjectLearning } from '../src/learning.ts';
import { Store } from '../src/store.ts';

import { fixture } from './delivery-fixture.ts';

import type { FactoryContext } from '../src/factory/context.ts';
import type { ProcessResult, ProcessSpec } from '../src/factory/processes.ts';
import type { TestContext } from 'node:test';

/**
 * A remote call the baseline never makes.
 *
 * @returns Never; it always rejects.
 */
async function refuse(): Promise<never> {
  await delay(0);
  throw new Error('The baseline makes no remote call.');
}

/**
 * Factory services over a real repository whose test commands are scripted.
 *
 * @param t - Owns cleanup.
 * @param prepareCommands - Commands that prepare each snapshot.
 * @returns Context, recorded command runs and the fixture.
 */
async function setup(
  t: TestContext,
  prepareCommands: { file: string; args: string[] }[] = [],
): Promise<{ context: FactoryContext; runs: ProcessSpec[]; f: Awaited<ReturnType<typeof fixture>> }> {
  const f = await fixture(t);
  const store = new Store(f.mesh);
  f.defer(() => {
    store.close();
  });
  const settings = factoryConfigSchema.parse({
    prepareCommands,
    testCommands: [
      { file: process.execPath, args: ['unit'] },
      { file: process.execPath, args: ['integration'] },
    ],
    endToEndCommands: [{ file: process.execPath }],
  });
  const repository = new FactoryRepository(store);
  repository.configure(settings);
  const runs: ProcessSpec[] = [];
  const processes = async (spec: ProcessSpec): Promise<ProcessResult> => {
    runs.push(spec);
    await delay(0);
    if (spec.args.includes('hang')) {
      await new Promise((resolve) => {
        spec.signal.addEventListener('abort', resolve, { once: true });
      });
      return { exitCode: null, stdout: '', stderr: '', interrupted: true };
    }
    const isFailing = spec.args.includes('integration') || spec.args.includes('broken');
    return {
      exitCode: isFailing ? 1 : 0,
      stdout: isFailing ? `integration failed near ${f.mesh.token}` : 'ok',
      stderr: '',
      interrupted: false,
    };
  };
  const context: FactoryContext = {
    mesh: f.mesh,
    home: f.mesh.root,
    settings,
    workspaces: f.workspaces,
    repository,
    learning: new ProjectLearning(f.mesh),
    processes,
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
  return { context, runs, f };
}

await test('main is measured once per head, failures are recorded redacted, and the snapshot is removed', async (t) => {
  const { context, runs, f } = await setup(t);
  const head = await f.workspaces.base();
  assert.deepEqual(baselineEvidence(context.repository.store, head), { head, pending: true });
  await refreshBaseline(context);
  const recorded = baselineFor(context.repository.store, head);
  assert.ok(recorded !== null);
  assert.equal(recorded.passed, false);
  assert.deepEqual(
    recorded.failures.map((failure) => [failure.command.endsWith('integration'), failure.exitCode]),
    [[true, 1]],
  );
  assert.equal(recorded.failures[0]?.tail.includes(f.mesh.token), false, 'tails are redacted');
  assert.equal(runs.length, 2);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- The fixture's own temporary snapshot path.
  assert.equal(existsSync(runs[0]?.cwd ?? ''), false, 'the main snapshot is removed after measuring');
  await refreshBaseline(context);
  assert.equal(runs.length, 2, 'the same main head is measured once');

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixture writes only inside its temporary project.
  await writeFile(path.join(f.mesh.root, 'shared.txt'), 'main moved\n');
  await f.workspaces.git(['commit', '-am', 'Main moves on']);
  await f.workspaces.git(['push', 'origin', 'main']);
  await refreshBaseline(context);
  assert.equal(runs.length, 4, 'a new main head is measured again');
});

await test('main is prepared before it is measured, and a failed preparation leaves the baseline pending', async (t) => {
  const prepared = await setup(t, [{ file: process.execPath, args: ['install'] }]);
  const head = await prepared.f.workspaces.base();
  await refreshBaseline(prepared.context);
  assert.deepEqual(
    prepared.runs.map((spec) => spec.args[0]),
    ['install', 'unit', 'integration'],
    'preparation runs first, in the same snapshot',
  );
  assert.equal(baselineFor(prepared.context.repository.store, head)?.passed, false);

  const broken = await setup(t, [{ file: process.execPath, args: ['broken'] }]);
  await refreshBaseline(broken.context);
  assert.deepEqual(baselineEvidence(broken.context.repository.store, head), { head, pending: true });
  assert.equal(broken.runs.length, 1, 'no test runs after a failed preparation');
});

await test('stopping the supervisor cancels and awaits a running baseline', async (t) => {
  const { context, runs, f } = await setup(t, [{ file: process.execPath, args: ['hang'] }]);
  const head = await f.workspaces.base();
  const measuring = refreshBaseline(context);
  while (runs.length === 0) {
    await delay(5);
  }
  await cancelBaseline(context.repository.store);
  assert.deepEqual(baselineEvidence(context.repository.store, head), { head, pending: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- The fixture's own temporary snapshot path.
  assert.equal(existsSync(runs[0]?.cwd ?? ''), false, 'the snapshot is cleaned up before cancellation returns');
  await measuring;
});

await test('delivery assignments are told to treat main failures as known', async (t) => {
  const { f } = await setup(t);
  const delivery = assignmentPrompt({
    job: f.job,
    task: f.task,
    feature: null,
    skill: null,
    standards: [],
    evidence: {},
  });
  assert.match(delivery, /Failures it lists already exist on main/v);
  const taskless = assignmentPrompt({
    job: f.job,
    task: null,
    feature: null,
    skill: null,
    standards: [],
    evidence: {},
  });
  assert.doesNotMatch(taskless, /evidence\.baseline/v);
});
