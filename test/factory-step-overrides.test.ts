/**
 * Per-objective and per-delivery step overrides: skipping optional steps,
 * changing seats, profiles and provider preference, and refusing overrides
 * that break workflow rules or change steps that already started.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import test from 'node:test';

import { consoleView } from '../src/factory/console-view.ts';
import { queueObjective } from '../src/factory/objectives.ts';
import { featureWorkflow, taskWorkflow } from '../src/factory/pipeline.ts';
import { deliveryTask } from '../src/factory/reconcile.ts';
import { FactoryRepository } from '../src/factory/repository.ts';
import { jobIntents } from '../src/factory/scheduler.ts';
import { factoryConfigSchema, jobSchema } from '../src/factory/schema.ts';
import { changeStepOverrides } from '../src/factory/step-override-controls.ts';
import { overrideProblems, withOverrides } from '../src/factory/step-overrides.ts';
import { builtinWorkflows, workflowLibrary } from '../src/factory/workflows.ts';
import { WorkspaceManager } from '../src/factory/workspaces.ts';
import { ProjectLearning } from '../src/learning.ts';
import { MeshError } from '../src/protocol.ts';
import { Store } from '../src/store.ts';

import { createCleanup, createProject } from './helpers.ts';

import type { FactoryContext } from '../src/factory/context.ts';
import type { FactoryTask, Feature } from '../src/factory/schema.ts';
import type { Workflow } from '../src/factory/workflows.ts';
import type { TestContext } from 'node:test';

/**
 * A built-in workflow by id.
 *
 * @param id - Built-in id.
 * @returns Its definition.
 */
function builtin(id: string): Workflow {
  const found = builtinWorkflows().find((workflow) => workflow.id === id);
  assert.ok(found !== undefined);
  return found;
}

/**
 * Fail if a test reaches a provider or GitHub.
 *
 * @returns Never; always rejects.
 */
async function reject(): Promise<never> {
  await Promise.resolve();
  throw new Error('Not used.');
}

/**
 * A project ledger with no side effects.
 *
 * @param t - Owns cleanup.
 * @returns Context.
 */
function fixture(t: TestContext): FactoryContext {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  const store = new Store(mesh);
  defer(() => {
    store.close();
  });
  const settings = factoryConfigSchema.parse({
    testCommands: [{ file: process.execPath }],
    endToEndCommands: [{ file: process.execPath }],
  });
  const repository = new FactoryRepository(store);
  repository.configure(settings);
  repository.prepareSender();
  return {
    mesh,
    home: mesh.root,
    settings,
    workspaces: new WorkspaceManager(mesh, settings),
    repository,
    learning: new ProjectLearning(mesh),
    processes: reject,
    agent: reject,
    remote: {
      verify: reject,
      provision: reject,
      readyIssues: reject,
      inspect: reject,
      merge: reject,
      effect: reject,
      issueState: reject,
      parentComplete: reject,
      pullRequest: reject,
    },
  };
}

/**
 * The stored objective.
 *
 * @param context - Project ledger holding it.
 * @param featureId - Identifier of the objective to load.
 * @returns Stored objective.
 */
function objective(context: FactoryContext, featureId: string): Feature {
  const found = context.repository.features().find((feature) => feature.id === featureId);
  assert.ok(found !== undefined);
  return found;
}

/**
 * Provision one delivery of an objective, as reconciliation would.
 *
 * @param context - Project ledger.
 * @param featureId - Owning objective.
 * @returns Stored delivery.
 */
function provision(context: FactoryContext, featureId: string): FactoryTask {
  const task = deliveryTask(
    context,
    { issue: 7, parentIssue: 1, title: 'Greeting', description: 'Show it.', acceptanceCriteria: ['Visible'] },
    featureId,
  );
  context.repository.addTask(task);
  return context.repository.task(task.id);
}

await test('skipping an optional step joins its dependents to what it waited for', () => {
  const workflow = builtin('full-assurance');
  const overridden = withOverrides(workflow, [{ stepId: 'document', skip: true }]);
  assert.equal(
    overridden.delivery.some((step) => step.id === 'document'),
    false,
  );
  const document = workflow.delivery.find((step) => step.id === 'document');
  assert.ok(document !== undefined);
  for (const step of workflow.delivery) {
    if (!step.after.includes('document')) {
      continue;
    }

    const expected: string[] = [
      ...new Set(step.after.flatMap((id): string | string[] => (id === 'document' ? document.after : id))),
    ];
    assert.deepEqual(overridden.delivery.find((candidate) => candidate.id === step.id)?.after, expected);
  }
  assert.deepEqual(overrideProblems(workflow, [{ stepId: 'document', skip: true }]), []);
});

await test('overrides that break workflow rules are refused with the reason', () => {
  const workflow = builtin('full-assurance');
  assert.match(overrideProblems(workflow, [{ stepId: 'review', skip: true }]).join(' '), /not optional/v);
  assert.match(overrideProblems(workflow, [{ stepId: 'missing', skip: true }]).join(' '), /no step "missing"/v);
  assert.match(
    overrideProblems(workflow, [{ stepId: 'review', roles: ['developer-1'] }]).join(' '),
    /cannot be performed by the implementer/v,
  );
  assert.match(
    overrideProblems(builtin('pull-request'), [{ stepId: 'approve-merge', roles: ['qa-1'] }]).join(' '),
    /human approval/v,
  );
  // A saved override that no longer fits runs the frozen workflow unchanged.
  assert.equal(withOverrides(workflow, [{ stepId: 'review', roles: ['developer-1'] }]), workflow);
});

