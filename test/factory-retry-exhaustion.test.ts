/** @file A delivery out of retries is blocked, and the operator's retry resumes it with a fresh count. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { run } from '../src/database.ts';
import { queueObjective } from '../src/factory/objectives.ts';
import { deliveryTask } from '../src/factory/reconcile.ts';
import { retryBlocked } from '../src/factory/recovery.ts';
import { FactoryRepository } from '../src/factory/repository.ts';
import { blockExhausted } from '../src/factory/retry-exhaustion.ts';
import { factoryConfigSchema, jobSchema } from '../src/factory/schema.ts';
import { Store } from '../src/store.ts';

import { createCleanup, createProject } from './helpers.ts';

/** Reconcile interval used by the fixture. */
const RECONCILE_MS = 30_000;

await test('a step out of retries blocks its delivery until the operator retries it', (t) => {
  const defer = createCleanup(t);
  const store = new Store(createProject(defer));
  defer(() => {
    store.close();
  });
  const repository = new FactoryRepository(store);
  repository.configure(
    factoryConfigSchema.parse({
      testCommands: [{ file: process.execPath }],
      endToEndCommands: [{ file: process.execPath }],
    }),
  );
  const issue = { issue: 7, parentIssue: 1, title: 'Stalls', description: 'Bounded.', acceptanceCriteria: ['Visible'] };
  const task = { ...deliveryTask({ repository }, issue, null), phase: 'development' as const, head: 'h1' };
  repository.addTask(task);
  const stall = (finishedAt: number): void => {
    const job = jobSchema.parse({
      id: randomUUID(),
      role: 'developer-1',
      provider: 'claude',
      kind: 'develop',
      taskId: task.id,
      featureId: null,
      token: randomUUID(),
      state: 'interrupted',
      startedAt: finishedAt,
      finishedAt,
      expiresAt: 0,
      reservation: 0,
      usageTokens: null,
      pid: null,
      head: 'h1',
      base: null,
      summary: null,
      artifact: '',
      step: 'implement',
      failureClass: 'stalled',
    });
    run(store.db, 'INSERT INTO factory_jobs VALUES(?,?,?,?)', job.id, job.role, job.state, JSON.stringify(job));
  };
  stall(1);
  stall(2);
  blockExhausted(repository, RECONCILE_MS);
  assert.equal(repository.task(task.id).phase, 'development', 'retries remain');
  stall(3);
  blockExhausted(repository, RECONCILE_MS);
  const blocked = repository.task(task.id);
  assert.equal(blocked.phase, 'blocked');
  assert.match(blocked.error ?? '', /3 consecutive stalled failures/v);
  retryBlocked(repository, { taskId: task.id });
  blockExhausted(repository, RECONCILE_MS);
  assert.equal(repository.task(task.id).phase, 'development', 'the retry starts the count afresh');
});

await test('retrying a blocked objective restarts its planning retry count', (t) => {
  const defer = createCleanup(t);
  const store = new Store(createProject(defer));
  defer(() => {
    store.close();
  });
  const repository = new FactoryRepository(store);
  const { featureId } = queueObjective(repository, { objective: 'Plans again' });
  const feature = repository.features().find((candidate) => candidate.id === featureId);
  assert.ok(feature !== undefined);
  repository.saveFeature({ ...feature, phase: 'blocked', error: 'Fix the planner' });
  const retriedAt = store.now();
  retryBlocked(repository, { featureId });
  const retried = repository.features().find((candidate) => candidate.id === featureId);
  assert.equal(retried?.phase, 'queued');
  assert.ok((retried.retriesResetAt ?? 0) >= retriedAt, 'The retry restarts the planning retry count.');
});
