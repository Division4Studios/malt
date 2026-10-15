/**
 * Durable objective ordering through the actual project broker.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { z } from 'zod';

import { startBroker } from '../src/broker.ts';
import { AgentClient, rpc } from '../src/client.ts';
import { run } from '../src/database.ts';
import { objectiveOrder, reorderObjective } from '../src/factory/objective-order.ts';
import { queueObjective } from '../src/factory/objectives.ts';
import { FactoryRepository } from '../src/factory/repository.ts';
import { factoryConfigSchema, featureSchema, jobSchema, resultSchema } from '../src/factory/schema.ts';
import { Store } from '../src/store.ts';
import { startWebConsole } from '../src/web/server.ts';

import { createCleanup, createProject, brokerUrl } from './helpers.ts';

/** Ranked feature projection. */
const rankedFeatureSchema = featureSchema.extend({ rank: z.number() });
/** Public ordering contract. */
const orderSchema = z.object({
  orderRevision: z.number(),
  features: z.array(rankedFeatureSchema),
});

await test('legacy order migrates losslessly, reopens and appends without changing insertion enumeration', (t) => {
  const defer = createCleanup(t);
  const config = createProject(defer);
  let store = new Store(config);
  let repository = new FactoryRepository(store);
  assert.deepEqual(repository.features(), []);
  const plan = resultSchema.parse({
    outcome: 'success',
    summary: 'Retained plan',
    findings: ['Evidence'],
    deliveries: [],
  });
  const features = [30, 10, 10].map((createdAt) => {
    return featureSchema.parse({
      id: randomUUID(),
      objective: 'Legacy',
      phase: 'blocked',
      productPlan: plan,
      plan,
      parentIssue: 42,
      error: 'retained',
      createdAt,
      updatedAt: 50,
      scopeReplacement: randomUUID(),
      scopeCleanup: { at: 40, note: 'retained cleanup' },
    });
  });
  for (const feature of features) {
    run(store.db, 'INSERT INTO factory_features VALUES(?,?)', feature.id, JSON.stringify(feature));
  }
  store.close();
  store = new Store(config);
  repository = new FactoryRepository(store);
  const migrated = repository.features();
  assert.deepEqual(
    migrated.map((feature) => feature.rank),
    [2, 0, 1],
  );
  assert.deepEqual(
    migrated.map(({ rank: _rank, ...feature }) => feature),
    features,
  );
  const appended = queueObjective(repository, { objective: 'Appended' });
  assert.equal(repository.features().find((feature) => feature.id === appended.featureId)?.rank, 3);
  const saved = repository.features();
  store.close();
  store = new Store(config);
  repository = new FactoryRepository(store);
  assert.deepEqual(repository.features(), saved);
  store.close();
});

