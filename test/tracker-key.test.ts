/** @file Provider-typed work keys: parsing, display, ordering, branch names, ledger records and the side-table migration. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { z } from 'zod/v3';

import { deliveryTask, parentFeature } from '../src/factory/delivery-task.ts';
import { enqueueDelivery } from '../src/factory/enqueue.ts';
import { FactoryRepository } from '../src/factory/repository.ts';
import { factoryConfigSchema, factorySchemas, taskSchema } from '../src/factory/schema.ts';
import { FactoryService } from '../src/factory/service.ts';
import {
  branchKey,
  compareTrackerKeys,
  formatTrackerKey,
  githubIssueNumber,
  githubKey,
  issueKey,
  issueLabel,
  parentLabel,
  parseTrackerKey,
  pullRequestTitle,
} from '../src/factory/tracker-key.ts';
import { taskTrackerKey } from '../src/factory/work-keys.ts';
import { commitMessage, mergeMessage } from '../src/factory/workspaces.ts';
import { ProjectGitHub } from '../src/github.ts';
import { ProjectLearning } from '../src/learning.ts';
import { Store } from '../src/store.ts';

import { fixture } from './delivery-fixture.ts';
import { createCleanup, createProject } from './helpers.ts';

import type { ReadyIssue } from '../src/factory/scheduler.ts';
import type { FactoryTask } from '../src/factory/schema.ts';
import type { TrackerKey } from '../src/factory/tracker-key.ts';

/**
 * A ready delivery as a GitHub ledger saves it, with no typed key.
 *
 * @param issue - GitHub issue number.
 * @returns Parsed task.
 */
function fixtureTask(issue: number): FactoryTask {
  return taskSchema.parse({
    id: randomUUID(),
    featureId: null,
    issue,
    parentIssue: 1,
    key: `issue-${String(issue)}`,
    title: 'Typed key fixture',
    description: 'Reads back typed.',
    acceptanceCriteria: ['Typed'],
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
    updatedAt: 1,
  });
}

/**
 * A project store closed when the test ends.
 *
 * @param t - Running test that owns the cleanup.
 * @returns A store on a fresh project.
 */
function openStore(t: Parameters<typeof createCleanup>[0]): Store {
  const defer = createCleanup(t);
  const store = new Store(createProject(defer));
  defer(() => {
    store.close();
  });
  return store;
}

await test('keys parse per tracker and never cross providers', () => {
  assert.deepEqual(parseTrackerKey('github', '#123'), { provider: 'github', key: '123' });
  assert.deepEqual(parseTrackerKey('github', ' 7 '), { provider: 'github', key: '7' });
  assert.deepEqual(parseTrackerKey('jira', 'PROJ-123'), { provider: 'jira', key: 'PROJ-123' });
  assert.equal(parseTrackerKey('github', 'PROJ-123'), null);
  assert.equal(parseTrackerKey('jira', '123'), null, 'a Jira key is never a bare number');
  assert.equal(parseTrackerKey('github', '0'), null);
  assert.equal(parseTrackerKey('linear', 'ABC-1'), null);
});

await test('keys display, map to GitHub numbers only for GitHub, and name branches the Jira panel links', () => {
  const github = githubKey(42);
  const jira = parseTrackerKey('jira', 'PROJ-9');
  assert.ok(jira !== null);
  assert.equal(formatTrackerKey(github), '#42');
  assert.equal(formatTrackerKey(jira), 'PROJ-9');
  assert.equal(githubIssueNumber(github), 42);
  assert.equal(githubIssueNumber(jira), null);
  assert.equal(branchKey(github), 'issue-42');
  assert.equal(branchKey(jira), 'PROJ-9', 'Jira keys keep their case so the development panel links the branch');
});

await test('a Jira delivery names its pull request by key, so the Jira development panel links it', () => {
  assert.equal(pullRequestTitle({ issue: 12, title: 'Export API' }), 'Export API');
  assert.equal(
    pullRequestTitle({ issue: 10_042, trackerKey: { provider: 'jira', key: 'PROJ-12' }, title: 'Export API' }),
    'PROJ-12 Export API',
  );
});

await test('keys sort by tracker, project and sequence number', () => {
  const keys: TrackerKey[] = [
    { provider: 'jira', key: 'PROJ-10' },
    { provider: 'github', key: '12' },
    { provider: 'jira', key: 'APP-3' },
    { provider: 'jira', key: 'PROJ-9' },
    { provider: 'github', key: '2' },
  ];
  assert.deepEqual(
    keys.toSorted(compareTrackerKeys).map((key) => formatTrackerKey(key)),
    ['#2', '#12', 'APP-3', 'PROJ-9', 'PROJ-10'],
  );
});

