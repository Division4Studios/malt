/**
 * Project tracking failures park delivery work before paid inference.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { FactoryRepository } from '../src/factory/repository.ts';
import { jobSchema, taskSchema } from '../src/factory/schema.ts';
import { ensureProjectTracking } from '../src/factory/tracking.ts';
import { Store } from '../src/store.ts';

import { createCleanup, createProject } from './helpers.ts';

await test('tracking failures preserve the ticket and retry idempotently without a stale queued status', async (t) => {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  const store = new Store(mesh);
  defer(() => {
    store.close();
  });
  const repository = new FactoryRepository(store);
  const task = taskSchema.parse({
    id: randomUUID(),
    featureId: null,
    issue: 12,
    parentIssue: 1,
    key: 'tracking',
    title: 'One focused behavior',
    description: 'Preserve delivery ownership.',
    acceptanceCriteria: ['Remote tracking precedes model execution.'],
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
    updatedAt: 1,
  });
  repository.addTask(task);
  const job = jobSchema.parse({
    id: randomUUID(),
    role: 'developer-1',
    provider: 'codex',
    kind: 'develop',
    taskId: task.id,
    featureId: null,
    head: null,
    base: null,
    token: randomUUID(),
    state: 'running',
    startedAt: 1,
    finishedAt: null,
    expiresAt: 1000,
    reservation: 0,
    usageTokens: null,
    pid: null,
    summary: null,
    artifact: mesh.directory,
  });
  const { signal } = new AbortController();
  const failed = await ensureProjectTracking({
    repository,
    job,
    signal,
    sync: async () => {
      await Promise.resolve();
      throw new Error('Project access unavailable');
    },
  });
  assert.match(failed ?? '', /no model turn started/v);
  assert.equal(repository.task(task.id).developer, 'developer-1');
  assert.ok(repository.effects().every((effect) => effect.id !== `project-tracking:${job.id}`));
  const calls: string[] = [];
  assert.equal(
    await ensureProjectTracking({
      repository,
      job,
      signal,
      sync: async (effect) => {
        await Promise.resolve();
        calls.push(`${effect.issue}:${effect.value}`);
      },
    }),
    null,
  );
  assert.deepEqual(calls, ['12:Development']);
  assert.equal(repository.effectCompleted(`project-tracking:${job.id}`), true);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    ensureProjectTracking({
      repository,
      job,
      signal: aborted.signal,
      sync: async () => {
        await Promise.resolve();
        assert.fail('Cancelled tracking must not mutate GitHub.');
      },
    }),
  );
});
