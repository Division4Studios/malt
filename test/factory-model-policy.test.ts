/** @file Explicit policy validation, atomic revisions and unpaid compatibility gates. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { z } from 'zod/v3';

import { startBroker } from '../src/broker.ts';
import { rpc } from '../src/client.ts';
import { modelPolicySchema } from '../src/factory/model-policy.ts';
import { FactoryRepository } from '../src/factory/repository.ts';
import { factoryConfigSchema } from '../src/factory/schema.ts';
import { FactoryService } from '../src/factory/service.ts';
import { ProjectGitHub } from '../src/github.ts';
import { ProjectLearning } from '../src/learning.ts';
import { Store } from '../src/store.ts';

import { brokerUrl, createCleanup, createProject } from './helpers.ts';

/** Fixture names are not provider recommendations or capability certification. */
const policy = {
  revision: 1,
  entries: [
    {
      id: 'normal',
      provider: 'codex',
      model: 'fixture-model',
      capability: 'standard',
      effortSupport: 'unknown',
      efforts: [],
      evidence: null,
    },
  ],
  defaults: [{ provider: 'codex', tier: 'standard', entryId: 'normal', effort: null }],
};
/** Existing implicit configuration must retain all unrelated fields. */
const settings = factoryConfigSchema.parse({
  testCommands: [{ file: process.execPath }],
  endToEndCommands: [{ file: process.execPath }],
  maxDiffLines: 321,
  providers: { codex: { executable: 'fixture' } },
});

await test('policy rejects duplicate identities, contradictory effort and invalid defaults atomically', () => {
  assert.equal(modelPolicySchema.safeParse(policy).success, true);
  const entry = policy.entries[0];
  assert.ok(entry !== undefined);
  for (const invalid of [
    { ...policy, entries: [entry, entry] },
    { ...policy, entries: [entry, { ...entry, id: 'another', capability: 'advanced' }] },
    { ...policy, entries: [{ ...entry, efforts: ['low'] }] },
    { ...policy, entries: [{ ...entry, effortSupport: 'none' }] },
    { ...policy, entries: [{ ...entry, provider: 'claude', effortSupport: 'codex-config', efforts: ['low'] }] },
    { ...policy, defaults: [policy.defaults[0], policy.defaults[0]] },
    { ...policy, defaults: [{ provider: 'codex', tier: 'advanced', entryId: 'normal', effort: null }] },
    { ...policy, defaults: [{ provider: 'codex', tier: 'standard', entryId: 'missing', effort: null }] },
    { ...policy, defaults: [{ provider: 'codex', tier: 'standard', entryId: 'normal', effort: 'high' }] },
    { ...policy, entries: [{ ...entry, model: '--unsafe-flag' }] },
  ]) {
    assert.equal(modelPolicySchema.safeParse(invalid).success, false);
  }
  assert.equal(
    modelPolicySchema.safeParse({
      ...policy,
      entries: [
        {
          ...entry,
          effortSupport: 'codex-config',
          efforts: ['low'],
          evidence: { source: 'Fixture help, not a live probe', version: 'fixture-1', observedAt: 1000 },
        },
      ],
      defaults: [{ provider: 'codex', tier: 'standard', entryId: 'normal', effort: 'low' }],
    }).success,
    true,
  );
});

