/** @file Transactional recommendation decisions and durable inert intents. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { z } from 'zod/v3';

import { selectAll } from '../src/database.ts';
import { decideRecommendation } from '../src/factory/recommendation-decisions.ts';
import { FactoryRepository } from '../src/factory/repository.ts';
import { Store } from '../src/store.ts';

import { proposal, readObservation } from './fixtures/recommendations.ts';
import { createCleanup, createProject } from './helpers.ts';

import type { ObservedIssue } from '../src/github-issues.ts';

/** Durable inert intent row; no credential fields are projected. */
const intentSchema = z.object({ value: z.string() });

await test('exact decisions preserve stale content, refuse conflicts and recover one inert intent after restart', async (t) => {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  let store = new Store(mesh);
  defer(() => {
    store.close();
  });
  let repository = new FactoryRepository(store);
  const ledger = repository.recommendations;
  const record = ledger.propose(proposal);
  ledger.transition({
    id: record.id,
    revision: record.revision,
    state: 'proposed',
    next: 'awaiting_human',
    reason: 'Fixture submission',
  });
  const request = {
    operationId: randomUUID(),
    id: record.id,
    revision: record.revision,
    decision: 'approve',
    rationale: 'Preserve acceptance.',
  };
  const before = ledger.get(record.id);
  const old = await decideRecommendation(repository, undefined, { ...request, revision: '0'.repeat(64) });
  assert.equal(old.outcome, 'stale');
  assert.deepEqual(ledger.get(record.id), before);
  const accepted = await decideRecommendation(repository, readObservation, request);
  assert.equal(accepted.outcome, 'approved');
  await assert.rejects(decideRecommendation(repository, undefined, { ...request, decision: 'reject' }), {
    code: 'FACTORY_GATED',
  });
  store.close();
  store = new Store(mesh);
  repository = new FactoryRepository(store);
  assert.deepEqual(await decideRecommendation(repository, undefined, request), accepted);
  const intents = selectAll(
    store.db,
    z.object({ value: z.string() }),
    "SELECT value FROM metadata WHERE key GLOB 'factory_recommendation_intent:*'",
  );
  assert.equal(intents.length, 1);
  assert.equal(repository.effects().length, 0);
  const changed = repository.recommendations.propose({ ...proposal, kind: 'scope_change' });
  repository.recommendations.transition({
    id: changed.id,
    revision: changed.revision,
    state: 'proposed',
    next: 'awaiting_human',
    reason: 'Second fixture submission',
  });
  const stale = await decideRecommendation(
    repository,
    async (number) => ({ ...(await readObservation(number)), revision: 'b'.repeat(64) }),
    { ...request, operationId: randomUUID(), id: changed.id, revision: changed.revision },
  );
  assert.equal(stale.outcome, 'stale');
  assert.equal(repository.recommendations.get(changed.id)?.state, 'stale');
  assert.equal(repository.recommendations.get(record.id)?.state, 'approved');
});

await test('concurrent duplicate clicks share sequential inspection; rejection has no follow-up intent', async (t) => {
  const defer = createCleanup(t);
  const store = new Store(createProject(defer));
  defer(() => {
    store.close();
  });
  const repository = new FactoryRepository(store);
  const ledger = repository.recommendations;
  const record = ledger.propose(proposal);
  ledger.transition({
    id: record.id,
    revision: record.revision,
    state: 'proposed',
    next: 'awaiting_human',
    reason: 'Fixture submission',
  });
  let reads = 0;
  const reader = async (number: number): Promise<ObservedIssue> => {
    reads += 1;
    return await readObservation(number);
  };
  const request = {
    operationId: randomUUID(),
    id: record.id,
    revision: record.revision,
    decision: 'reject',
    rationale: 'Preserve separate tickets.',
  };
  const first = decideRecommendation(repository, reader, request);
  const repeated = decideRecommendation(repository, reader, request);
  await assert.rejects(
    decideRecommendation(repository, reader, { ...request, operationId: randomUUID(), decision: 'approve' }),
    { code: 'FACTORY_GATED' },
  );
  const results = await Promise.all([first, repeated]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(results[0].outcome, 'rejected');
  assert.equal(reads, 2, 'Only one inspection of each referenced issue runs.');
  assert.equal(ledger.get(record.id)?.audit.at(-1)?.reason, request.rationale);
  assert.equal(
    selectAll(store.db, intentSchema, "SELECT value FROM metadata WHERE key GLOB 'factory_recommendation_intent:*'")
      .length,
    0,
  );
  assert.equal(repository.effects().length, 0);
});
