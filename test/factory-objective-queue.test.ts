/**
 * Durable operator priority survives restart without clearing delivery blockers.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { queueObjective } from '../src/factory/objectives.ts';
import { FactoryRepository } from '../src/factory/repository.ts';
import { Store } from '../src/store.ts';

import { createCleanup, createProject } from './helpers.ts';

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
  const original = queue.read(repository.features());
  assert.deepEqual(original.order, [a, b]);
  const input = { expectedRevision: 0, order: [b, a], focusedFeatureId: b };
  const saved = queue.update(repository.features(), input);
  assert.equal(saved.revision, 1);
  assert.throws(() => queue.update(repository.features(), input), /queue changed/v);
  const initialRepository = repository;
  for (const order of [[a, a], [a, randomUUID()], [a]]) {
    assert.throws(() => queue.update(initialRepository.features(), { ...input, expectedRevision: 1, order }));
  }
  assert.throws(() =>
    queue.update(repository.features(), { ...input, expectedRevision: 1, focusedFeatureId: randomUUID() }),
  );
  assert.deepEqual(queue.read(repository.features()), saved);
  assert.equal(repository.features().find((feature) => feature.id === b)?.phase, 'blocked');
  store.close();
  store = new Store(mesh);
  repository = new FactoryRepository(store);
  assert.deepEqual(repository.objectiveQueue.read(repository.features()), saved);
  const third = queueObjective(repository, { objective: 'Later work' }).featureId;
  assert.deepEqual(repository.objectiveQueue.read(repository.features()).order, [b, a, third]);
  const other = new Store(createProject(defer));
  defer(() => {
    other.close();
  });
  const otherRepository = new FactoryRepository(other);
  assert.deepEqual(otherRepository.objectiveQueue.read([]), {
    revision: 0,
    order: [],
    focusedFeatureId: null,
  });
  const current = repository.features().find((feature) => feature.id === b);
  assert.ok(current !== undefined);
  repository.saveFeature({ ...current, phase: 'done' });
  assert.equal(repository.objectiveQueue.read(repository.features()).focusedFeatureId, null);
});