await test('authenticated policy updates preserve settings, reject stale writes and survive restart', async (t) => {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  const broker = await startBroker(mesh, { port: 0 });
  defer(async () => {
    if (broker.store.db.isOpen) {
      await broker.close();
    }
  });
  const connected = { ...mesh, url: brokerUrl(broker.port) };
  const repository = new FactoryRepository(broker.store);
  await rpc(connected, 'factory_setup', settings);
  assert.equal(repository.config()?.modelPolicy, undefined);
  await rpc(connected, 'factory_model_policy', { expectedRevision: null, policy });
  const first = repository.config();
  assert.deepEqual(first, { ...settings, modelPolicy: modelPolicySchema.parse(policy) });
  await assert.rejects(
    rpc(connected, 'factory_model_policy', { expectedRevision: null, policy: { ...policy, revision: 2 } }),
  );
  await assert.rejects(rpc(connected, 'factory_setup', settings), /Stale model policy/v);
  assert.deepEqual(repository.config(), first);
  const settled = await Promise.allSettled([
    rpc(connected, 'factory_model_policy', { expectedRevision: 1, policy: { ...policy, revision: 2 } }),
    rpc(connected, 'factory_model_policy', { expectedRevision: 1, policy: { ...policy, revision: 2 } }),
  ]);
  assert.equal(settled.filter((result) => result.status === 'fulfilled').length, 1);
  broker.store.db.exec(
    "CREATE TRIGGER reject_policy_write BEFORE UPDATE ON factory_settings BEGIN SELECT RAISE(ABORT,'fixture write failure'); END",
  );
  await assert.rejects(
    rpc(connected, 'factory_model_policy', { expectedRevision: 2, policy: { ...policy, revision: 3 } }),
  );
  assert.equal(repository.config()?.modelPolicy?.revision, 2);
  assert.equal(
    broker.store.db.prepare("SELECT count(*) AS count FROM metadata WHERE key='factory_model_policy_v1:3'").get()?.[
      'count'
    ],
    0,
    'archive and settings roll back together',
  );
  broker.store.db.exec('DROP TRIGGER reject_policy_write');
  repository.setActive(true);
  await assert.rejects(
    rpc(connected, 'factory_model_policy', { expectedRevision: 2, policy: { ...policy, revision: 3 } }),
    /Pause/v,
  );
  repository.setActive(false);
  const other = new Store(createProject(defer));
  defer(() => {
    other.close();
  });
  const isolated = new FactoryRepository(other);
  isolated.configure(settings);
  assert.equal(isolated.config()?.modelPolicy, undefined);
  assert.throws(() => {
    isolated.configure(factoryConfigSchema.parse({ ...settings, modelPolicy: { ...policy, revision: 2 } }));
  }, /Stale/v);
  assert.equal(isolated.config()?.modelPolicy, undefined);
  await broker.close();
  const reopened = new Store(mesh);
  defer(() => {
    reopened.close();
  });
  const restored = new FactoryRepository(reopened);
  assert.equal(restored.config()?.modelPolicy?.revision, 2);
  assert.equal(
    reopened.db.prepare("SELECT count(*) AS count FROM metadata WHERE key LIKE 'factory_model_policy_v1:%'").get()?.[
      'count'
    ],
    2,
  );
});

await test('saved explicit policy cannot dispatch through the legacy route before enforcement', async (t) => {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  let launches = 0;
  const store = new Store(mesh);
  const factory = new FactoryService(
    mesh,
    store,
    { github: new ProjectGitHub(mesh), learning: new ProjectLearning(mesh) },
    {
      home: mesh.root,
      agent: async () => {
        await Promise.resolve();
        launches += 1;
        throw new Error('No inference is permitted by this fixture.');
      },
      resources: () => ({ freeMemoryMb: 10_000, totalMemoryMb: 20_000, cpuPercent: 1 }),
    },
  );
  defer(async () => {
    await factory.close();
    store.close();
  });
  await factory.execute('factory_setup', settings);
  await factory.execute('factory_model_policy', { expectedRevision: null, policy });
  await factory.execute('factory_request', { objective: 'Do not start through a legacy selection.' });
  const { repository } = factory;
  repository.setActive(true);
  await factory.tick();
  await factory.tick();
  assert.equal(launches, 0);
  assert.deepEqual(repository.jobs(), []);
  const status = z.object({ error: z.string().nullable() }).parse(await factory.status());
  assert.match(status.error ?? '', /Explicit model policy.*No inference launched/v);
});
