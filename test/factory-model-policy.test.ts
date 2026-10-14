/**
 * Revisioned project model/effort policy: validation, stale writes, legacy loading,
 * restart, project isolation and parked admission, without inference.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { z } from 'zod';

import { startBroker } from '../src/broker.ts';
import { rpc } from '../src/client.ts';
import { loadConfig } from '../src/config.ts';
import { run } from '../src/database.ts';
import { command } from '../src/factory/commands.ts';
import { modelPolicyViewSchema } from '../src/factory/model-policy.ts';
import { factoryConfigSchema, jobSchema } from '../src/factory/schema.ts';
import { FactoryService } from '../src/factory/service.ts';
import { ProjectGitHub } from '../src/github.ts';
import { ProjectLearning } from '../src/learning.ts';
import { Store } from '../src/store.ts';
import { ProjectGateway } from '../src/web/projects.ts';

import { brokerUrl, createCleanup, createProject, until } from './helpers.ts';

import type { MeshConfig } from '../src/config.ts';
import type { ModelPolicyView } from '../src/factory/model-policy.ts';
import type { FactoryOptions } from '../src/factory/service.ts';

/** Minimal real validation commands. */
const setup = {
  testCommands: [{ file: process.execPath }],
  endToEndCommands: [{ file: process.execPath }],
  reviewStandards: ['Keep this unrelated standard.'],
};
/** A consistent explicit policy. */
const policy = {
  models: [
    { id: 'codex-fast', provider: 'codex', model: 'gpt-fast', capability: 'small', efforts: ['low', 'medium'] },
    { id: 'claude-deep', provider: 'claude', model: 'claude-opus-5-5', capability: 'advanced', efforts: ['high'] },
    { id: 'codex-plain', provider: 'codex', model: 'gpt-plain', capability: 'standard' },
  ],
  defaults: {
    small: { model: 'codex-fast', effort: 'low' },
    standard: { model: 'codex-plain', effort: null },
    advanced: { model: 'claude-deep', effort: 'high' },
  },
};

/**
 * Open one project's supervisor with substitutable side effects.
 *
 * @param mesh - Project configuration.
 * @param options - Optional fixture boundaries.
 * @returns Store and supervisor; the caller closes both.
 */
function open(mesh: MeshConfig, options: Partial<FactoryOptions> = {}): { store: Store; factory: FactoryService } {
  const store = new Store(mesh);
  const factory = new FactoryService(
    mesh,
    store,
    { learning: new ProjectLearning(mesh), github: new ProjectGitHub(mesh) },
    { home: mesh.root, ...options },
  );
  return { store, factory };
}

/**
 * Build a persisted job record.
 *
 * @param fields - Fields differing from a running learning claim.
 * @returns Validated job.
 */
function job(fields: Record<string, unknown>): z.output<typeof jobSchema> {
  const identity = { id: randomUUID(), role: 'learning-steward', provider: 'codex', kind: 'learn' };
  const lease = { state: 'running', startedAt: Date.now(), finishedAt: null, expiresAt: Date.now() + 60_000 };
  const evidence = { token: randomUUID(), taskId: null, featureId: null, reservation: 0, usageTokens: null, pid: null };
  return jobSchema.parse({ ...identity, ...lease, ...evidence, head: null, base: null, summary: null, ...fields });
}

/**
 * Read the operator policy view from status.
 *
 * @param factory - Selected project's supervisor.
 * @returns Validated view.
 */
function view(factory: FactoryService): ModelPolicyView {
  const status = factory.status();
  assert.ok(typeof status === 'object' && status !== null && 'modelPolicy' in status);
  return modelPolicyViewSchema.parse(status.modelPolicy);
}

await test('authenticated project controls round-trip policy and reject foreign revisions and credentials', async (t) => {
  const defer = createCleanup(t);
  const home = createProject(defer);
  const other = createProject(defer);
  const broker = await startBroker(home, { port: 0 });
  defer(async () => broker.close());
  const mesh = { ...home, url: brokerUrl(broker.port) };
  const gateway = new ProjectGateway(mesh);
  const target = z.object({ id: z.string() }).parse(await gateway.open(other.root));
  const statusSchema = z.object({ modelPolicy: modelPolicyViewSchema });
  const first = statusSchema.parse(await gateway.control('home', { operation: 'factory_setup', input: setup }));
  const second = statusSchema.parse(await gateway.control(target.id, { operation: 'factory_setup', input: setup }));
  const input = { expectedRevision: first.modelPolicy.revision, policy };
  await assert.rejects(rpc({ ...mesh, token: randomUUID() }, 'factory_model_policy', input), { code: 'UNAUTHORIZED' });
  await assert.rejects(gateway.control(target.id, { operation: 'factory_model_policy', input }), {
    code: 'STALE_REVISION',
  });
  const saved = statusSchema.parse(await gateway.control('home', { operation: 'factory_model_policy', input }));
  assert.equal(saved.modelPolicy.mode, 'explicit');
  assert.notEqual(saved.modelPolicy.revision, input.expectedRevision);
  await assert.rejects(gateway.control('home', { operation: 'factory_model_policy', input }), {
    code: 'STALE_REVISION',
  });
  const targetConfig = gateway.config(target.id);
  assert.deepEqual(
    statusSchema.parse(await rpc(targetConfig, 'factory_status', {})).modelPolicy,
    second.modelPolicy,
    'A browser-selected foreign project is unchanged.',
  );
  assert.deepEqual(statusSchema.parse(await rpc(mesh, 'factory_status', {})).modelPolicy, saved.modelPolicy);
});

