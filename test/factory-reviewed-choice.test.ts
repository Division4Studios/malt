/** @file Independently reviewed choices survive persistence and reach literal native arguments. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { nativeModelArguments } from '../src/factory/provider-selection.ts';
import { FactoryRepository } from '../src/factory/repository.ts';
import { routeAssignment } from '../src/factory/routing.ts';
import { validatePlan } from '../src/factory/scheduler.ts';
import { factoryConfigSchema, featureSchema, jobSchema, resultSchema, taskSchema } from '../src/factory/schema.ts';
import { Store } from '../src/store.ts';

import { policyIntent as baseIntent, policySettings } from './fixtures/model-policy.ts';
import { createCleanup, createProject } from './helpers.ts';

import type { FactoryConfig, FactoryTask } from '../src/factory/schema.ts';
/** Exact developer stage must use only its independently reviewed profile. */
const policyIntent = { ...baseIntent, role: 'developer-1', kind: 'develop' } as const;

/**
 * Construct a fully persisted delivery with a lead-approved stage choice.
 *
 * @param settings - Current explicit fixture policy.
 * @returns One bounded implementation scope.
 */
function taskFor(settings: FactoryConfig): FactoryTask {
  const policy = settings.modelPolicy;
  assert.ok(policy !== undefined);
  return taskSchema.parse({
    id: randomUUID(),
    featureId: null,
    issue: 2,
    parentIssue: 1,
    key: 'reviewed',
    title: 'Change one label',
    description: 'One observable label, independently testable.',
    acceptanceCriteria: ['The label is correct.'],
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
    updatedAt: 1000,
    assignmentProfiles: [
      {
        role: 'developer-1',
        tier: 'standard',
        effort: 'medium',
        reason: 'Lead inspected the implementation boundary.',
        modelChoice: { policyRevision: policy.revision, entryId: 'claude' },
      },
    ],
  });
}

await test('reviewed role choice survives SQLite restart and becomes exact native argv', (t) => {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  const store = new Store(mesh);
  defer(() => {
    if (store.db.isOpen) {
      store.close();
    }
  });
  const repository = new FactoryRepository(store);
  repository.configure(policySettings);
  const task = taskFor(policySettings);
  repository.addTask(task);
  const legacyProfile = { ...task.assignmentProfiles?.[0] };
  delete legacyProfile.modelChoice;
  const legacyTask = taskSchema.parse({
    ...task,
    id: randomUUID(),
    issue: 3,
    assignmentProfiles: [legacyProfile, legacyProfile],
  });
  repository.addTask(legacyTask);
  const legacyPlan = resultSchema.parse({
    outcome: 'success',
    summary: 'Previously accepted legacy duplicate roles.',
    findings: [],
    deliveries: [
      {
        key: 'old',
        title: 'Retained old plan',
        description: 'Do not break historical project reads.',
        acceptanceCriteria: ['History remains readable.'],
        dependencies: [],
        assignmentProfiles: [legacyProfile, legacyProfile],
      },
    ],
  });
  repository.saveFeature(
    featureSchema.parse({
      id: randomUUID(),
      objective: 'Historical legacy plan',
      phase: 'queued',
      productPlan: legacyPlan,
      plan: legacyPlan,
      parentIssue: null,
      error: null,
      createdAt: 1000,
      updatedAt: 1000,
    }),
  );
  assert.throws(
    () => {
      validatePlan(legacyPlan);
    },
    /unique role recommendations/v,
    'A new submission still rejects duplicates, even through the legacy shape.',
  );
  store.close();
  const reopened = new Store(mesh);
  defer(() => {
    reopened.close();
  });
  const restoredRepository = new FactoryRepository(reopened);
  const restored = restoredRepository.task(task.id);
  assert.deepEqual(restoredRepository.task(legacyTask.id).assignmentProfiles, legacyTask.assignmentProfiles);
  assert.equal(restoredRepository.features()[0]?.plan?.deliveries[0]?.assignmentProfiles?.length, 2);
  assert.deepEqual(restored.assignmentProfiles, task.assignmentProfiles);
  const routing = routeAssignment({
    intent: policyIntent,
    provider: 'claude',
    settings: policySettings,
    task: restored,
    versions: 'fixture',
  });
  assert.match(routing.reason, /independently reviewed exact choice/v);
  assert.equal(routing.effort, 'medium');
  const job = jobSchema.parse({
    id: randomUUID(),
    role: 'developer-1',
    provider: 'claude',
    kind: 'develop',
    taskId: task.id,
    featureId: null,
    token: randomUUID(),
    state: 'running',
    startedAt: 1000,
    finishedAt: null,
    expiresAt: 9000,
    reservation: 0,
    usageTokens: null,
    pid: null,
    head: null,
    base: null,
    summary: null,
    artifact: mesh.directory,
    routing,
  });
  assert.deepEqual(nativeModelArguments(job, policySettings), ['--model', 'fixture-claude', '--effort', 'medium']);
  const otherStage = routeAssignment({
    intent: { ...policyIntent, role: 'qa-1', kind: 'review' },
    provider: 'claude',
    settings: policySettings,
    task: restored,
    versions: 'fixture',
  });
  assert.match(otherStage.reason, /project default for this stage/v);
});

await test('changed policy, invalid choices and mandatory rework/final floors never silently downgrade', () => {
  const task = taskFor(policySettings);
  const route = (settings = policySettings, current = task): unknown =>
    routeAssignment({ intent: policyIntent, provider: 'claude', settings, task: current, versions: 'fixture' });
  const revised = factoryConfigSchema.parse({
    ...policySettings,
    modelPolicy: { ...policySettings.modelPolicy, revision: 2 },
  });
  assert.throws(() => route(revised), /older policy revision/v);
  const removed = taskSchema.parse({
    ...task,
    assignmentProfiles: [{ ...task.assignmentProfiles?.[0], modelChoice: { policyRevision: 1, entryId: 'removed' } }],
  });
  assert.throws(() => route(policySettings, removed), /reviewed model is missing/v);
  const complex = routeAssignment({
    intent: policyIntent,
    provider: 'claude',
    settings: policySettings,
    task: { ...task, feedback: ['Reproduce the prior defect.'] },
    versions: 'fixture',
  });
  assert.equal(complex.tier, 'advanced');
  assert.equal(complex.effort, 'high');
  const inadequate = taskSchema.parse({
    ...task,
    assignmentProfiles: [
      {
        role: 'final-tester',
        tier: 'small',
        effort: 'low',
        reason: 'Cannot lower integration floor.',
        modelChoice: { policyRevision: 1, entryId: 'codex' },
      },
    ],
  });
  assert.throws(() => {
    return routeAssignment({
      intent: { ...policyIntent, role: 'final-tester', kind: 'final' },
      provider: 'codex',
      settings: policySettings,
      task: inadequate,
      versions: 'fixture',
    });
  }, /capability floor/v);
  assert.equal(
    taskSchema.safeParse({ ...task, assignmentProfiles: [task.assignmentProfiles?.[0], task.assignmentProfiles?.[0]] })
      .success,
    false,
  );
  assert.equal(
    taskSchema.safeParse({
      ...task,
      assignmentProfiles: [{ ...task.assignmentProfiles?.[0], modelChoice: { policyRevision: -1, entryId: 'bad' } }],
    }).success,
    false,
  );
});