await test('existing GitHub deliveries read back as typed GitHub keys from the side table', (t) => {
  const store = openStore(t);
  const repository = new FactoryRepository(store);
  const task = fixtureTask(17);
  repository.addTask(task);
  assert.deepEqual(taskTrackerKey(store, task.id), { provider: 'github', key: '17' });
  assert.equal(taskTrackerKey(store, randomUUID()), null);
  assert.equal(repository.task(task.id).issue, 17, 'numeric readers are unchanged');
});

await test('a ledger written before typed keys migrates forward and reads back unchanged', (t) => {
  const store = openStore(t);
  const legacy = fixtureTask(23);
  // The tables and the number-only insert trigger exactly as the first typed-key release created them.
  store.db.exec(`
    CREATE TABLE factory_tasks (id TEXT PRIMARY KEY, issue INTEGER NOT NULL UNIQUE, phase TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE factory_effects (id TEXT PRIMARY KEY, issue INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE factory_task_keys (task_id TEXT PRIMARY KEY, tracker_provider TEXT NOT NULL, external_key TEXT NOT NULL);
    CREATE TRIGGER factory_task_key_insert AFTER INSERT ON factory_tasks BEGIN
      INSERT OR IGNORE INTO factory_task_keys VALUES(NEW.id,'github',CAST(NEW.issue AS TEXT));
    END;
  `);
  const data = JSON.stringify(legacy);
  store.db.prepare('INSERT INTO factory_tasks VALUES(?,?,?,?,?)').run(legacy.id, 23, 'ready', 0, data);
  const repository = new FactoryRepository(store);
  const loaded = repository.task(legacy.id);
  assert.deepEqual(loaded, legacy, 'the stored record parses unchanged');
  assert.equal(loaded.trackerKey, undefined, 'nothing is written into an old record');
  assert.deepEqual(issueKey(loaded), githubKey(23));
  assert.equal(issueLabel(loaded), '#23');
  assert.equal(parentLabel(loaded), '#1');
  assert.equal(loaded.key, 'issue-23');
  assert.deepEqual(taskTrackerKey(store, legacy.id), githubKey(23));
  const jira = { ...fixtureTask(24), trackerKey: { provider: 'jira', key: 'PROJ-7' } } satisfies FactoryTask;
  repository.addTask(jira);
  assert.deepEqual(taskTrackerKey(store, jira.id), jira.trackerKey, 'the replaced trigger keys Jira rows by their key');
  const stored = z
    .object({ data: z.string() })
    .parse(store.db.prepare('SELECT data FROM factory_tasks WHERE id=?').get(legacy.id));
  assert.equal(stored.data, data, 'the migration rewrites no record');
});

await test('typed keys survive the ledger, follow a renamed Jira key and name imported deliveries', (t) => {
  const store = openStore(t);
  const repository = new FactoryRepository(store);
  const ready = {
    issue: 10_042,
    parentIssue: 10_040,
    trackerKey: { provider: 'jira', key: 'PROJ-12' },
    parentKey: { provider: 'jira', key: 'PROJ-10' },
    title: 'Jira delivery',
    description: 'Keyed by Jira.',
    acceptanceCriteria: ['Keyed'],
  } as const;
  const feature = parentFeature(repository, ready);
  assert.equal(feature.objective, 'Existing feature PROJ-10');
  assert.deepEqual(feature.parentKey, ready.parentKey);
  assert.equal(parentFeature(repository, ready).id, feature.id, 'the parent is found again by its handle');
  const task = deliveryTask({ repository }, ready, feature.id);
  assert.equal(task.key, 'proj-12');
  repository.addTask(task);
  const loaded = repository.task(task.id);
  assert.equal(issueLabel(loaded), 'PROJ-12');
  assert.equal(parentLabel(loaded), 'PROJ-10');
  assert.equal(githubIssueNumber(issueKey(loaded)), null, 'a Jira handle is never read as a GitHub number');
  assert.deepEqual(taskTrackerKey(store, task.id), ready.trackerKey);
  repository.editTask(task.id, (current) => ({ ...current, trackerKey: { provider: 'jira', key: 'NEW-3' } }));
  assert.deepEqual(taskTrackerKey(store, task.id), { provider: 'jira', key: 'NEW-3' });
  const github = deliveryTask(
    { repository },
    { ...ready, trackerKey: undefined, parentKey: undefined, issue: 5 },
    null,
  );
  assert.equal(github.key, 'issue-5', 'GitHub delivery keys are unchanged');
  assert.equal('trackerKey' in github, false, 'GitHub deliveries carry no typed key');
});

