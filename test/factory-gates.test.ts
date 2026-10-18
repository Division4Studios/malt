/** @file Project default gates freeze on objectives and deliveries, and the operator changes them before they apply. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { decideApproval } from '../src/factory/approvals.ts';
import { changeGates } from '../src/factory/gate-controls.ts';
import { MERGE_GATE_STEP } from '../src/factory/gate-schema.ts';
import { queueObjective } from '../src/factory/objectives.ts';
import {
  awaitingApproval,
  featureWorkflow,
  isReviewComplete,
  planningApprovals,
  taskWorkflow,
} from '../src/factory/pipeline.ts';
import { deliveryTask } from '../src/factory/reconcile.ts';
import { FactoryRepository } from '../src/factory/repository.ts';
import { factoryConfigSchema, taskSchema } from '../src/factory/schema.ts';
import { builtinWorkflows, workflowDigest } from '../src/factory/workflows.ts';
import { MeshError } from '../src/protocol.ts';
import { Store } from '../src/store.ts';

import { createCleanup, createProject } from './helpers.ts';

import type { FactoryTask, Feature } from '../src/factory/schema.ts';
import type { TestContext } from 'node:test';

/** Issue numbers for fixture deliveries, unique within this file. */
const issues = { next: 10 };

/**
 * A configured project ledger with the given default gates.
 *
 * @param t - Owns cleanup.
 * @param defaultGates - Project defaults.
 * @returns Repository.
 */
function project(t: TestContext, defaultGates: Record<string, boolean> = {}): FactoryRepository {
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
      defaultGates,
    }),
  );
  repository.prepareSender();
  return repository;
}

/**
 * The stored objective.
 *
 * @param repository - Project ledger.
 * @param featureId - Identifier of the objective to load.
 * @returns The objective as stored, with its frozen gates.
 */
function objective(repository: FactoryRepository, featureId: string): Feature {
  const found = repository.features().find((feature) => feature.id === featureId);
  assert.ok(found !== undefined);
  return found;
}

/**
 * A reviewed quick-workflow delivery with an optional frozen merge gate.
 *
 * @param repository - Project ledger.
 * @param phase - Delivery phase.
 * @param isMergeGated - Frozen merge gate, or `undefined` for none.
 * @returns Stored delivery.
 */
function reviewed(repository: FactoryRepository, phase: FactoryTask['phase'], isMergeGated?: boolean): FactoryTask {
  issues.next += 1;
  const quick = builtinWorkflows().find((workflow) => workflow.id === 'quick');
  assert.ok(quick !== undefined);
  const review = quick.delivery.find((step) => step.kind === 'review');
  assert.ok(review !== undefined);
  const task = taskSchema.parse({
    id: randomUUID(),
    featureId: null,
    issue: issues.next,
    parentIssue: 1,
    key: `gated-${String(issues.next)}`,
    title: 'Gated change',
    description: 'Waits for a merge approval.',
    acceptanceCriteria: ['Works'],
    dependencies: [],
    phase,
    developer: 'developer-1',
    branch: null,
    worktree: null,
    head: 'h',
    base: 'b',
    pr: 3,
    prUrl: null,
    merge: null,
    reviews: [
      {
        role: review.roles[0] ?? 'qa-1',
        stepId: review.id,
        head: 'h',
        base: 'b',
        outcome: 'success',
        summary: 'ok',
        jobId: randomUUID(),
      },
    ],
    feedback: [],
    attempts: 1,
    version: 0,
    error: null,
    updatedAt: 1,
    workflow: { id: quick.id, revision: workflowDigest(quick), workflow: quick },
    ...(isMergeGated !== undefined && { gates: { merge: isMergeGated } }),
  });
  repository.addTask(task);
  return task;
}

await test('objectives freeze the project default gates unless the request overrides them', (t) => {
  const repository = project(t, { plan: true });
  const defaulted = queueObjective(repository, { objective: 'Uses the defaults' });
  assert.deepEqual(objective(repository, defaulted.featureId).gates, { plan: true, merge: false });
  const overridden = queueObjective(repository, { objective: 'Overrides', gates: { plan: false, merge: true } });
  assert.deepEqual(objective(repository, overridden.featureId).gates, { plan: false, merge: true });
  const gated = objective(repository, defaulted.featureId);
  const planStep = featureWorkflow(gated).planning.find((step) => step.kind === 'plan');
  assert.equal(planStep?.gate, true, 'the plan gate gates the plan step');
  assert.deepEqual(planningApprovals(gated, featureWorkflow(gated)), [], 'nothing to approve before a plan exists');
  const plan = {
    outcome: 'success',
    summary: 'Plan',
    findings: [],
    deliveries: [],
    skillActions: [],
    instructionReceipts: [],
  };
  const planned: Feature = { ...gated, plan: { ...plan, outcome: 'success' } };
  assert.deepEqual(
    planningApprovals(planned, featureWorkflow(planned)).map((step) => step.kind),
    ['plan'],
  );
  const plain = objective(repository, overridden.featureId);
  assert.equal(featureWorkflow(plain).planning.find((step) => step.kind === 'plan')?.gate, false);
});