await test('explicit policy validates atomically, rejects stale revisions and preserves unrelated settings', async (t) => {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  const { store, factory } = open(mesh);
  defer(async () => {
    await factory.close();
    store.close();
  });
  await assert.rejects(
    factory.execute('factory_model_policy', { expectedRevision: view(factory).revision, policy }),
    { code: 'FACTORY_GATED' },
    'An unconfigured project cannot accept policy.',
  );
  await factory.execute('factory_setup', setup);
  const legacy = view(factory);
  assert.equal(legacy.mode, 'legacy');
  assert.equal(legacy.policy, null);
  assert.equal(legacy.admission.state, 'legacy');
  assert.match(legacy.legacyRouting ?? '', /CLI default.*unknown/v);

  const [head, ...rest] = policy.models;
  const first = (fields: object): unknown => ({ ...policy, models: [{ ...head, ...fields }, ...rest] });
  const defaults = (value: object): unknown => ({ ...policy, defaults: value });
  const invalid: [string, unknown][] = [
    ['duplicate id', { ...policy, models: [...policy.models, { ...policy.models[2], model: 'other' }] }],
    ['duplicate native model', { ...policy, models: [...policy.models, { ...policy.models[2], id: 'again' }] }],
    ['duplicate effort', first({ efforts: ['low', 'low'] })],
    ['unknown reference', defaults({ small: { model: 'missing', effort: null } })],
    ['disabled default', first({ enabled: false })],
    ['capability below tier', defaults({ advanced: { model: 'codex-fast', effort: 'low' } })],
    ['effort not allowed', defaults({ small: { model: 'codex-fast', effort: 'max' } })],
    ['provider default with explicit efforts', defaults({ small: { model: 'codex-fast', effort: null } })],
    ['explicit effort without choices', defaults({ standard: { model: 'codex-plain', effort: 'low' } })],
    ['no defaults', defaults({})],
    ['unknown effort', first({ efforts: ['turbo'] })],
    ['self-declared verification', first({ effortSupport: 'verified' })],
    ['option-like model', first({ model: '--yolo' })],
    ['whitespace model', first({ model: 'a b' })],
    ['empty models', { models: [], defaults: {} }],
  ];
  for (const [name, candidate] of invalid) {
    await assert.rejects(
      factory.execute('factory_model_policy', { expectedRevision: legacy.revision, policy: candidate }),
      { name: 'ZodError' },
      name,
    );
    assert.deepEqual(view(factory), legacy, `${name} must not partially persist`);
  }

  const settings = factory.repository.config();
  await factory.execute('factory_model_policy', { expectedRevision: legacy.revision, policy });
  const explicit = view(factory);
  assert.equal(explicit.mode, 'explicit');
  assert.notEqual(explicit.revision, legacy.revision);
  assert.equal(explicit.policy?.models[2]?.enabled, true);
  assert.deepEqual(explicit.effortSupport, {
    'codex-fast': 'unknown',
    'claude-deep': 'unknown',
    'codex-plain': 'unknown',
  });
  assert.equal(explicit.admission.state, 'parked');
  assert.deepEqual(factory.repository.config(), settings, 'Policy updates preserve unrelated settings.');

  await assert.rejects(factory.execute('factory_model_policy', { expectedRevision: legacy.revision, policy: null }), {
    code: 'STALE_REVISION',
  });
  assert.deepEqual(view(factory), explicit, 'A stale write changes nothing.');

  await factory.execute('factory_setup', { ...setup, maxAttempts: 3 });
  assert.deepEqual(view(factory), explicit, 'Factory setup preserves the separate policy.');
  assert.equal(factory.repository.config()?.maxAttempts, 3);

  factory.repository.setActive(true);
  await assert.rejects(factory.execute('factory_model_policy', { expectedRevision: explicit.revision, policy: null }), {
    code: 'FACTORY_GATED',
  });
  factory.repository.setActive(false);
  const claim = job({ artifact: mesh.root });
  assert.ok(settings !== null);
  assert.ok(factory.repository.claim(claim, settings));
  await assert.rejects(
    factory.execute('factory_model_policy', { expectedRevision: explicit.revision, policy: null }),
    { code: 'FACTORY_GATED' },
    'A live claim held by another supervisor is not settled.',
  );
  factory.repository.saveJob({ ...claim, expiresAt: 1 });
  await assert.rejects(
    factory.execute('factory_model_policy', { expectedRevision: explicit.revision, policy: null }),
    { code: 'FACTORY_GATED' },
    'Lease expiry alone does not prove a running process has settled.',
  );
  factory.repository.saveJob({ ...claim, state: 'interrupted', finishedAt: Date.now() });

  await factory.execute('factory_model_policy', { expectedRevision: explicit.revision, policy: null });
  const restored = view(factory);
  assert.equal(restored.mode, 'legacy');
  assert.equal(restored.admission.state, 'legacy');
  assert.notEqual(restored.revision, explicit.revision);
});

