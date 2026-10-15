/**
 * Additive work-key migration preserves the numeric factory contract.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { z } from 'zod/v3';

import { selectAll } from '../src/database.ts';
import { FactoryRepository } from '../src/factory/repository.ts';
import { taskSchema } from '../src/factory/schema.ts';
import { Store } from '../src/store.ts';

import { createCleanup, createProject } from './helpers.ts';

import type { FactoryTask } from '../src/factory/schema.ts';

/** Side-table work key row. */
const keySchema = z
  .object({
    task_id: z.string().optional(),
    effect_id: z.string().optional(),
    tracker_provider: z.string(),
    external_key: z.string(),
  })
  .strict();

/**
 * Build a valid legacy delivery.
 *
 * @param issue - Numeric GitHub issue.
 * @returns Existing public task shape.
 */
function task(issue: number): FactoryTask {
  return taskSchema.parse({
    id: randomUUID(),
    featureId: null,
    issue,
    parentIssue: 1,
    key: `issue-${String(issue)}`,
    title: 'Migration fixture',
    description: 'Preserve legacy state',
    acceptanceCriteria: ['State survives migration'],
    dependencies: [],
    phase: 'review',
    developer: 'developer-2',
    branch: null,
    worktree: null,
    head: null,
    base: null,
    pr: null,
    prUrl: null,
    merge: null,
    reviews: [],
    feedback: [],
    attempts: 1,
    version: 3,
    error: null,
    updatedAt: 1,
  });
}

await test('legacy issues 12–15 and pending effects survive migration and restart unchanged', (t) => {
  const defer = createCleanup(t);
  const config = createProject(defer);
  const store = new Store(config);
  defer(() => {
    if (store.db.isOpen) {
      store.close();
    }
  });
  store.db.exec(`
    CREATE TABLE factory_tasks (id TEXT PRIMARY KEY, issue INTEGER NOT NULL UNIQUE, phase TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE factory_effects (id TEXT PRIMARY KEY, issue INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL);
  `);
  const tasks = [12, 13, 14, 15].map((issue) => task(issue));
  const effects = tasks.map((value) => {
    return {
      id: `${value.id}:status:3`,
      issue: value.issue,
      kind: 'status',
      value: 'QA / Review',
      attempts: 2,
      retryAt: 500,
      error: 'Pending retry',
    };
  });
  for (const value of tasks) {
    store.db
      .prepare('INSERT INTO factory_tasks VALUES(?,?,?,?,?)')
      .run(value.id, value.issue, value.phase, value.version, JSON.stringify(value));
  }
  for (const value of effects) {
    store.db
      .prepare('INSERT INTO factory_effects VALUES(?,?,?,?)')
      .run(value.id, value.issue, value.kind, JSON.stringify(value));
  }
  const oldTasks = store.db.prepare('SELECT rowid, id, issue, phase, version, data FROM factory_tasks').all();
  const oldEffects = store.db.prepare('SELECT rowid, id, issue, kind, data FROM factory_effects').all();
  const repository = new FactoryRepository(store);
  assert.deepEqual(repository.tasks(), tasks);
  assert.deepEqual(repository.effects(), effects);
  assert.deepEqual(
    store.db.prepare('SELECT rowid, id, issue, phase, version, data FROM factory_tasks').all(),
    oldTasks,
  );
  assert.deepEqual(store.db.prepare('SELECT rowid, id, issue, kind, data FROM factory_effects').all(), oldEffects);
  assert.deepEqual(
    store.db
      .prepare(
        'SELECT k.tracker_provider, k.external_key FROM factory_tasks t JOIN factory_task_keys k ON k.task_id=t.id ORDER BY t.issue',
      )
      .all()
      .map((row) => ({ ...row })),
    [12, 13, 14, 15].map((issue) => ({ tracker_provider: 'github', external_key: String(issue) })),
  );
  assert.deepEqual(
    store.db
      .prepare(
        'SELECT k.tracker_provider, k.external_key FROM factory_effects e JOIN factory_effect_keys k ON k.effect_id=e.id ORDER BY e.issue',
      )
      .all()
      .map((row) => ({ ...row })),
    [12, 13, 14, 15].map((issue) => ({ tracker_provider: 'github', external_key: String(issue) })),
  );
  const expandedTasks = store.db.prepare('SELECT * FROM factory_task_keys').all();
  const expandedEffects = store.db.prepare('SELECT * FROM factory_effect_keys').all();
  store.close();
  const reopened = new Store(config);
  defer(() => {
    reopened.close();
  });
  const restarted = new FactoryRepository(reopened);
  assert.deepEqual(
    reopened.db.prepare('SELECT rowid, id, issue, phase, version, data FROM factory_tasks').all(),
    oldTasks,
  );
  assert.deepEqual(reopened.db.prepare('SELECT rowid, id, issue, kind, data FROM factory_effects').all(), oldEffects);
  assert.deepEqual(reopened.db.prepare('SELECT * FROM factory_task_keys').all(), expandedTasks);
  assert.deepEqual(reopened.db.prepare('SELECT * FROM factory_effect_keys').all(), expandedEffects);
  assert.deepEqual(restarted.tasks(), tasks);
  assert.deepEqual(restarted.effects(), effects);
});