await test('operator moves are atomic, replayable and fenced by the project revision', async (t) => {
  const defer = createCleanup(t);
  const config = createProject(defer);
  const broker = await startBroker(config, { port: 0 });
  defer(async () => broker.close());
  const connected = { ...config, url: brokerUrl(broker.port) };
  const repository = new FactoryRepository(broker.store);
  const ids = ['A', 'B', 'C'].map((objective) => queueObjective(repository, { objective }).featureId);
  const before = orderSchema.parse(await rpc(connected, 'factory_status', {}));
  const staleFeature = repository.features()[0];
  assert.ok(staleFeature !== undefined);
  const input = {
    featureId: ids[2] ?? '',
    beforeFeatureId: ids[0],
    expectedRevision: before.orderRevision,
    requestId: randomUUID(),
  };
  const worker = new AgentClient(connected, { name: 'worker', role: 'worker' });
  await worker.connect();
  defer(async () => worker.close());
  await assert.rejects(worker.call('factory_reorder_objective', input), { code: 'NOT_ORCHESTRATOR' });
  const lead = new AgentClient(connected, { name: 'lead', role: 'lead' });
  await lead.connect();
  defer(async () => lead.close());
  const moved = orderSchema.parse(await lead.call('factory_reorder_objective', input));
  assert.equal(moved.orderRevision, before.orderRevision + 1);
  assert.deepEqual(
    moved.features.toSorted((a, b) => a.rank - b.rank).map((feature) => feature.id),
    [ids[2], ids[0], ids[1]],
  );
  assert.deepEqual(await rpc(connected, 'factory_reorder_objective', input), moved);
  await assert.rejects(rpc(connected, 'factory_reorder_objective', { ...input, beforeFeatureId: ids[1] }));
  await assert.rejects(rpc(connected, 'factory_reorder_objective', { ...input, requestId: randomUUID() }));
  for (const invalid of [
    { featureId: randomUUID(), beforeFeatureId: ids[0] },
    { featureId: ids[0], beforeFeatureId: ids[0] },
    { featureId: ids[0], beforeFeatureId: randomUUID() },
    { featureId: ids[0] },
    { featureId: ids[0], beforeFeatureId: ids[1], afterFeatureId: ids[2] },
  ]) {
    await assert.rejects(
      rpc(connected, 'factory_reorder_objective', { ...invalid, expectedRevision: moved.orderRevision }),
    );
  }
  assert.deepEqual(orderSchema.parse(await rpc(connected, 'factory_status', {})), moved);
  broker.store.db.exec(
    "CREATE TRIGGER fail_order_receipt BEFORE INSERT ON factory_order_requests BEGIN SELECT RAISE(ABORT,'fixture failure'); END",
  );
  const retry = {
    featureId: ids[0],
    afterFeatureId: ids[1],
    expectedRevision: moved.orderRevision,
    requestId: randomUUID(),
  };
  await assert.rejects(rpc(connected, 'factory_reorder_objective', retry));
  assert.deepEqual(
    orderSchema.parse(await rpc(connected, 'factory_status', {})),
    moved,
    'rank writes roll back with receipt failure',
  );
  broker.store.db.exec('DROP TRIGGER fail_order_receipt');
  repository.saveFeature({ ...staleFeature, phase: 'active' });
  assert.equal(repository.features()[0]?.rank, 1, 'running work cannot restore an old rank');
  const restored = new Store(config);
  const reopened = new FactoryRepository(restored);
  assert.deepEqual(reorderObjective(restored, input), moved, 'receipt survives another store connection');
  assert.equal(reopened.features()[0]?.rank, 1);
  restored.close();
});