await test('policy survives restart, existing projects load as legacy and revisions stay project-scoped', async (t) => {
  const defer = createCleanup(t);
  const first = createProject(defer);
  const second = createProject(defer);

  const previous = open(first);
  await previous.factory.execute('factory_setup', setup);
  const routing = { tier: 'standard', model: null, reason: 'Historical CLI default.', skillNames: ['factory-session'] };
  const settled = { state: 'succeeded', startedAt: 1, finishedAt: 2, expiresAt: 2, summary: 'Historical work.' };
  const historical = { role: 'developer-1', provider: 'claude', kind: 'develop', artifact: first.root };
  const history = job({ ...historical, ...settled, routing });
  run(
    previous.store.db,
    'INSERT INTO factory_jobs VALUES(?,?,?,?)',
    history.id,
    history.role,
    history.state,
    JSON.stringify(history),
  );
  const settings = previous.factory.repository.config();
  // Simulate a database created before model policy storage existed.
  previous.store.db.exec('DROP TABLE factory_model_policy');
  await previous.factory.close();
  previous.store.close();

  const upgraded = open(first);
  const legacy = view(upgraded.factory);
  assert.equal(legacy.mode, 'legacy');
  assert.deepEqual(upgraded.factory.repository.config(), settings);
  assert.deepEqual(
    upgraded.factory.repository.jobs().find((entry) => entry.id === history.id),
    history,
  );
  await upgraded.factory.execute('factory_model_policy', { expectedRevision: legacy.revision, policy });
  const saved = view(upgraded.factory);
  await upgraded.factory.close();
  upgraded.store.close();

  const restarted = open(first);
  const other = open(second);
  defer(async () => {
    await restarted.factory.close();
    restarted.store.close();
    await other.factory.close();
    other.store.close();
  });
  assert.deepEqual(view(restarted.factory), saved, 'Policy and revision survive restart.');

  await other.factory.execute('factory_setup', setup);
  const untouched = view(other.factory);
  assert.equal(untouched.mode, 'legacy', 'Another project never sees this policy.');
  assert.notEqual(untouched.revision, legacy.revision, 'Legacy revisions are project-unique.');
  for (const expectedRevision of [legacy.revision, saved.revision]) {
    await assert.rejects(
      other.factory.execute('factory_model_policy', { expectedRevision, policy: null }),
      { code: 'STALE_REVISION' },
      'A revision read from one project cannot update another.',
    );
  }
  assert.deepEqual(view(other.factory), untouched);
});

await test('explicit policy parks admission with an actionable reason and never invokes a model', async (t) => {
  const defer = createCleanup(t);
  const fixture = createProject(defer);
  await command('git', ['init', '--bare', `${fixture.root}/origin.git`], fixture.root);
  const mesh = loadConfig(`${fixture.root}/source`, { create: true });
  await command('git', ['init'], mesh.root);
  await command('git', ['remote', 'add', 'origin', `${fixture.root}/origin.git`], mesh.root);
  let invocations = 0;
  const unused = async (): Promise<never> => {
    invocations += 1;
    await Promise.resolve();
    throw new Error('Parked admission must not reach this boundary.');
  };
  const stages = { verify: unused, readyIssues: unused, provision: unused, pullRequest: unused, inspect: unused };
  const { store, factory } = open(mesh, {
    agent: unused,
    resources: () => ({ freeMemoryMb: 10_000, totalMemoryMb: 20_000, cpuPercent: 1 }),
    remote: { ...stages, merge: unused, parentComplete: unused, effect: unused },
  });
  defer(async () => {
    await factory.close();
    store.close();
  });
  await factory.execute('factory_setup', factoryConfigSchema.parse(setup));
  await factory.execute('factory_model_policy', { expectedRevision: view(factory).revision, policy });
  await factory.execute('factory_request', { objective: 'Plan a change that would otherwise start inference.' });
  await factory.execute('factory_start', {});
  const parked = (): string => {
    const status = factory.status();
    assert.ok(typeof status === 'object' && status !== null && 'error' in status);
    return String(status.error);
  };
  await until(() => {
    void factory.tick();
    return parked() !== 'null';
  });
  assert.match(parked(), /cannot yet enforce.*parked without inference.*restore legacy routing/v);
  assert.equal(factory.repository.jobs().length, 0, 'No role is claimed or reserved.');
  assert.equal(invocations, 0);
  assert.equal(factory.repository.features()[0]?.phase, 'queued');
});
