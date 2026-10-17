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

import { proposal, readObservation } from './fixtures/recommendations.ts';
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
  assert.match(repository.recommendations.get(record.id)?.audit.at(-1)?.reason ?? '', /Local objective scope/v);
  const other = queueObjective(repository, { objective: 'Independently related local work.' }).featureId;
  const otherScope = objectiveObservation(repository, other);
  assert.ok(otherScope !== null);
  const unrelated = repository.recommendations.propose({
    ...body,
    observedObjectives: [otherScope],
    affectedAssignments: [other],
  });
  assert.notEqual(unrelated.id, record.id, 'Unrelated local-only scopes cannot supersede one another.');
  repository.recommendations.transition({
    id: unrelated.id,
    revision: unrelated.revision,
    state: 'proposed',
    next: 'awaiting_human',
    reason: 'Independent local submission',
  });
  await decideRecommendation(repository, undefined, {
    operationId: randomUUID(),
    id: unrelated.id,
    revision: unrelated.revision,
    decision: 'approve',
    rationale: 'Independent local scope.',
  });
  const fresh = objectiveObservation(repository, id);
  assert.ok(fresh !== null);
  const late = repository.recommendations.propose({
    ...proposal,
    observedObjectives: [fresh],
    affectedAssignments: [id],
  });
  repository.recommendations.transition({
    id: late.id,
    revision: late.revision,
    state: 'proposed',
    next: 'awaiting_human',
    reason: 'Native and local inspection',
  });
  const lateResult = await decideRecommendation(
    repository,
    async (number) => {
      repository.saveFeature({ ...feature, objective: 'Changed while native reads were in progress.' });
      return await readObservation(number);
    },
    {
      operationId: randomUUID(),
      id: late.id,
      revision: late.revision,
      decision: 'approve',
      rationale: 'This approval must not be recorded as the stale reason.',
    },
  );
  assert.equal(lateResult.outcome, 'stale');
  assert.match(repository.recommendations.get(late.id)?.audit.at(-1)?.reason ?? '', /Local objective scope/v);
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