await test('web reorder preserves running claims, rejects foreign and retired objectives, and fences concurrent moves', async (t) => {
  const defer = createCleanup(t);
  const config = createProject(defer);
  const broker = await startBroker(config, { port: 0 });
  defer(async () => broker.close());
  const connected = { ...config, url: brokerUrl(broker.port) };
  const repository = new FactoryRepository(broker.store);
  const settings = factoryConfigSchema.parse({
    testCommands: [{ file: process.execPath }],
    endToEndCommands: [{ file: process.execPath }],
  });
  repository.configure(settings);
  const ids = ['A', 'B', 'Done', 'Superseded'].map((objective) => queueObjective(repository, { objective }).featureId);
  for (const feature of repository.features().slice(2)) {
    repository.saveFeature({
      ...feature,
      ...(feature.objective === 'Done' ? { phase: 'done' as const } : { scopeReplacement: ids[0] }),
    });
  }
  const job = jobSchema.parse({
    id: randomUUID(),
    role: 'developer-1',
    provider: 'codex',
    kind: 'develop',
    taskId: null,
    featureId: ids[0],
    token: randomUUID(),
    state: 'running',
    startedAt: 1,
    finishedAt: null,
    expiresAt: Date.now() + 60_000,
    reservation: 0,
    usageTokens: null,
    pid: null,
    head: null,
    base: null,
    summary: null,
    artifact: config.directory,
  });
  assert.equal(repository.claim(job, settings), true);
  const foreign = new Store(createProject(defer));
  defer(() => {
    foreign.close();
  });
  const foreignRepository = new FactoryRepository(foreign);
  const foreignId = queueObjective(foreignRepository, { objective: 'Other project' }).featureId;
  const foreignBefore = foreignRepository.features();
  const before = orderSchema.parse(await rpc(connected, 'factory_status', {}));
  for (const id of [ids[2], ids[3], foreignId]) {
    for (const idsToMove of [
      { featureId: id, afterFeatureId: ids[0] },
      { featureId: ids[0], afterFeatureId: id },
    ]) {
      await assert.rejects(
        rpc(connected, 'factory_reorder_objective', { ...idsToMove, expectedRevision: before.orderRevision }),
      );
    }
  }
  const web = await startWebConsole(connected, 0);
  defer(async () => web.close());
  const pair = await fetch(`${web.url}/api/pair`, {
    method: 'POST',
    headers: { Origin: web.url, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: web.pairingCode }),
  });
  const headers = {
    Origin: web.url,
    'Content-Type': 'application/json',
    Cookie: (pair.headers.get('set-cookie') ?? '').split(';', 1)[0] ?? '',
  };
  const body = JSON.stringify({
    operation: 'factory_reorder_objective',
    input: { featureId: ids[0], afterFeatureId: ids[1], expectedRevision: before.orderRevision },
  });
  const url = `${web.url}/api/control?project=home`;
  assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, Cookie: '' }, body })).status, 401);
  assert.equal(
    (await fetch(url, { method: 'POST', headers: { ...headers, Origin: 'https://foreign.invalid' }, body })).status,
    403,
  );
  const responses = await Promise.all([
    fetch(url, { method: 'POST', headers, body }),
    fetch(url, { method: 'POST', headers, body }),
  ]);
  assert.equal(responses.filter((response) => response.ok).length, 1);
  const after = orderSchema.parse(await rpc(connected, 'factory_status', {}));
  assert.equal(after.orderRevision, before.orderRevision + 1);
  assert.deepEqual(
    after.features.map((feature) => feature.rank),
    [1, 0, 2, 3],
  );
  assert.deepEqual(
    after.features.map(({ rank: _rank, ...feature }) => feature),
    before.features.map(({ rank: _rank, ...feature }) => feature),
  );
  assert.deepEqual(repository.jobs(), [job]);
  assert.deepEqual(foreignRepository.features(), foreignBefore);
  const snapshot = await fetch(`${web.url}/api/snapshot?project=home`, { headers });
  assert.equal(
    z.object({ factory: orderSchema }).parse(await snapshot.json()).factory.orderRevision,
    after.orderRevision,
  );
});

await test('order reads use one SQLite snapshot without a write lock or summary refresh', (t) => {
  const defer = createCleanup(t);
  const config = createProject(defer);
  const reader = new Store(config);
  defer(() => {
    reader.close();
  });
  const repository = new FactoryRepository(reader);
  queueObjective(repository, { objective: 'Existing objective' });
  const writer = new Store(config);
  defer(() => {
    writer.close();
  });
  new FactoryRepository(writer);
  const prior = objectiveOrder(reader);
  t.mock.method(reader, 'transaction', () => {
    assert.fail('A read must not enter the write transaction wrapper.');
  });
  t.mock.method(reader, 'refreshSummary', () => {
    assert.fail('A read must not regenerate project files.');
  });
  writer.db.exec('BEGIN IMMEDIATE');
  try {
    writer.db.exec('UPDATE factory_objective_order SET revision=revision+1 WHERE id=1');
    assert.deepEqual(
      objectiveOrder(reader),
      prior,
      'A concurrent writer must not block read-only snapshots or expose uncommitted revisions.',
    );
    writer.db.exec('COMMIT');
  } finally {
    if (writer.db.isTransaction) {
      writer.db.exec('ROLLBACK');
    }
  }
  const after = objectiveOrder(reader);
  assert.equal(after.orderRevision, prior.orderRevision + 1);
  assert.deepEqual(after.features, prior.features);
});
