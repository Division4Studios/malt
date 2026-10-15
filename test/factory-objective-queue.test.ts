/**
 * Durable operator priority survives restart without clearing delivery blockers.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { z } from 'zod';

import { startBroker } from '../src/broker.ts';
import { rpc } from '../src/client.ts';
import { run } from '../src/database.ts';
import { objectiveOrder, reorderObjective } from '../src/factory/objective-order.ts';
import { objectiveQueueSchema, MAX_OBJECTIVES } from '../src/factory/objective-queue-schema.ts';
import { queueObjective } from '../src/factory/objectives.ts';
import { FactoryRepository } from '../src/factory/repository.ts';
import { Store } from '../src/store.ts';
import { writeAtomic } from '../src/summary.ts';

import { createCleanup, createProject, CLI_PATH, updateConfig, brokerUrl } from './helpers.ts';

await test('objective order and focus survive restart and reject stale, foreign and duplicate writes', (t) => {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  let store = new Store(mesh);
  defer(() => {
    store.close();
  });
  let repository = new FactoryRepository(store);
  const a = queueObjective(repository, { objective: 'Existing feature' }).featureId;
  const b = queueObjective(repository, { objective: 'Repair blocker' }).featureId;
  const features = repository.features();
  const blocked = features.find((feature) => feature.id === b);
  assert.ok(blocked !== undefined);
  repository.saveFeature({ ...blocked, phase: 'blocked', error: 'Needs repair' });
  const queue = repository.objectiveQueue;
  const original = queue.read();
  assert.deepEqual(original.order, [a, b]);
  const input = { expectedRevision: original.revision, order: [b, a], focusedFeatureId: b };
  const saved = queue.update(input);
  assert.equal(saved.revision, original.revision + 1);
  assert.throws(() => queue.update(input), /queue changed/v);
  for (const order of [[a, a], [a, randomUUID()], [a]]) {
    assert.throws(() => queue.update({ ...input, expectedRevision: saved.revision, order }));
  }
  assert.throws(() => queue.update({ ...input, expectedRevision: saved.revision, focusedFeatureId: randomUUID() }));
  assert.deepEqual(queue.read(), saved);
  assert.equal(repository.features().find((feature) => feature.id === b)?.phase, 'blocked');
  store.close();
  store = new Store(mesh);
  repository = new FactoryRepository(store);
  assert.deepEqual(repository.objectiveQueue.read(), saved);
  const third = queueObjective(repository, { objective: 'Later work' }).featureId;
  assert.deepEqual(repository.objectiveQueue.read().order, [b, a, third]);
  const other = new Store(createProject(defer));
  defer(() => {
    other.close();
  });
  const otherRepository = new FactoryRepository(other);
  assert.deepEqual(otherRepository.objectiveQueue.read(), {
    revision: 0,
    order: [],
    focusedFeatureId: null,
  });
  const current = repository.features().find((feature) => feature.id === b);
  assert.ok(current !== undefined);
  repository.saveFeature({ ...current, phase: 'done' });
  assert.equal(repository.objectiveQueue.read().focusedFeatureId, null);
});

await test('archived history does not overflow the queue and creation cannot exceed its unfinished limit', (t) => {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  const store = new Store(mesh);
  defer(() => {
    store.close();
  });
  const repository = new FactoryRepository(store);
  const requestId = randomUUID();
  queueObjective(repository, { objective: 'Pending', requestId });
  const pending = repository.features()[0];
  assert.ok(pending !== undefined);
  const archived = Array.from({ length: MAX_OBJECTIVES + 1 }, () => {
    return {
      ...pending,
      id: randomUUID(),
      phase: 'done' as const,
    };
  });
  store.transaction(() => {
    const insert = store.db.prepare('INSERT INTO factory_features VALUES(?,?)');
    for (const feature of archived) {
      insert.run(feature.id, JSON.stringify(feature));
    }
  });
  const queue = repository.objectiveQueue.read();
  assert.deepEqual(objectiveQueueSchema.parse(queue).order, [pending.id]);
  assert.equal(
    repository.objectiveQueue.update({
      expectedRevision: queue.revision,
      order: [pending.id],
      focusedFeatureId: pending.id,
    }).revision,
    queue.revision + 1,
  );
  store.transaction(() => {
    const insert = store.db.prepare('INSERT INTO factory_features VALUES(?,?)');
    for (let index = 1; index < MAX_OBJECTIVES; index += 1) {
      const value = { ...pending, id: randomUUID() };
      insert.run(value.id, JSON.stringify(value));
    }
  });
  assert.throws(() => queueObjective(repository, { objective: 'Would overflow' }), /5,000 unfinished/v);
  assert.deepEqual(
    queueObjective(repository, { objective: 'Pending', requestId }),
    { featureId: requestId },
    'An exact retry remains idempotent at capacity.',
  );
  assert.equal(repository.objectiveQueue.read().order.length, MAX_OBJECTIVES);
});

await test('legacy queue migrates once; both controls share ranks, revisions, receipts and rollback', (t) => {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  let store = new Store(mesh);
  defer(() => {
    store.close();
  });
  let repository = new FactoryRepository(store);
  const a = queueObjective(repository, { objective: 'A' }).featureId;
  const b = queueObjective(repository, { objective: 'B' }).featureId;
  run(
    store.db,
    'INSERT INTO factory_objective_queue VALUES(1,?)',
    JSON.stringify({ revision: 19, order: [b, a], focusedFeatureId: b }),
  );
  store.db.exec("DELETE FROM metadata WHERE key='factory_queue_ranks_v1'");
  store.close();
  store = new Store(mesh);
  repository = new FactoryRepository(store);
  assert.deepEqual(repository.objectiveQueue.read(), { revision: 20, order: [b, a], focusedFeatureId: b });
  const input = { featureId: a, beforeFeatureId: b, expectedRevision: 20, requestId: randomUUID() };
  const receipt = reorderObjective(store, input);
  assert.deepEqual(repository.objectiveQueue.read(), { revision: 21, order: [a, b], focusedFeatureId: b });
  const next = repository.objectiveQueue.update({ expectedRevision: 21, order: [b, a], focusedFeatureId: null });
  assert.equal(objectiveOrder(store).orderRevision, next.revision);
  assert.deepEqual(reorderObjective(store, input), receipt);
  assert.deepEqual(repository.objectiveQueue.read(), next, 'Replaying a relative move must not restore its old order.');
  assert.throws(
    () => repository.objectiveQueue.update({ order: next.order, focusedFeatureId: null, expectedRevision: 20 }),
    /queue changed/v,
  );
  const before = repository.objectiveQueue.snapshot();
  store.db.exec(
    "CREATE TRIGGER fail_queue BEFORE INSERT ON factory_objective_queue BEGIN SELECT RAISE(ABORT,'fixture failure'); END",
  );
  assert.throws(() =>
    repository.objectiveQueue.update({ expectedRevision: next.revision, order: [a, b], focusedFeatureId: a }),
  );
  assert.deepEqual(repository.objectiveQueue.snapshot(), before, 'Ranks, revision and focus roll back together.');
  store.close();
  store = new Store(mesh);
  repository = new FactoryRepository(store);
  assert.deepEqual(repository.objectiveQueue.snapshot(), before, 'Restart must not reapply the legacy order.');
});

await test('queue snapshots do not take a write lock or regenerate README while another connection writes', (t) => {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  const reader = new Store(mesh);
  defer(() => {
    reader.close();
  });
  const repository = new FactoryRepository(reader);
  queueObjective(repository, { objective: 'Retained work' });
  const writer = new Store(mesh);
  defer(() => {
    writer.close();
  });
  const before = repository.objectiveQueue.snapshot();
  t.mock.method(reader, 'transaction', () => {
    assert.fail('No write transaction during a status read.');
  });
  t.mock.method(reader, 'refreshSummary', () => {
    assert.fail('No README refresh during a status read.');
  });
  writer.db.exec('BEGIN IMMEDIATE');
  try {
    writer.db.exec('UPDATE factory_objective_order SET revision=revision+1 WHERE id=1');
    assert.deepEqual(repository.objectiveQueue.snapshot(), before);
    writer.db.exec('COMMIT');
  } finally {
    if (writer.db.isTransaction) {
      writer.db.exec('ROLLBACK');
    }
  }
  assert.equal(repository.objectiveQueue.read().revision, before.orderRevision + 1);
});

await test('real factory-queue CLI and relative RPC moves publish one consistent status order', async (t) => {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  const broker = await startBroker(mesh, { port: 0 });
  defer(async () => broker.close());
  const connected = updateConfig(mesh, { url: brokerUrl(broker.port) });
  const repository = new FactoryRepository(broker.store);
  const a = queueObjective(repository, { objective: 'A' }).featureId;
  const b = queueObjective(repository, { objective: 'B' }).featureId;
  const before = repository.objectiveQueue.read();
  const file = path.join(mesh.directory, 'queue.json');
  writeAtomic(file, JSON.stringify({ expectedRevision: before.revision, order: [b, a], focusedFeatureId: b }));
  const cli = await promisify(execFile)(
    process.execPath,
    [CLI_PATH, 'factory-queue', '--project', mesh.root, '--file', file],
    { timeout: 10_000 },
  );
  const saved = objectiveQueueSchema.parse(JSON.parse(cli.stdout));
  assert.deepEqual(saved, { revision: before.revision + 1, order: [b, a], focusedFeatureId: b });
  await rpc(connected, 'factory_reorder_objective', {
    featureId: a,
    beforeFeatureId: b,
    expectedRevision: saved.revision,
  });
  const status = z
    .object({ orderRevision: z.number(), objectiveQueue: objectiveQueueSchema })
    .parse(await rpc(connected, 'factory_status', {}));
  assert.deepEqual(status.objectiveQueue, { revision: saved.revision + 1, order: [a, b], focusedFeatureId: b });
  assert.equal(status.orderRevision, status.objectiveQueue.revision);
});
