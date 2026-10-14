/**
 * Ticket checkpoints preserve ownership, retry identity and private credentials.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { factoryConfigSchema, jobSchema, taskSchema } from '../src/factory/schema.ts';
import { FactoryService } from '../src/factory/service.ts';
import { ProjectGitHub } from '../src/github.ts';
import { ProjectLearning } from '../src/learning.ts';
import { Store } from '../src/store.ts';

import { createCleanup, createProject, registration } from './helpers.ts';

await test('owned developer checkpoints deduplicate, fence stale claims and bound comment noise', async (t) => {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  const store = new Store(mesh);
  const factory = new FactoryService(
    mesh,
    store,
    {
      github: new ProjectGitHub(mesh),
      learning: new ProjectLearning(mesh),
    },
    { home: mesh.root },
  );
  defer(async () => {
    await factory.close();
    store.close();
  });
  const settings = factoryConfigSchema.parse({
    testCommands: [{ file: process.execPath }],
    endToEndCommands: [{ file: process.execPath }],
  });
  const { repository } = factory;
  repository.configure(settings);
  repository.prepareSender();
  repository.setActive(true);
  const task = taskSchema.parse({
    id: randomUUID(),
    featureId: null,
    issue: 2,
    parentIssue: 1,
    key: 'checkpoint',
    title: 'One verified improvement',
    description: 'A bounded delivery.',
    acceptanceCriteria: ['The behavior is observable.'],
    dependencies: [],
    phase: 'ready',
    developer: null,
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
  const actor = store.register({ ...registration('factory-developer-1'), runtime: 'factory-managed' });
  const job = jobSchema.parse({
    id: randomUUID(),
    role: 'developer-1',
    provider: 'codex',
    kind: 'develop',
    taskId: task.id,
    featureId: null,
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
  assert.equal(repository.claim(job, settings), true);
  const input = { key: 'reproduced', body: `Confirmed the boundary case. Synthetic secret: ${mesh.token}` };
  const first = await factory.execute('factory_progress', input, actor.id);
  assert.deepEqual(await factory.execute('factory_progress', input, actor.id), first);
  const comments = repository.effects().filter((effect) => effect.kind === 'comment');
  assert.equal(comments.length, 1);
  const comment = comments[0];
  assert.ok(comment !== undefined);
  assert.equal(comment.issue, task.issue);
  assert.ok(!comment.value.includes(mesh.token));
  assert.match(comment.value, /REDACTED/v);
  await assert.rejects(
    factory.execute('factory_progress', { ...input, body: 'Changed checkpoint content.' }, actor.id),
    { code: 'INVALID_INPUT' },
  );
  await assert.rejects(factory.execute('factory_progress', input), { code: 'FACTORY_GATED' });
  const outsider = store.register({ ...registration('factory-qa-1'), runtime: 'factory-managed' });
  await assert.rejects(factory.execute('factory_progress', input, outsider.id), { code: 'FACTORY_GATED' });
  for (let index = 1; index < 20; index += 1) {
    await factory.execute(
      'factory_progress',
      { key: `step-${String(index)}`, body: 'A meaningful fixture checkpoint.' },
      actor.id,
    );
  }
  await assert.rejects(factory.execute('factory_progress', { key: 'excess', body: 'Too many updates.' }, actor.id), {
    code: 'INVALID_INPUT',
  });
  assert.equal(repository.finishJob(job, 0, 'succeeded'), true);
  await assert.rejects(factory.execute('factory_progress', input, actor.id), { code: 'FACTORY_GATED' });
  assert.equal(repository.effects().filter((effect) => effect.kind === 'comment').length, 20);
});
