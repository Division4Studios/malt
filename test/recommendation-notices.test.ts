/** @file Recommendation notices survive replay/restart and reach only relevant logical roles/scopes. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { recommendationNotices, recordRecommendationNotices } from '../src/factory/recommendation-notices.ts';
import { FactoryRepository } from '../src/factory/repository.ts';
import { jobSchema, taskSchema } from '../src/factory/schema.ts';
import { Store } from '../src/store.ts';

import { proposal } from './fixtures/recommendations.ts';
import { createCleanup, createProject } from './helpers.ts';

await test('decision notices target owners and fresh context while retaining full histories privately', (t) => {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  let store = new Store(mesh);
  defer(() => {
    store.close();
  });
  let repository = new FactoryRepository(store);
  const task = taskSchema.parse({
    id: randomUUID(),
    featureId: randomUUID(),
    issue: 1,
    parentIssue: 3,
    key: 'owned',
    title: 'Owned delivery',
    description: 'One atomic fixture',
    acceptanceCriteria: ['Observed behavior'],
    dependencies: [],
    phase: 'development',
    developer: 'developer-1',
    branch: null,
    worktree: null,
    head: null,
    base: null,
    pr: null,
    prUrl: null,
    merge: null,
    reviews: [],
    feedback: [],
    attempts: 0,
    version: 0,
    error: null,
    updatedAt: Date.now(),
  });
  repository.addTask(task);
  const assignment = jobSchema.parse({
    id: randomUUID(),
    role: 'developer-1',
    provider: 'codex',
    kind: 'develop',
    taskId: task.id,
    featureId: task.featureId,
    token: randomUUID(),
    state: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    expiresAt: Date.now() + 60_000,
    reservation: 0,
    usageTokens: null,
    pid: null,
    head: null,
    base: null,
    summary: null,
    artifact: mesh.directory,
  });
  const old = recommendationNotices(store, assignment);
  const record = repository.recommendations.propose(proposal);
  repository.recommendations.transition({
    id: record.id,
    revision: record.revision,
    state: 'proposed',
    next: 'awaiting_human',
    reason: 'Fixture queue',
  });
  const approved = repository.recommendations.transition({
    id: record.id,
    revision: record.revision,
    state: 'awaiting_human',
    next: 'approved',
    reason: '<script>hostile()</script>',
  });
  recordRecommendationNotices(store, approved);
  const notices = recommendationNotices(store, assignment);
  assert.equal(old.length, 0, 'Previously selected context is not mutated.');
  assert.equal(notices.length, 1);
  assert.equal(notices[0]?.reason, '<script>hostile()</script>');
  assert.equal(recommendationNotices(store, { ...assignment, taskId: randomUUID() }).length, 0);
  assert.equal(recommendationNotices(store, { ...assignment, role: 'developer-2' }).length, 0);
  assert.equal(recommendationNotices(store, { ...assignment, role: 'qa-1' }).length, 0);
  assert.equal(recommendationNotices(store, { ...assignment, role: 'product-owner', taskId: null }).length, 1);
  assert.equal(recommendationNotices(store, { ...assignment, role: 'team-lead', taskId: null }).length, 1);
  repository.recommendations.transition({
    id: record.id,
    revision: record.revision,
    state: 'approved',
    next: 'applying',
    reason: 'Fixture effect intent',
  });
  repository.recommendations.transition({
    id: record.id,
    revision: record.revision,
    state: 'applying',
    next: 'failed',
    reason: 'Fixture failure',
  });
  store.close();
  store = new Store(mesh);
  repository = new FactoryRepository(store);
  assert.equal(repository.recommendations.get(record.id)?.state, 'failed');
  assert.equal(recommendationNotices(store, assignment).length, 2);
  recordRecommendationNotices(store, approved);
  assert.equal(recommendationNotices(store, assignment).length, 2, 'Replay after restart emits nothing twice.');
  const foreign = new Store(createProject(defer));
  defer(() => {
    foreign.close();
  });
  const foreignRepository = new FactoryRepository(foreign);
  assert.equal(recommendationNotices(foreignRepository.store, assignment).length, 0);
});