await test('new tasks, transitions, effects and retries dual-write without changing numeric deduplication', (t) => {
  const defer = createCleanup(t);
  const store = new Store(createProject(defer));
  defer(() => {
    store.close();
  });
  const repository = new FactoryRepository(store);
  const original = task(12);
  repository.addTask(original);
  repository.addTask(task(12));
  assert.deepEqual(repository.tasks(), [original]);
  repository.editTask(original.id, (value) => ({ ...value, phase: 'blocked' }));
  const effect = {
    id: 'stable-comment',
    issue: 13,
    kind: 'comment' as const,
    value: 'Comment',
    attempts: 0,
    retryAt: 0,
    error: null,
  };
  repository.enqueueEffect(effect);
  repository.settleEffect(effect, 'Retry');
  assert.deepEqual(
    store.db
      .prepare(
        'SELECT t.issue, k.tracker_provider, k.external_key FROM factory_tasks t JOIN factory_task_keys k ON k.task_id=t.id',
      )
      .all()
      .map((row) => ({ ...row })),
    [{ issue: 12, tracker_provider: 'github', external_key: '12' }],
  );
  const storedEffects = selectAll(
    store.db,
    z.object({ issue: z.number(), tracker_provider: z.string(), external_key: z.string() }),
    'SELECT e.issue, k.tracker_provider, k.external_key FROM factory_effects e JOIN factory_effect_keys k ON k.effect_id=e.id',
  );
  assert.equal(storedEffects.length, repository.effects().length);
  for (const row of storedEffects) {
    assert.equal(row.tracker_provider, 'github');
    assert.equal(row.external_key, String(row.issue));
  }
  assert.equal(repository.effects().find((value) => value.id === effect.id)?.attempts, 1);
  repository.settleEffect(effect, null);
  repository.enqueueEffect(effect);
  assert.equal(
    repository.effects().some((value) => value.id === effect.id),
    false,
  );
  assert.equal(repository.effectCompleted(effect.id), true);
  assert.equal(
    selectAll(store.db, keySchema, 'SELECT * FROM factory_effect_keys WHERE effect_id=?', effect.id).length,
    0,
  );
});

await test('legacy positional writers keep working on an expanded database and receive typed keys', (t) => {
  const defer = createCleanup(t);
  const store = new Store(createProject(defer));
  defer(() => {
    store.close();
  });
  const repository = new FactoryRepository(store);
  const repeated = new FactoryRepository(store);
  assert.deepEqual(repeated.tasks(), []);
  const legacy = task(14);
  const effect = {
    id: 'legacy-status',
    issue: 14,
    kind: 'status',
    value: 'Done',
    attempts: 0,
    retryAt: 0,
    error: null,
  };
  // Exact statements used by released writers before the expand step.
  store.db
    .prepare('INSERT OR IGNORE INTO factory_tasks VALUES(?,?,?,?,?)')
    .run(legacy.id, legacy.issue, legacy.phase, legacy.version, JSON.stringify(legacy));
  store.db
    .prepare(
      'INSERT OR IGNORE INTO factory_effects SELECT ?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM factory_effect_receipts WHERE id=?)',
    )
    .run(effect.id, effect.issue, effect.kind, JSON.stringify(effect), effect.id);
  assert.deepEqual(repository.tasks(), [legacy]);
  assert.deepEqual(repository.effects(), [effect]);
  assert.deepEqual(selectAll(store.db, keySchema, 'SELECT * FROM factory_task_keys'), [
    { task_id: legacy.id, tracker_provider: 'github', external_key: '14' },
  ]);
  assert.deepEqual(selectAll(store.db, keySchema, 'SELECT * FROM factory_effect_keys'), [
    { effect_id: effect.id, tracker_provider: 'github', external_key: '14' },
  ]);
  store.db.prepare('DELETE FROM factory_effects WHERE id=?').run(effect.id);
  assert.deepEqual(selectAll(store.db, keySchema, 'SELECT * FROM factory_effect_keys'), []);
});
