/**
 * Actual broker scope controls durably fence obsolete work and its dependents.
 * Completed delivery proof and merged verification survive replacement.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { z } from 'zod/v3';

import { startBroker } from '../src/broker.ts';
import { rpc } from '../src/client.ts';
import { queueObjective } from '../src/factory/objectives.ts';
import { FactoryRepository } from '../src/factory/repository.ts';
import { taskSchema } from '../src/factory/schema.ts';
import { Store } from '../src/store.ts';

import { createCleanup, createProject, updateConfig, brokerUrl } from './helpers.ts';

import type { FactoryTask } from '../src/factory/schema.ts';

/**
 * Create a valid independent delivery without invoking any native provider.
 *
 * @param issue - Fixture issue number.
 * @param featureId - Owning product objective.
 * @returns Durable task.
 */
function task(issue: number, featureId: string): FactoryTask {
  return taskSchema.parse({
    id: randomUUID(),
    featureId,
    issue,
    parentIssue: 1,
    key: `issue-${String(issue)}`,
    title: 'Scope fixture',
    description: 'Verify behavior',
    acceptanceCriteria: ['Observable check passes'],
    dependencies: [],
    phase: 'ready',
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
    finalReview: null,
    verifiedMain: null,
    attempts: 0,
    version: 0,
    error: null,
    updatedAt: 1,
  });
}

await test('project-wide replanning atomically freezes unfinished scopes but preserves completed and merged deliveries across restart', async (t) => {
  const defer = createCleanup(t);
  const config = createProject(defer);
  const seed = new Store(config);
  const repository = new FactoryRepository(seed);
  const { featureId } = queueObjective(repository, { objective: 'Original plan' });
  const original = { ...task(2, featureId), phase: 'development' as const };
  const dependent = { ...task(3, featureId), dependencies: [original.id] };
  const done = { ...task(4, featureId), phase: 'done' as const, merge: 'verified-merge' };
  const merged = { ...task(5, featureId), phase: 'verifying' as const, merge: 'pending-verification' };
  for (const delivery of [original, dependent, done, merged]) {
    repository.addTask(delivery);
  }
  seed.close();
  const broker = await startBroker(config, { port: 0 });
  let isClosed = false;
  defer(async () => {
    if (!isClosed) {
      await broker.close();
    }
  });
  const connected = updateConfig(config, { url: brokerUrl(broker.port) });
  const replacementSchema = z.object({ featureId: z.string(), taskIds: z.array(z.string()) });
  const responseSchema = z.object({ replacement: replacementSchema });
  const response = responseSchema.parse(
    await rpc(connected, 'factory_instruct', {
      role: 'product-owner',
      body: 'The behavior is wrong; refine acceptance.',
      replan: true,
    }),
  );
  assert.deepEqual(new Set(response.replacement.taskIds), new Set([original.id, dependent.id]));
  const snapshot = z.object({ tasks: z.array(taskSchema) }).parse(await rpc(connected, 'factory_status', {}));
  assert.equal(
    snapshot.tasks.find((entry) => entry.id === original.id)?.scopeReplacement,
    response.replacement.featureId,
  );
  assert.equal(snapshot.tasks.find((entry) => entry.id === dependent.id)?.phase, 'blocked');
  assert.deepEqual(
    snapshot.tasks.find((entry) => entry.id === done.id),
    done,
  );
  assert.deepEqual(
    snapshot.tasks.find((entry) => entry.id === merged.id),
    merged,
  );
  await assert.rejects(rpc(connected, 'factory_retry', { taskId: original.id }), { code: 'INVALID_INPUT' });
  await broker.close();
  isClosed = true;
  const restored = new Store(config);
  const resumed = new FactoryRepository(restored);
  assert.equal(resumed.task(original.id).scopeReplacement, response.replacement.featureId);
  assert.equal(resumed.features().find((entry) => entry.id === response.replacement.featureId)?.phase, 'queued');
  assert.equal(resumed.jobs().length, 0);
  restored.close();
});
