/** @file Human workflow decisions, workflow choice on new objectives and brief deliveries. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { decideApproval } from '../src/factory/approvals.ts';
import { briefPlan } from '../src/factory/briefs.ts';
import { queueObjective } from '../src/factory/objectives.ts';
import { awaitingApproval, taskWorkflow } from '../src/factory/pipeline.ts';
import { FactoryRepository } from '../src/factory/repository.ts';
import { factoryConfigSchema, taskSchema } from '../src/factory/schema.ts';
import { builtinWorkflows, workflowDigest, workflowLibrary, workflowSchema } from '../src/factory/workflows.ts';
import { MeshError } from '../src/protocol.ts';
import { Store } from '../src/store.ts';

import { createCleanup, createProject } from './helpers.ts';

import type { FactoryTask } from '../src/factory/schema.ts';
import type { Workflow } from '../src/factory/workflows.ts';
import type { TestContext } from 'node:test';

/** A quick review followed by a human sign-off before the final check. */
const signOff: Workflow = (() => {
  const quick = builtinWorkflows().find((workflow) => workflow.id === 'quick');
  assert.ok(quick !== undefined);
  const [implement, review, final, verify] = quick.delivery;
  assert.ok(implement !== undefined && review !== undefined && final !== undefined && verify !== undefined);
  return workflowSchema.parse({
    ...quick,
    id: 'sign-off',
    delivery: [
      implement,
      review,
      { id: 'sign-off', kind: 'approve', title: 'Sign off', after: ['review'] },
      { ...final, after: ['sign-off'] },
      verify,
    ],
  });
})();

/**
 * A configured project ledger.
 *
 * @param t - Owns cleanup.
 * @returns Repository with settings saved.
 */
function project(t: TestContext): FactoryRepository {
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
  repository.prepareSender();
  return repository;
}

/**
 * Add a reviewed delivery that waits for the sign-off step.
 *
 * @param repository - Project ledger.
 * @returns The stored delivery.
 */
function waitingDelivery(repository: FactoryRepository): FactoryTask {
  const task = taskSchema.parse({
    id: randomUUID(),
    featureId: null,
    issue: 7,
    parentIssue: 1,
    key: 'signed',
    title: 'Signed change',
    description: 'Needs a human sign-off.',
    acceptanceCriteria: ['Works'],
    dependencies: [],
    phase: 'review',
    developer: 'developer-1',
    branch: null,
    worktree: null,
    head: 'h',
    base: 'b',
    pr: 3,
    prUrl: null,
    merge: null,
    reviews: [
      { role: 'qa-1', stepId: 'review', head: 'h', base: 'b', outcome: 'success', summary: 'ok', jobId: randomUUID() },
    ],
    feedback: [],
    attempts: 1,
    version: 0,
    error: null,
    updatedAt: 1,
    workflow: { id: signOff.id, revision: workflowDigest(signOff), workflow: signOff },
  });
  repository.addTask(task);
  return task;
}

await test('an approval binds the reviewed head and moves the delivery to merge readiness', (t) => {
  const repository = project(t);
  const task = waitingDelivery(repository);
  const requestId = randomUUID();
  assert.throws(
    () => decideApproval(repository, { requestId, taskId: task.id, stepId: 'sign-off', head: 'stale', approve: true }),
    (error: unknown) => error instanceof MeshError && error.code === 'INVALID_REVISION',
  );
  assert.throws(
    () => decideApproval(repository, { requestId, taskId: task.id, stepId: 'review', head: 'h', approve: true }),
    (error: unknown) => error instanceof MeshError && error.code === 'FACTORY_GATED',
  );
  const decision = { requestId, taskId: task.id, stepId: 'sign-off', head: 'h', approve: true, note: 'Looks right' };
  assert.deepEqual(decideApproval(repository, decision), { result: 'approved' });
  assert.deepEqual(decideApproval(repository, decision), { result: 'repeated' });
  const stored = repository.task(task.id);
  assert.equal(stored.phase, 'merge_ready');
  assert.deepEqual(
    stored.approvals.map((entry) => [entry.stepId, entry.head]),
    [['sign-off', 'h']],
  );
  // The same head re-reviewed on a new base: the earlier sign-off named the old base.
  const rebased = repository.editTask(task.id, (current) => {
    return {
      ...current,
      phase: 'review',
      base: 'b2',
      reviews: current.reviews.map((review) => ({ ...review, base: 'b2' })),
    };
  });
  assert.deepEqual(
    awaitingApproval(rebased, taskWorkflow(rebased, [])).map((step) => step.id),
    ['sign-off'],
    'an approval for the old base no longer counts',
  );
});

