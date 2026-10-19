/** @file Provider-typed work keys: parsing, display, ordering, branch names and the ledger's side-table reader. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { FactoryRepository } from '../src/factory/repository.ts';
import { taskSchema } from '../src/factory/schema.ts';
import {
  branchKey,
  compareTrackerKeys,
  formatTrackerKey,
  githubIssueNumber,
  githubKey,
  parseTrackerKey,
  taskTrackerKey,
} from '../src/factory/tracker-key.ts';
import { Store } from '../src/store.ts';

import { createCleanup, createProject } from './helpers.ts';

import type { TrackerKey } from '../src/factory/tracker-key.ts';

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
  const defer = createCleanup(t);
  const store = new Store(createProject(defer));
  defer(() => {
    store.close();
  });
  const repository = new FactoryRepository(store);
  const task = taskSchema.parse({
    id: randomUUID(),
    featureId: null,
    issue: 17,
    parentIssue: 1,
    key: 'issue-17',
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
  repository.addTask(task);
  assert.deepEqual(taskTrackerKey(store, task.id), { provider: 'github', key: '17' });
  assert.equal(taskTrackerKey(store, randomUUID()), null);
  assert.equal(repository.task(task.id).issue, 17, 'numeric readers are unchanged');
});