await test('branch names and commit messages keep GitHub forms and carry the Jira key', async (t) => {
  const { task, workspaces } = await fixture(t);
  assert.equal(task.branch, `malt/issue-4-${task.id.slice(0, 8)}-0`, 'GitHub branch names are unchanged');
  const provenance = { step: 'implement', kind: 'develop', role: 'developer-1', jobId: randomUUID() };
  assert.deepEqual(commitMessage(task, null), ['-m', 'Deliver #4: Diagnosable change']);
  const jira = {
    ...task,
    id: randomUUID(),
    trackerKey: { provider: 'jira', key: 'PROJ-12' },
    parentKey: { provider: 'jira', key: 'PROJ-10' },
    branch: null,
    worktree: null,
  } satisfies FactoryTask;
  const [, subject, , trailers = ''] = commitMessage(jira, provenance);
  assert.equal(subject, 'Deliver PROJ-12: Diagnosable change');
  assert.match(trailers, /^X-MALT-Delivery: PROJ-12$/mv);
  assert.equal(mergeMessage(jira, provenance)[1], 'Refresh PROJ-12 onto main: Diagnosable change');
  const developer = await workspaces.developer(jira);
  assert.equal(developer.branch, `malt/PROJ-12-${jira.id.slice(0, 8)}-0`, 'the Jira development panel links the key');
});

await test('factory_enqueue names Ready issues by tracker key and never reads a Jira handle as a number', async (t) => {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  const store = new Store(mesh);
  defer(() => {
    store.close();
  });
  const factory = new FactoryService(
    mesh,
    store,
    { github: new ProjectGitHub(mesh), learning: new ProjectLearning(mesh) },
    { home: mesh.root },
  );
  defer(async () => factory.close());
  factory.repository.configure(
    factoryConfigSchema.parse({
      testCommands: [{ file: process.execPath }],
      endToEndCommands: [{ file: process.execPath }],
    }),
  );
  const context = factory.configured();
  const ready: ReadyIssue[] = [
    {
      issue: 10_042,
      parentIssue: 10_040,
      trackerKey: { provider: 'jira', key: 'PROJ-12' },
      parentKey: { provider: 'jira', key: 'PROJ-10' },
      title: 'Jira delivery',
      description: 'Keyed by Jira.',
      acceptanceCriteria: ['Keyed'],
    },
    { issue: 5, parentIssue: 1, title: 'GitHub delivery', description: 'Numbered.', acceptanceCriteria: ['Numbered'] },
  ];
  t.mock.method(context.remote, 'verify', async () => delay(0));
  t.mock.method(context.remote, 'readyIssues', async () => delay(0, ready));
  t.mock.method(context.workspaces, 'origin', async () => delay(0, 'https://github.com/example/app'));
  const scope = { title: 'Imported', description: 'Imported.', acceptanceCriteria: ['Imported'] };
  const jira = z
    .object({ taskId: z.string() })
    .parse(await enqueueDelivery(context, { ...scope, issue: 'PROJ-12', parentIssue: 'PROJ-10' }));
  assert.deepEqual(issueKey(factory.repository.task(jira.taskId)), { provider: 'jira', key: 'PROJ-12' });
  assert.deepEqual(
    await enqueueDelivery(context, { ...scope, issue: 'PROJ-12', parentIssue: 'PROJ-10' }),
    jira,
    'an imported key returns its delivery',
  );
  await assert.rejects(enqueueDelivery(context, { ...scope, issue: 10_042, parentIssue: 10_040 }), {
    code: 'INVALID_INPUT',
  });
  const github = z
    .object({ taskId: z.string() })
    .parse(await enqueueDelivery(context, { ...scope, issue: '#5', parentIssue: 1 }));
  assert.equal(issueLabel(factory.repository.task(github.taskId)), '#5');
  assert.deepEqual(await enqueueDelivery(context, { ...scope, issue: 5, parentIssue: 1 }), github);
  assert.throws(() => factorySchemas.factory_enqueue.parse({ ...scope, issue: 'proj-12', parentIssue: 1 }));
});