await test('a rejection needs a reason and returns the delivery to its developer', (t) => {
  const repository = project(t);
  const task = waitingDelivery(repository);
  assert.throws(
    () => {
      return decideApproval(repository, {
        requestId: randomUUID(),
        taskId: task.id,
        stepId: 'sign-off',
        head: 'h',
        approve: false,
      });
    },
    (error: unknown) => error instanceof MeshError && error.code === 'INVALID_INPUT',
  );
  const rejection = {
    requestId: randomUUID(),
    taskId: task.id,
    stepId: 'sign-off',
    head: 'h',
    approve: false,
    note: 'Rename the setting',
  };
  assert.deepEqual(decideApproval(repository, rejection), { result: 'rejected' });
  assert.deepEqual(decideApproval(repository, rejection), { result: 'repeated' }, 'a retried rejection reports itself');
  const stored = repository.task(task.id);
  assert.equal(stored.phase, 'development');
  assert.deepEqual(stored.reviews, []);
  assert.ok(stored.feedback.some((line) => line.includes('Rename the setting')));
});

await test('objectives freeze the chosen workflow; planning-free workflows provision the brief', (t) => {
  const repository = project(t);
  const brief = queueObjective(repository, {
    objective: '# Settings: dark mode\n\n## Acceptance\n- Toggle persists',
    workflowId: 'quick',
  });
  const quick = repository.features().find((feature) => feature.id === brief.featureId);
  assert.ok(quick !== undefined);
  assert.equal(quick.phase, 'provisioning');
  assert.equal(quick.workflow?.id, 'quick');
  assert.deepEqual(quick.plan?.deliveries[0]?.acceptanceCriteria, ['Toggle persists']);

  const planned = queueObjective(repository, { objective: 'A broader outcome' });
  const assured = repository.features().find((feature) => feature.id === planned.featureId);
  assert.ok(assured !== undefined);
  assert.equal(assured.phase, 'queued');
  assert.equal(assured.workflow?.id, 'malt-assured');

  assert.throws(
    () => queueObjective(repository, { objective: 'Unknown', workflowId: 'missing' }),
    (error: unknown) => error instanceof MeshError && error.code === 'NOT_FOUND',
  );

  workflowLibrary(repository.store).save({ workflow: { ...signOff, id: 'team-sign-off' }, expectedRevision: null });
  workflowLibrary(repository.store).setDefault({ workflowId: 'team-sign-off' });
  const defaulted = queueObjective(repository, { objective: 'Uses the project default' });
  const stored = repository.features().find((feature) => feature.id === defaulted.featureId);
  assert.ok(stored !== undefined);
  assert.equal(stored.workflow?.id, 'team-sign-off');
  const frozen = stored.workflow.revision;
  const library = workflowLibrary(repository.store);
  library.save({
    workflow: { ...signOff, id: 'team-sign-off', name: 'Renamed sign-off' },
    expectedRevision: frozen,
  });
  const kept = repository.features().find((feature) => feature.id === defaulted.featureId);
  assert.ok(kept !== undefined);
  const keptWorkflow = kept.workflow;
  assert.ok(keptWorkflow !== undefined);
  assert.equal(keptWorkflow.revision, frozen, 'a queued objective keeps the revision it froze');
  assert.equal(keptWorkflow.workflow.name, signOff.name);
  assert.deepEqual(
    queueObjective(repository, { objective: 'Uses the project default', requestId: defaulted.featureId }),
    {
      featureId: defaulted.featureId,
    },
  );
});

await test('briefs become one delivery with acceptance from the Acceptance section', () => {
  const plan = briefPlan(
    '# Billing: retry failed charges\n\n## Goal\nRetry once.\n\n## Acceptance\n1. A failed charge retries after an hour\n- [x] The retry is logged\n\n## Out of scope\n- Refunds',
  );
  const [only] = plan.deliveries;
  assert.ok(only !== undefined);
  assert.equal(plan.deliveries.length, 1);
  assert.equal(only.title, 'Billing: retry failed charges');
  assert.deepEqual(only.acceptanceCriteria, ['A failed charge retries after an hour', 'The retry is logged']);
  assert.equal(briefPlan('fix the typo').deliveries[0]?.acceptanceCriteria.length, 1);
});
