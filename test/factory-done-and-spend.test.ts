/**
 * Objective definitions of done and progress logs, and USD spend caps: the
 * operator's checklist fences completion, agents propose or check items only
 * with evidence, the log pages newest first, and a reached cap stops new
 * attempts on its scope until it is raised.
 *
 * @file
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { isDefinitionMet, noteObjective, saveDefinition } from '../src/factory/objective-goals.ts';
import { logObjective, readObjectiveLog } from '../src/factory/objective-log.ts';
import { queueObjective } from '../src/factory/objectives.ts';
import { factoryConfigSchema } from '../src/factory/schema.ts';
import { FactoryService } from '../src/factory/service.ts';
import { ProjectGitHub } from '../src/github.ts';
import { ProjectLearning } from '../src/learning.ts';
import { Store } from '../src/store.ts';

import { createCleanup, createProject } from './helpers.ts';

import type { MeshConfig } from '../src/config.ts';
import type { FactoryRepository } from '../src/factory/repository.ts';
import type { Feature } from '../src/factory/schema.ts';
import type { TestContext } from 'node:test';

/** Fixed test clock. */
const NOW = Date.UTC(2026, 9, 1, 12);
/** Settings shared by every scenario. */
const SETTINGS = factoryConfigSchema.parse({
  testCommands: [{ file: process.execPath }],
  endToEndCommands: [{ file: process.execPath }],
});

/**
 * A configured project with a supervisor service.
 *
 * @param t - Owns cleanup.
 * @returns Project paths, store, service and repository.
 */
function project(t: TestContext): {
  mesh: MeshConfig;
  store: Store;
  factory: FactoryService;
  repository: FactoryRepository;
} {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  const store = new Store(mesh, { now: () => NOW });
  const factory = new FactoryService(
    mesh,
    store,
    { github: new ProjectGitHub(mesh), learning: new ProjectLearning(mesh) },
    { home: mesh.root },
  );
  defer(async () => {
    await factory.close();
    store.close();
  });
  const { repository } = factory;
  repository.configure(SETTINGS);
  repository.prepareSender();
  return { mesh, store, factory, repository };
}

/**
 * Read one objective.
 *
 * @param repository - Project ledger.
 * @param featureId - Objective to read.
 * @returns The stored objective.
 */
function objective(repository: FactoryRepository, featureId: string): Feature {
  const found = repository.features().find((candidate) => candidate.id === featureId);
  assert.ok(found !== undefined);
  return found;
}

await test('the definition of done fences completion and every change is logged', (t) => {
  const { repository } = project(t);
  const { featureId } = queueObjective(repository, { objective: 'Checkout redesign' });
  const feature = (): Feature => objective(repository, featureId);
  assert.equal(isDefinitionMet(feature()), true, 'An empty checklist is met.');
  const saved = saveDefinition(repository, {
    featureId,
    expectedUpdatedAt: feature().updatedAt,
    items: [
      { text: 'Mobile checkout passes the accessibility audit', state: 'open' },
      { text: 'Conversion dashboard updated', state: 'waived', evidence: 'Tracked separately' },
    ],
  });
  assert.deepEqual([saved.met, saved.total], [1, 2]);
  assert.equal(isDefinitionMet(feature()), false);
  assert.throws(
    () => saveDefinition(repository, { featureId, expectedUpdatedAt: feature().updatedAt - 1, items: [] }),
    { code: 'INVALID_REVISION' },
  );
  const [first, second] = feature().definitionOfDone ?? [];
  assert.ok(first !== undefined && second !== undefined);
  assert.equal(second.by, 'operator');
  saveDefinition(repository, {
    featureId,
    expectedUpdatedAt: feature().updatedAt,
    items: [
      { id: first.id, text: first.text, state: 'checked', evidence: 'Audit report #12' },
      { id: second.id, text: second.text, state: 'waived' },
    ],
  });
  assert.equal(isDefinitionMet(feature()), true);
  assert.equal(feature().definitionOfDone?.[1]?.evidence, 'Tracked separately', 'Unchanged items keep their evidence.');
  noteObjective(repository, { featureId, note: 'Design review moved to Friday.' });
  for (let index = 0; index < 5; index += 1) {
    logObjective(repository.store, featureId, {
      kind: 'check_in',
      actor: 'developer-1',
      body: `step ${String(index)}`,
    });
  }
  const page = readObjectiveLog(repository, { featureId, limit: 3 });
  assert.equal(page.total, 8);
  assert.deepEqual(
    page.entries.map((entry) => entry.body),
    ['step 4', 'step 3', 'step 2'],
  );
  assert.ok(page.next !== null);
  const older = readObjectiveLog(repository, { featureId, before: page.next, limit: 10 });
  assert.equal(older.next, null);
  assert.deepEqual(
    older.entries.map((entry) => entry.kind),
    ['check_in', 'check_in', 'note', 'criteria', 'criteria'],
  );
  assert.throws(() => noteObjective(repository, { featureId: randomUUID(), note: 'x' }), { code: 'NOT_FOUND' });
});
