/** @file Unpaid intake replay, exact interrupted identities and isolated objective parking. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { z } from 'zod/v3';

import { readIntakeMetadata, saveIntakeMetadata } from '../src/factory/intake-corpus.ts';
import { queueObjective } from '../src/factory/objectives.ts';
import { retainProvisionedIssues } from '../src/factory/provisioning-identity.ts';
import { inspectObjective, isIntakeParked, reconcileIntake } from '../src/factory/recommendation-intake.ts';
import { deliveryTask } from '../src/factory/reconcile.ts';
import { GitHubDelivery } from '../src/factory/remote.ts';
import { jobIntents } from '../src/factory/scheduler.ts';
import { factoryConfigSchema, jobSchema } from '../src/factory/schema.ts';
import { FactoryService } from '../src/factory/service.ts';
import { ProjectGitHub } from '../src/github.ts';
import { ProjectLearning } from '../src/learning.ts';
import { Store } from '../src/store.ts';

import { readObservation } from './fixtures/recommendations.ts';
import { createCleanup, createProject } from './helpers.ts';

/** Bounded ledger inspection, not a copied recommendation state store. */
const cardSchema = z.object({ id: z.string(), revision: z.string(), state: z.string() });
/** Existing ledger page projection. */
const pageSchema = z.object({ items: z.array(cardSchema) });

await test('completed creation receipts exclude own tickets without admitting tasks or hiding foreign overlap', async (t) => {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  const store = new Store(mesh);
  const github = new ProjectGitHub(mesh);
  const remote = new GitHubDelivery(mesh, github);
  const observed = await readObservation(7);
  remote.issueRepositoryId = () => observed.repositoryId;
  const factory = new FactoryService(
    mesh,
    store,
    { github, learning: new ProjectLearning(mesh) },
    { home: mesh.root, remote },
  );
  defer(async () => {
    await factory.close();
    store.close();
  });
  factory.repository.configure(
    factoryConfigSchema.parse({
      testCommands: [{ file: process.execPath }],
      endToEndCommands: [{ file: process.execPath }],
    }),
  );
  const context = factory.configured();
  const behavior = 'Session cookie expires immediately after login redirect and users loop back to sign in page.';
  const queued = queueObjective(context.repository, { objective: behavior });
  const feature = context.repository.features().find((item) => item.id === queued.featureId);
  assert.ok(feature !== undefined);
  const corpus = {
    repositoryId: observed.repositoryId,
    items: [{ ...observed, body: behavior }],
    complete: true,
    cursor: null,
    checkedAt: Date.now(),
  };
  retainProvisionedIssues(context.repository, feature.id, observed.repositoryId, [
    { key: 'repair', issue: 7, parentIssue: 8 },
  ]);
  inspectObjective(context, feature, corpus, []);
  assert.equal(isIntakeParked(context, feature), false);
  assert.equal(pageSchema.parse(context.repository.recommendations.inspect({ kind: 'list' })).items.length, 0);
  assert.equal(context.repository.tasks().length, 0);
  remote.issueRepositoryId = () => 'R_foreign_repository';
  inspectObjective(context, feature, { ...corpus, repositoryId: 'R_foreign_repository' }, []);
  assert.equal(isIntakeParked(context, feature), true);
  assert.equal(pageSchema.parse(context.repository.recommendations.inspect({ kind: 'list' })).items.length, 1);
});

