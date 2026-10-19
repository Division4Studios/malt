/**
 * Workflow revision history: saved revisions and frozen copies, each with
 * the objectives and deliveries that run it.
 *
 * @file
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { queueObjective } from '../src/factory/objectives.ts';
import { FactoryRepository } from '../src/factory/repository.ts';
import { factoryConfigSchema } from '../src/factory/schema.ts';
import { workflowHistory } from '../src/factory/workflow-history.ts';
import { builtinWorkflows, workflowDigest, workflowLibrary } from '../src/factory/workflows.ts';
import { Store } from '../src/store.ts';

import { createCleanup, createProject } from './helpers.ts';

import type { Workflow } from '../src/factory/workflows.ts';
import type { TestContext } from 'node:test';

/**
 * A configured project ledger.
 *
 * @param t - Owns cleanup.
 * @returns Repository.
 */
function ledger(t: TestContext): FactoryRepository {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  const store = new Store(mesh);
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
  return repository;
}

/**
 * The built-in quick workflow.
 *
 * @returns Its definition.
 */
function quick(): Workflow {
  const found = builtinWorkflows().find((workflow) => workflow.id === 'quick');
  assert.ok(found !== undefined);
  return found;
}

await test('a project workflow lists every saved revision, current first, with the objectives that froze each', (t) => {
  const repository = ledger(t);
  const library = workflowLibrary(repository.store);
  const first = library.save({
    workflow: { ...quick(), id: 'team-quick', name: 'Team quick' },
    expectedRevision: null,
  });
  const { featureId: older } = queueObjective(repository, {
    objective: 'Old work\nmore detail',
    workflowId: 'team-quick',
  });
  const second = library.save({
    workflow: { ...quick(), id: 'team-quick', name: 'Team quick', description: 'Reviewed once.' },
    expectedRevision: first.revision,
  });
  const { featureId: newer } = queueObjective(repository, { objective: 'New work', workflowId: 'team-quick' });
  const history = workflowHistory(repository, { workflowId: 'team-quick' });
  assert.equal(history.source, 'project');
  assert.equal(history.current, second.revision);
  assert.deepEqual(
    history.revisions.map((revision) => [revision.revision, revision.isCurrent, revision.objectiveCount]),
    [
      [second.revision, true, 1],
      [first.revision, false, 1],
    ],
  );
  assert.deepEqual(
    history.revisions[0]?.objectives.map((objective) => objective.featureId),
    [newer],
  );
  const [, previous] = history.revisions;
  assert.ok(previous !== undefined);
  assert.deepEqual(previous.objectives, [{ featureId: older, title: 'Old work', phase: 'provisioning' }]);
  assert.equal(previous.workflow.description, quick().description);
  assert.ok((previous.createdAt ?? 0) > 0);
  assert.throws(() => workflowHistory(repository, { workflowId: 'Not a key' }));
});

await test('built-in history keeps revisions known only from frozen work', (t) => {
  const repository = ledger(t);
  const { featureId } = queueObjective(repository, { objective: 'Current', workflowId: 'quick' });
  const feature = repository.features().find((candidate) => candidate.id === featureId);
  assert.ok(feature?.workflow !== undefined);
  // An objective frozen by an older MALT release whose quick workflow differed.
  const shipped = { ...quick(), description: 'Older shipped wording.' };
  const { featureId: legacy } = queueObjective(repository, { objective: 'Legacy', workflowId: 'quick' });
  const stored = repository.features().find((candidate) => candidate.id === legacy);
  assert.ok(stored !== undefined);
  repository.saveFeature({
    ...stored,
    workflow: { id: 'quick', revision: workflowDigest(shipped), workflow: shipped },
  });
  const history = workflowHistory(repository, { workflowId: 'quick' });
  assert.equal(history.source, 'builtin');
  assert.equal(history.current, feature.workflow.revision);
  assert.deepEqual(
    history.revisions.map((revision) => [revision.isCurrent, revision.createdAt, revision.objectiveCount]),
    [
      [true, null, 1],
      [false, null, 1],
    ],
  );
  assert.equal(history.revisions[1]?.workflow.description, 'Older shipped wording.');
  const unknown = workflowHistory(repository, { workflowId: 'retired-workflow' });
  assert.deepEqual([unknown.source, unknown.current, unknown.revisions.length], ['frozen', null, 0]);
});
