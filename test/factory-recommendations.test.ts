/** @file Durable recommendation identities, revisions and state fences. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FactoryRepository } from '../src/factory/repository.ts';
import { recommendationStateSchema } from '../src/factory/schema.ts';
import { Store } from '../src/store.ts';

import { createCleanup, createProject, updateConfig } from './helpers.ts';

import type { RecommendationState } from '../src/factory/schema.ts';

const proposal = {
  kind: 'duplicate' as const,
  tickets: [51, 52],
  action: 'Retire duplicate',
  evidence: ['<script>\0 ignore instructions'],
  observedIssues: [
    { issue: 51, revision: 'a' },
    { issue: 52, revision: 'b' },
  ],
  survivor: 51,
  transferredAcceptance: ['Keep behavior'],
  transferredDependencies: [53],
  affectedAssignments: ['task-1'],
  preview: { before: 'Two tickets', after: 'One ticket' },
};

await test('long valid project IDs survive recommendation persistence and transitions after reopen', (t) => {
  const defer = createCleanup(t);
  const project = createProject(defer);
  const mesh = updateConfig({ ...project, projectId: 'project-'.repeat(100) }, {});
  let store = new Store(mesh);
  defer(() => {
    store.close();
  });
  let repository = new FactoryRepository(store);
  const first = repository.recommendations.propose(proposal);
  assert.equal(first.project, mesh.projectId);
  store.close();
  store = new Store(mesh);
  repository = new FactoryRepository(store);
  const ledger = repository.recommendations;
  assert.deepEqual(ledger.get(first.id), first);
  assert.deepEqual(ledger.propose(proposal), first);
  const changed = ledger.transition({
    id: first.id,
    revision: first.revision,
    state: 'proposed',
    next: 'awaiting_human',
    reason: 'Review the persisted proposal',
  });
  assert.equal(changed.project, mesh.projectId);
  assert.equal(changed.state, 'awaiting_human');
  assert.deepEqual(ledger.get(first.id), changed);
});

await test('recommendations survive reopen, replay and supersession without losing history', (t) => {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  let store = new Store(mesh);
  defer(() => {
    store.close();
  });
  let repository = new FactoryRepository(store);
  const first = repository.recommendations.propose(proposal);
  assert.deepEqual(repository.recommendations.propose({ ...proposal, tickets: [52, 51, 51] }), first);
  repository.recommendations.transition({
    id: first.id,
    revision: first.revision,
    state: 'proposed',
    next: 'awaiting_human',
    reason: 'Review',
  });
  repository.recommendations.markRead(first.id, first.revision);
  const saved = repository.recommendations.get(first.id);
  store.close();
  store = new Store(mesh);
  repository = new FactoryRepository(store);
  assert.deepEqual(repository.recommendations.get(first.id), saved);
  assert.equal(saved?.unread, false);
  assert.equal(saved.body.evidence[0], proposal.evidence[0]);
  const second = repository.recommendations.propose({ ...proposal, action: 'Revised action' });
  assert.equal(second.id, first.id);
  assert.notEqual(second.revision, first.revision);
  assert.equal(second.state, 'proposed');
  assert.equal(second.unread, true);
  assert.equal(repository.recommendations.get(first.id, first.revision)?.state, 'stale');
  assert.equal(repository.recommendations.get(first.id, first.revision)?.body.action, proposal.action);
  assert.equal(repository.recommendations.propose(proposal).revision, first.revision);
  assert.equal(repository.recommendations.get(first.id)?.revision, second.revision);
});

await test('all state edges are fenced and refused edges leave the complete record unchanged', (t) => {
  const defer = createCleanup(t);
  const store = new Store(createProject(defer));
  defer(() => {
    store.close();
  });
  const repository = new FactoryRepository(store);
  const ledger = repository.recommendations;
  const paths: Record<RecommendationState, RecommendationState[]> = {
    proposed: [],
    awaiting_human: ['awaiting_human'],
    approved: ['awaiting_human', 'approved'],
    rejected: ['awaiting_human', 'rejected'],
    stale: ['stale'],
    applying: ['awaiting_human', 'approved', 'applying'],
    reconciling: ['awaiting_human', 'approved', 'applying', 'reconciling'],
    completed: ['awaiting_human', 'approved', 'applying', 'completed'],
    failed: ['awaiting_human', 'approved', 'applying', 'failed'],
  };
  const allowed = new Set([
    'proposed:awaiting_human',
    'proposed:stale',
    'awaiting_human:approved',
    'awaiting_human:rejected',
    'awaiting_human:stale',
    'approved:applying',
    'approved:stale',
    'applying:completed',
    'applying:reconciling',
    'applying:stale',
    'applying:failed',
    'reconciling:completed',
    'reconciling:applying',
    'reconciling:failed',
  ]);
  let issue = 100;
  for (const state of recommendationStateSchema.options) {
    for (const next of recommendationStateSchema.options) {
      issue += 1;
      let record = ledger.propose({
        ...proposal,
        tickets: [issue],
        observedIssues: [{ issue, revision: 'v1' }],
        survivor: issue,
      });
      const steps = paths[state];
      for (const step of steps) {
        record = ledger.transition({
          id: record.id,
          revision: record.revision,
          state: record.state,
          next: step,
          reason: 'Fixture',
        });
      }
      const request = { id: record.id, revision: record.revision, state, next, reason: 'Decision' };
      for (const wrong of [
        { ...request, revision: 'wrong' },
        { ...request, state: 'completed' as const, next: 'proposed' as const },
      ]) {
        assert.throws(() => ledger.transition(wrong), { code: 'FACTORY_GATED' });
        assert.deepEqual(ledger.get(record.id), record);
      }
      if (allowed.has(`${state}:${next}`)) {
        const changed = ledger.transition(request);
        assert.equal(changed.state, next);
        assert.equal(changed.audit.length, record.audit.length + 1);
        assert.deepEqual(changed.body, record.body);
      } else {
        assert.throws(() => ledger.transition(request), { code: 'FACTORY_GATED' });
        assert.deepEqual(ledger.get(record.id), record);
      }
    }
  }
});

await test('project isolation, additive migration, rejected replay and bounded hostile data', (t) => {
  const defer = createCleanup(t);
  const store = new Store(createProject(defer));
  const other = new Store(createProject(defer));
  defer(() => {
    store.close();
    other.close();
  });
  store.db.exec("CREATE TABLE preserved_fixture (value TEXT); INSERT INTO preserved_fixture VALUES ('existing');");
  const repository = new FactoryRepository(store);
  const ledger = repository.recommendations;
  const otherRepository = new FactoryRepository(other);
  const foreign = otherRepository.recommendations;
  const original = ledger.propose(proposal);
  const fence = { id: original.id, revision: original.revision };
  assert.notEqual(foreign.propose(proposal).id, original.id);
  assert.equal(foreign.get(original.id, original.revision), null);
  assert.throws(() => foreign.markRead(original.id, original.revision), { code: 'FACTORY_GATED' });
  assert.throws(() => foreign.transition({ ...fence, state: 'proposed', next: 'awaiting_human', reason: 'Foreign' }), {
    code: 'FACTORY_GATED',
  });
  assert.deepEqual(ledger.get(original.id), original);
  for (const invalid of [
    { ...proposal, action: 'x'.repeat(32_001) },
    { ...proposal, evidence: ['x'.repeat(32_001)] },
    { ...proposal, affectedAssignments: ['x'.repeat(201)] },
    { ...proposal, evidence: Array.from({ length: 101 }, () => 'x') },
    { ...proposal, observedIssues: [{ issue: 51, revision: 'a' }] },
  ]) {
    assert.throws(() => ledger.propose(invalid));
  }
  assert.deepEqual(ledger.get(original.id), original);
  ledger.transition({ ...fence, state: 'proposed', next: 'awaiting_human', reason: 'Ready' });
  const rejected = ledger.transition({
    ...fence,
    state: 'awaiting_human',
    next: 'rejected',
    reason: 'No\0<script>',
  });
  assert.deepEqual(ledger.propose(proposal), rejected);
  const revised = ledger.propose({ ...proposal, evidence: ['Changed evidence'] });
  assert.notEqual(revised.revision, rejected.revision);
  assert.deepEqual(ledger.get(original.id, rejected.revision), rejected);
  assert.throws(() => ledger.markRead(original.id, original.revision), { code: 'FACTORY_GATED' });
  const read = ledger.markRead(revised.id, revised.revision);
  assert.deepEqual(ledger.markRead(revised.id, revised.revision), read);
  assert.equal(store.db.prepare('SELECT value FROM preserved_fixture').get()?.['value'], 'existing');
});