await test('intake queues once across restart, suppresses unchanged rejection and keeps unrelated work eligible', async (t) => {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  let store = new Store(mesh);
  const github = new ProjectGitHub(mesh);
  const learning = new ProjectLearning(mesh);
  const remote = new GitHubDelivery(mesh, github);
  const behavior = 'Session cookie expires immediately after login redirect and users loop back to sign in page.';
  const observed = { ...(await readObservation(7)), body: behavior };
  remote.issueRepositoryId = () => observed.repositoryId;
  const corpus = { items: [observed], complete: true, nextCursor: null, repositoryId: observed.repositoryId };
  let reads = 0;
  remote.issueCorpus = async () => {
    reads += 1;
    return await delay(0, corpus);
  };
  remote.unresolvedOperations = async () => delay(0, []);
  const createFactory = (): FactoryService =>
    new FactoryService(mesh, store, { github, learning }, { home: mesh.root, remote });
  const factory = createFactory();
  const liveFactories = new Set([factory]);
  defer(async () => {
    await Promise.all(liveFactories.values().map(async (owned) => owned.close()));
    store.close();
  });
  const settings = factoryConfigSchema.parse({
    testCommands: [{ file: process.execPath }],
    endToEndCommands: [{ file: process.execPath }],
  });
  factory.repository.configure(settings);
  factory.repository.setActive(true);
  const context = factory.configured();
  const affected = queueObjective(context.repository, { objective: behavior }).featureId;
  const independent = queueObjective(context.repository, {
    objective: 'Render accessible color swatches for theme selection.',
  }).featureId;
  const task = deliveryTask(
    context,
    {
      issue: 42,
      parentIssue: 43,
      title: 'Unrelated fix',
      description: 'Independent work',
      acceptanceCriteria: ['Observable check'],
    },
    null,
  );
  context.repository.addTask(task);
  const effects = context.repository.effects();
  const running = jobSchema.parse({
    id: randomUUID(),
    role: 'product-owner',
    provider: 'codex',
    kind: 'plan',
    taskId: null,
    featureId: affected,
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
  assert.equal(context.repository.claim(running, settings), true);
  await reconcileIntake(context);
  assert.equal(
    pageSchema.parse(context.repository.recommendations.inspect({ kind: 'list' })).items.length,
    0,
    'A frozen bounded planner finishes before the next stage can be parked.',
  );
  assert.equal(context.repository.finishJob(running, 0, 'interrupted'), true);
  await reconcileIntake(context);
  const page = pageSchema.parse(context.repository.recommendations.inspect({ kind: 'list' }));
  assert.equal(page.items.length, 1);
  const recommendation = page.items[0];
  assert.ok(recommendation !== undefined);
  const features = context.repository.features();
  const overlap = features.find((item) => item.id === affected);
  assert.ok(overlap !== undefined);
  assert.equal(isIntakeParked(context, overlap), true);
  const intents = jobIntents({
    config: settings,
    tasks: context.repository.tasks(),
    features: features.filter((item) => !isIntakeParked(context, item)),
    jobs: [],
    skillRequests: [],
    now: Date.now(),
  });
  assert.ok(intents.some((item) => item.kind === 'develop' && item.taskId === task.id));
  assert.ok(intents.some((item) => item.kind === 'plan' && item.featureId === independent));
  assert.ok(intents.every((item) => item.featureId !== affected));
  const readyFeature = features.find((item) => item.id === independent);
  assert.ok(readyFeature !== undefined);
  const checkpointKey = `pm_intake:${independent}`;
  const checkpoint = z.record(z.unknown()).parse(readIntakeMetadata(context.repository, checkpointKey));
  saveIntakeMetadata(context.repository, checkpointKey, { ...checkpoint, checkedAt: 0 });
  assert.equal(
    isIntakeParked(context, readyFeature),
    true,
    'An old negative inspection cannot authorize new planning indefinitely.',
  );
  await reconcileIntake(context);
  assert.equal(isIntakeParked(context, readyFeature), false);
  assert.deepEqual(context.repository.effects(), effects, 'Intake never edits, closes or relabels a native ticket.');
  assert.ok(context.repository.jobs().every((job) => job.state !== 'running'));
  await factory.close();
  liveFactories.delete(factory);
  store.close();
  store = new Store(mesh);
  const restartedFactory = createFactory();
  liveFactories.add(restartedFactory);
  const restored = restartedFactory.configured();
  await reconcileIntake(restored);
  assert.equal(reads, 1, 'Durable complete corpus is reused within its bounded observation window.');
  assert.equal(pageSchema.parse(restored.repository.recommendations.inspect({ kind: 'list' })).items.length, 1);
  restored.repository.recommendations.transition({
    ...recommendation,
    state: 'awaiting_human',
    next: 'rejected',
    reason: 'Keep the request separate.',
  });
  await reconcileIntake(restored);
  assert.equal(isIntakeParked(restored, overlap), false);
  assert.equal(restored.repository.recommendations.get(recommendation.id)?.state, 'rejected');
  inspectObjective(
    restored,
    overlap,
    { ...corpus, cursor: null, checkedAt: Date.now(), items: [{ ...observed, revision: 'b'.repeat(64) }] },
    [],
  );
  assert.equal(restored.repository.recommendations.get(recommendation.id)?.state, 'awaiting_human');
  assert.notEqual(restored.repository.recommendations.get(recommendation.id)?.revision, recommendation.revision);
  const current = restored.repository.recommendations.get(recommendation.id);
  assert.ok(current !== null);
  restored.repository.recommendations.transition({
    id: current.id,
    revision: current.revision,
    state: 'awaiting_human',
    next: 'rejected',
    reason: 'Fixture reset',
  });
  inspectObjective(restored, overlap, { ...corpus, cursor: null, checkedAt: Date.now() }, [
    { identity: `record-${affected}`, resolved: false },
  ]);
  assert.equal(
    isIntakeParked(restored, overlap),
    false,
    'An exact interrupted native operation resumes without a replacement recommendation.',
  );
  queueObjective(restored.repository, { objective: behavior });
  await reconcileIntake(restored);
  const parallel = pageSchema.parse(restored.repository.recommendations.inspect({ kind: 'list' }));
  await reconcileIntake(restored);
  assert.deepEqual(
    pageSchema.parse(restored.repository.recommendations.inspect({ kind: 'list' })),
    parallel,
    'Independent incoming origins cannot alternate superseding revisions.',
  );
  assert.equal(parallel.items.filter((item) => item.state === 'awaiting_human').length, 2);
});