await test('objective overrides change planning seats and provider, and freeze onto its deliveries', (t) => {
  const context = fixture(t);
  assert.throws(() => {
    return queueObjective(context.repository, {
      objective: 'Greet',
      workflowId: 'full-assurance',
      stepOverrides: [{ stepId: 'review', skip: true }],
    });
  }, /not optional/v);
  const { featureId } = queueObjective(context.repository, {
    objective: 'Greet visitors',
    workflowId: 'full-assurance',
    stepOverrides: [
      { stepId: 'plan-review', provider: 'claude' },
      { stepId: 'document', skip: true },
      { stepId: 'blind-review', provider: null },
    ],
  });
  const feature = objective(context, featureId);
  assert.equal(featureWorkflow(feature).planning.find((step) => step.id === 'plan-review')?.provider, 'claude');
  const task = provision(context, featureId);
  assert.deepEqual(task.stepOverrides, feature.stepOverrides);
  const delivery = taskWorkflow(task, [feature]);
  assert.equal(
    delivery.delivery.some((step) => step.id === 'document'),
    false,
  );
  assert.equal(delivery.delivery.find((step) => step.id === 'blind-review')?.provider, null);
});

await test('a delivery override changes the seat the scheduler offers and is fenced by version and started steps', (t) => {
  const context = fixture(t);
  const { featureId } = queueObjective(context.repository, { objective: 'Greet visitors', workflowId: 'quick' });
  const task = provision(context, featureId);
  assert.throws(
    () => {
      return changeStepOverrides(context.repository, {
        taskId: task.id,
        expectedVersion: task.version + 1,
        overrides: [{ stepId: 'review', roles: ['qa-2'] }],
      });
    },
    (error: unknown) => error instanceof MeshError && error.code === 'INVALID_REVISION',
  );
  const saved = changeStepOverrides(context.repository, {
    taskId: task.id,
    expectedVersion: task.version,
    overrides: [{ stepId: 'review', roles: ['qa-2'], provider: 'claude' }],
  });
  assert.deepEqual(saved.overrides, [{ stepId: 'review', roles: ['qa-2'], provider: 'claude' }]);
  const head = 'c'.repeat(40);
  const base = 'd'.repeat(40);
  const reviewing = context.repository.editTask(task.id, (current) => {
    return {
      ...current,
      phase: 'review',
      developer: 'developer-1',
      head,
      base,
      implementation: { head, base, at: 1 },
    };
  });
  const intents = jobIntents({
    config: context.settings,
    tasks: context.repository.tasks(),
    features: context.repository.features(),
    jobs: context.repository.jobs(),
    skillRequests: [],
    now: context.repository.store.now(),
  });
  const review = intents.find((intent) => intent.taskId === task.id && intent.step === 'review');
  assert.deepEqual([review?.role, review?.preferredProvider], ['qa-2', 'claude']);
  // Once an attempt ran the review, its settings are fixed.
  const job = jobSchema.parse({
    role: 'qa-2',
    kind: 'review',
    taskId: task.id,
    featureId,
    head,
    base,
    step: 'review',
    target: null,
    id: randomUUID(),
    provider: 'claude',
    token: randomUUID(),
    state: 'running',
    startedAt: 1,
    finishedAt: null,
    expiresAt: Number.MAX_SAFE_INTEGER,
    reservation: 0,
    usageTokens: null,
    pid: null,
    summary: null,
    artifact: path.join(context.mesh.directory, 'factory', 'jobs', randomUUID()),
  });
  assert.equal(context.repository.claim(job, context.settings), true);
  assert.throws(() => {
    return changeStepOverrides(context.repository, {
      taskId: task.id,
      expectedVersion: reviewing.version,
      overrides: [],
    });
  }, /already started and keep their settings: review/v);
  const card = consoleView(context.repository).deliveries.find((delivery) => delivery.taskId === task.id);
  const customization = card?.customization ?? null;
  assert.ok(customization !== null);
  assert.equal(customization.version, reviewing.version);
  assert.deepEqual(
    customization.steps.filter((step) => step.started).map((step) => step.id),
    ['implement', 'review'],
  );
});

await test('objective overrides change only planning steps that have not started', (t) => {
  const context = fixture(t);
  const library = workflowLibrary(context.repository.store);
  assert.equal(library.freeze('full-assurance').id, 'full-assurance');
  const { featureId } = queueObjective(context.repository, {
    objective: 'Greet visitors',
    workflowId: 'full-assurance',
  });
  const feature = objective(context, featureId);
  const changed = changeStepOverrides(context.repository, {
    featureId,
    expectedVersion: feature.updatedAt,
    overrides: [{ stepId: 'plan-review', provider: 'claude' }],
  });
  assert.equal(changed.overrides.length, 1);
  const updated = objective(context, featureId);
  context.repository.saveFeature({
    ...updated,
    planningResults: [
      {
        schemaVersion: 1,
        stepId: 'plan-review',
        kind: 'plan_review',
        role: 'plan-reviewer',
        jobId: randomUUID(),
        outcome: 'success',
        summary: 'Fine',
        findings: [],
        dispositions: [],
        at: 2,
      },
    ],
  });
  const reviewed = objective(context, featureId);
  assert.throws(() => {
    return changeStepOverrides(context.repository, {
      featureId,
      expectedVersion: reviewed.updatedAt,
      overrides: [],
    });
  }, /already started/v);
  assert.throws(() => {
    return changeStepOverrides(context.repository, {
      featureId,
      taskId: randomUUID(),
      expectedVersion: reviewed.updatedAt,
      overrides: [],
    });
  }, /exactly one delivery or one objective/v);
});