await test('the merge gate adds one approval before the final check, bound to the exact head', (t) => {
  const repository = project(t);
  const ungated = reviewed(repository, 'review');
  assert.equal(isReviewComplete(ungated, taskWorkflow(ungated)), true);
  const task = reviewed(repository, 'review', true);
  const workflow = taskWorkflow(task);
  const final = workflow.delivery.find((step) => step.kind === 'final');
  assert.ok(final !== undefined);
  assert.ok(final.after.includes(MERGE_GATE_STEP));
  assert.equal(isReviewComplete(task, workflow), false);
  assert.deepEqual(
    awaitingApproval(task, workflow).map((step) => step.id),
    [MERGE_GATE_STEP],
  );
  assert.equal(taskWorkflow(task).delivery.filter((step) => step.id === MERGE_GATE_STEP).length, 1);
  const decision = { requestId: randomUUID(), taskId: task.id, stepId: MERGE_GATE_STEP, head: 'h', approve: true };
  assert.deepEqual(decideApproval(repository, decision), { result: 'approved' });
  assert.equal(repository.task(task.id).phase, 'merge_ready');
});

await test('the operator changes gates only before the work reaches them', (t) => {
  const repository = project(t);
  const { featureId } = queueObjective(repository, { objective: 'Change my gates' });
  const reject = (input: unknown, code: string): void => {
    assert.throws(
      () => changeGates(repository, input),
      (error: unknown) => error instanceof MeshError && error.code === code,
    );
  };
  reject({ plan: true }, 'INVALID_INPUT');
  reject({ featureId }, 'INVALID_INPUT');
  reject({ taskId: randomUUID(), featureId, merge: true }, 'INVALID_INPUT');
  reject({ taskId: randomUUID(), plan: true }, 'INVALID_INPUT');
  assert.deepEqual(changeGates(repository, { featureId, plan: true }), { gates: { plan: true, merge: false } });
  assert.deepEqual(objective(repository, featureId).gates, { plan: true, merge: false });
  const task = reviewed(repository, 'review');
  assert.deepEqual(changeGates(repository, { taskId: task.id, merge: true }), { gates: { merge: true } });
  assert.ok(taskWorkflow(repository.task(task.id)).delivery.some((step) => step.id === MERGE_GATE_STEP));
  const late = reviewed(repository, 'merge_ready');
  reject({ taskId: late.id, merge: true }, 'FACTORY_GATED');
  const feature = objective(repository, featureId);
  repository.saveFeature({
    ...feature,
    approvals: [{ stepId: 'plan', head: null, base: null, note: '', at: 1, requestId: randomUUID() }],
  });
  reject({ featureId, plan: false }, 'FACTORY_GATED');
  assert.deepEqual(changeGates(repository, { featureId, merge: true }), { gates: { plan: true, merge: true } });
});

await test('removing the merge gate of a fully reviewed delivery makes it merge ready', (t) => {
  const repository = project(t);
  const task = reviewed(repository, 'review', true);
  assert.equal(isReviewComplete(task, taskWorkflow(task)), false);
  assert.deepEqual(changeGates(repository, { taskId: task.id, merge: false }), { gates: { merge: false } });
  assert.equal(repository.task(task.id).phase, 'merge_ready');
  const held = reviewed(repository, 'review', false);
  changeGates(repository, { taskId: held.id, merge: true });
  assert.equal(repository.task(held.id).phase, 'review');
});

await test('a delivery freezes its merge gate so later objective changes affect only new deliveries', (t) => {
  const repository = project(t, { merge: true });
  const issue = { issue: 3, parentIssue: 1, title: 'Gate', description: 'Bounded.', acceptanceCriteria: ['Visible'] };
  assert.deepEqual(deliveryTask({ repository }, issue, null).gates, { merge: false });
  const now = repository.store.now();
  const legacy = { id: randomUUID(), objective: 'Legacy', phase: 'active', productPlan: null, plan: null } as const;
  repository.saveFeature({ ...legacy, parentIssue: 1, error: null, createdAt: now, updatedAt: now, approvals: [] });
  assert.deepEqual(deliveryTask({ repository }, issue, legacy.id).gates, { merge: false });
  const { featureId } = queueObjective(repository, { objective: 'Gated by default' });
  assert.deepEqual(deliveryTask({ repository }, issue, featureId).gates, { merge: true });
});
