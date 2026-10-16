/** @file Local-only proposal freshness and compatibility with pre-observation native-ticket identities. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { queueObjective } from '../src/factory/objectives.ts';
import { decideRecommendation } from '../src/factory/recommendation-decisions.ts';
import { objectiveObservation } from '../src/factory/recommendation-objectives.ts';
import { FactoryRepository } from '../src/factory/repository.ts';
import { recommendationBodySchema } from '../src/factory/schema.ts';
import { Store } from '../src/store.ts';

import { proposal } from './fixtures/recommendations.ts';
import { createCleanup, createProject } from './helpers.ts';

await test('local scope changes stale a decision without inventing a native issue; phase movement is stable', async (t) => {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  let store = new Store(mesh);
  defer(() => {
    store.close();
  });
  let repository = new FactoryRepository(store);
  const id = queueObjective(repository, { objective: 'Recover queued work without duplicating source.' }).featureId;
  const observed = objectiveObservation(repository, id);
  assert.ok(observed !== null);
  const feature = repository.features().find((item) => item.id === id);
  assert.ok(feature !== undefined);
  repository.saveFeature({ ...feature, phase: 'refining', updatedAt: feature.updatedAt + 1 });
  assert.deepEqual(objectiveObservation(repository, id), observed);
  const body = {
    ...proposal,
    tickets: [],
    observedIssues: [],
    observedObjectives: [observed],
    affectedAssignments: [id],
  };
  assert.equal(recommendationBodySchema.safeParse({ ...body, observedObjectives: undefined }).success, false);
  assert.equal(recommendationBodySchema.safeParse({ ...body, kind: 'duplicate' }).success, false);
  assert.equal(recommendationBodySchema.safeParse({ ...body, survivor: 99 }).success, false);
  assert.equal(
    recommendationBodySchema.safeParse({ ...body, observedObjectives: [observed, observed] }).success,
    false,
  );
  const record = repository.recommendations.propose(body);
  repository.recommendations.transition({
    id: record.id,
    revision: record.revision,
    state: 'proposed',
    next: 'awaiting_human',
    reason: 'Local-only fixture submission',
  });
  repository.saveFeature({ ...feature, objective: 'Different acceptance and scope.' });
  const result = await decideRecommendation(repository, undefined, {
    operationId: randomUUID(),
    id: record.id,
    revision: record.revision,
    decision: 'approve',
    rationale: 'Reviewed old local scope',
  });
  assert.equal(result.outcome, 'stale');
  assert.equal(repository.effects().length, 0);
  const legacy = repository.recommendations.propose(proposal);
  assert.equal(
    legacy.revision,
    '58be783b019fa82f46762f1419386dfd5358cc7a9770a5dfdb4d40b11b561345',
    'Captured from main before extracting or extending the recommendation schema.',
  );
  store.close();
  store = new Store(mesh);
  repository = new FactoryRepository(store);
  assert.equal(repository.recommendations.get(record.id)?.state, 'stale');
  assert.equal(repository.recommendations.propose(proposal).revision, legacy.revision);
  assert.equal(objectiveObservation(repository, randomUUID()), null);
});
