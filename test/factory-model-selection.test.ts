/** @file Frozen provider selections emit exact native arguments without paid CLI calls. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { nativeModelArguments } from '../src/factory/provider-selection.ts';
import { agentLaunch } from '../src/factory/providers.ts';
import { factoryConfigSchema, jobSchema } from '../src/factory/schema.ts';

import { createCleanup, createProject } from './helpers.ts';

import type { FactoryJob, Provider } from '../src/factory/schema.ts';

/** Mutable legacy defaults deliberately differ from the frozen assignment. */
const settings = factoryConfigSchema.parse({
  testCommands: [{ file: process.execPath }],
  endToEndCommands: [{ file: process.execPath }],
  providers: {
    codex: { executable: 'fixture', model: 'mutable-default' },
    claude: { executable: 'fixture', model: 'mutable-default' },
  },
});

/**
 * Freeze a model contract as the resolver will supply it; names are fixtures.
 *
 * @param directory - Owned fixture artifact directory.
 * @param provider - Native family.
 * @param effort - Allowed effort or verified lack of effort control.
 * @returns Valid durable job.
 */
function selectedJob(directory: string, provider: Provider, effort: 'low' | 'medium' | 'high' | null): FactoryJob {
  const support = provider === 'codex' ? 'codex-config' : 'claude-effort';
  const entry = {
    id: 'normal',
    provider,
    model: 'fixture-model',
    capability: 'standard',
    effortSupport: effort === null ? 'none' : support,
    efforts: effort === null ? [] : ['low', 'medium', 'high'],
    evidence: { source: 'Fixture model-specific CLI help observation', version: 'fixture-1', observedAt: 1000 },
  };
  return jobSchema.parse({
    id: randomUUID(),
    role: 'developer-1',
    provider,
    kind: 'develop',
    taskId: null,
    featureId: null,
    token: randomUUID(),
    state: 'running',
    startedAt: 1000,
    finishedAt: null,
    expiresAt: 9000,
    reservation: 0,
    usageTokens: null,
    pid: null,
    head: null,
    base: null,
    summary: null,
    artifact: directory,
    routing: {
      tier: 'standard',
      model: entry.model,
      effort,
      reason: 'Frozen fixture selection.',
      skillNames: [],
      selection: { policyRevision: 1, entry, effort },
    },
  });
}

await test('both adapters emit exact frozen model and effort arguments independently of defaults', (t) => {
  const mesh = createProject(createCleanup(t));
  for (const provider of ['codex', 'claude'] as const) {
    for (const effort of ['low', 'medium', 'high'] as const) {
      const job = selectedJob(path.join(mesh.directory, randomUUID()), provider, effort);
      const expected =
        provider === 'codex'
          ? ['--model', 'fixture-model', '-c', `model_reasoning_effort=${JSON.stringify(effort)}`]
          : ['--model', 'fixture-model', '--effort', effort];
      assert.deepEqual(nativeModelArguments(job, settings), expected);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixed fixture artifact under this disposable project.
      mkdirSync(job.artifact);
      const launch = agentLaunch(job, { mesh, home: mesh.root, settings });
      const index = launch.args.indexOf('--model');
      assert.deepEqual(launch.args.slice(index, index + expected.length), expected);
      assert.equal(launch.args.filter((value) => value === '--model').length, 1);
      assert.equal(launch.args.includes('mutable-default'), false);
    }
    const none = selectedJob(mesh.directory, provider, null);
    assert.deepEqual(nativeModelArguments(none, settings), ['--model', 'fixture-model']);
  }
});

await test('unknown, inconsistent and disallowed frozen selections fail before adapter artifacts or inference', (t) => {
  const mesh = createProject(createCleanup(t));
  const job = selectedJob(path.join(mesh.directory, 'never-created'), 'codex', 'low');
  const route = job.routing;
  const selection = route?.selection;
  assert.ok(route !== undefined && selection !== undefined);
  for (const change of [
    { ...selection, effort: 'high', entry: { ...selection.entry, efforts: ['low'] } },
    {
      ...selection,
      effort: null,
      entry: { ...selection.entry, effortSupport: 'unknown', efforts: [], evidence: null },
    },
  ]) {
    const unsupported = jobSchema.parse({ ...job, routing: { ...route, effort: change.effort, selection: change } });
    assert.throws(() => {
      agentLaunch(unsupported, { mesh, home: mesh.root, settings });
    });
  }
  assert.throws(() => {
    nativeModelArguments({ ...job, provider: 'claude' }, settings);
  }, /contradicts/v);
  assert.throws(() => {
    nativeModelArguments({ ...job, routing: { ...route, model: 'changed' } }, settings);
  }, /contradicts/v);
  const policy = {
    revision: 1,
    entries: [selection.entry],
    defaults: [{ provider: 'codex', tier: 'standard', entryId: 'normal', effort: 'low' }],
  };
  const explicit = factoryConfigSchema.parse({ ...settings, modelPolicy: policy });
  const legacy = jobSchema.parse({ ...job, routing: { ...route, selection: undefined } }).routing;
  assert.ok(legacy !== undefined);
  assert.throws(() => {
    nativeModelArguments({ ...job, routing: legacy }, explicit);
  }, /frozen validated/v);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Assert rejection created nothing in this owned disposable fixture path.
  assert.equal(existsSync(job.artifact), false);
});

await test('legacy routed CLI default stays unknown instead of adopting a later mutable model', () => {
  const job = selectedJob('fixture-only', 'codex', 'medium');
  const route = job.routing;
  assert.ok(route !== undefined);
  const legacy = jobSchema.parse({ ...job, routing: { ...route, selection: undefined } }).routing;
  assert.ok(legacy !== undefined);
  assert.deepEqual(nativeModelArguments({ ...job, routing: { ...legacy, model: null } }, settings), [
    '-c',
    'model_reasoning_effort="medium"',
  ]);
  assert.deepEqual(nativeModelArguments(jobSchema.parse({ ...job, routing: undefined }), settings), [
    '--model',
    'mutable-default',
    '-c',
    'model_reasoning_effort="medium"',
  ]);
});
