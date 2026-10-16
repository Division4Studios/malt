/** @file Workflow interpreter: step satisfaction, gates, blind evidence, seats and scheduling. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import {
  awaitingApproval,
  dispositionProblems,
  isReviewComplete,
  isStepRunning,
  planningApprovals,
  planningStep,
  seatFor,
  startableSteps,
  stepEvidence,
  taskWorkflow,
  unsupportedSteps,
} from '../src/factory/pipeline.ts';
import { chooseProvider, jobIntents } from '../src/factory/scheduler.ts';
import { factoryConfigSchema, featureSchema, jobSchema, taskSchema } from '../src/factory/schema.ts';
import { builtinWorkflows, workflowDigest, workflowSchema } from '../src/factory/workflows.ts';

import type { Capacity, FactoryTask, Feature } from '../src/factory/schema.ts';
import type { Disposition, Workflow, WorkflowStep } from '../src/factory/workflows.ts';

const config = factoryConfigSchema.parse({
  testCommands: [{ file: process.execPath }],
  endToEndCommands: [{ file: process.execPath }],
});
const now = 100_000;

/**
 * A built-in workflow by id.
 *
 * @param id - Built-in identifier.
 * @returns Its validated definition.
 */
function builtin(id: string): Workflow {
  const found = builtinWorkflows().find((workflow) => workflow.id === id);
  assert.ok(found !== undefined, `missing built-in ${id}`);
  return found;
}

/**
 * One delivery step of the default pipeline by position.
 *
 * @param index - Zero-based position in the delivery section.
 * @returns The step at that position.
 */
function assuredStep(index: number): WorkflowStep {
  const step = builtin('malt-assured').delivery[index];
  assert.ok(step !== undefined);
  return step;
}

/**
 * A copy of the quick built-in with extra delivery steps inserted before the final check.
 *
 * @param extra - Steps to insert after the existing review; each runs after "review".
 * @param finalAfter - Steps the final check waits for.
 * @returns Validated workflow.
 */
function quickWith(extra: Partial<WorkflowStep>[], finalAfter: string[]): Workflow {
  const quick = builtin('quick');
  const [implement, review, final, verify] = quick.delivery;
  assert.ok(implement !== undefined && review !== undefined && final !== undefined && verify !== undefined);
  const added = extra.map((step) => ({ ...review, after: ['implement'], ...step }));
  return workflowSchema.parse({
    ...quick,
    id: 'custom',
    delivery: [implement, review, ...added, { ...final, after: finalAfter }, verify],
  });
}

/**
 * An objective that froze a workflow.
 *
 * @param workflow - Frozen definition.
 * @param overrides - Scenario state.
 * @returns Valid objective.
 */
function objective(workflow: Workflow, overrides: Partial<Feature> = {}): Feature {
  return featureSchema.parse({
    id: randomUUID(),
    objective: 'Fixture',
    phase: 'active',
    productPlan: null,
    plan: null,
    parentIssue: null,
    error: null,
    createdAt: 1,
    updatedAt: 1,
    workflow: { id: workflow.id, revision: workflowDigest(workflow), workflow },
    ...overrides,
  });
}

/**
 * A delivery under review at head "h" and base "b".
 *
 * @param feature - Owning objective.
 * @param overrides - Scenario state.
 * @returns Valid delivery.
 */
function delivery(feature: Feature, overrides: Partial<FactoryTask> = {}): FactoryTask {
  return taskSchema.parse({
    id: randomUUID(),
    featureId: feature.id,
    issue: 1,
    parentIssue: 2,
    key: 'fixture',
    title: 'Fixture',
    description: 'Fixture',
    acceptanceCriteria: [],
    dependencies: [],
    phase: 'review',
    developer: 'developer-1',
    branch: null,
    worktree: null,
    head: 'h',
    base: 'b',
    pr: 1,
    prUrl: null,
    merge: null,
    reviews: [],
    feedback: [],
    attempts: 0,
    version: 0,
    error: null,
    updatedAt: now,
    ...overrides,
  });
}

/**
 * A successful review of the current source.
 *
 * @param role - Reviewing seat.
 * @param stepId - Step it reports on; omit for a record saved before workflows.
 * @param head - Reviewed head.
 * @returns Review record.
 */
function approval(role: 'qa-1' | 'qa-2' | 'fixer', stepId?: string, head = 'h'): FactoryTask['reviews'][number] {
  return {
    role,
    head,
    base: 'b',
    outcome: 'success',
    summary: 'Approved',
    jobId: randomUUID(),
    ...(stepId !== undefined && { stepId }),
  };
}

await test('deliveries saved before workflows keep the original two-QA pipeline', () => {
  const assuredObjective = objective(builtin('malt-assured'));
  const legacy = delivery(featureSchema.parse({ ...assuredObjective, workflow: undefined }));
  const workflow = taskWorkflow(legacy, []);
  assert.equal(workflow.id, 'malt-assured');
  assert.equal(isReviewComplete({ ...legacy, reviews: [approval('qa-1')] }, workflow), false);
  assert.equal(isReviewComplete({ ...legacy, reviews: [approval('qa-1'), approval('qa-2')] }, workflow), true);
  assert.equal(
    isReviewComplete({ ...legacy, reviews: [approval('qa-1'), approval('qa-2', undefined, 'old')] }, workflow),
    false,
  );
});

await test('a single-review workflow is ready for merge after one exact-head approval', () => {
  const quick = builtin('quick');
  const feature = objective(quick);
  const task = delivery(feature);
  assert.deepEqual(
    startableSteps(task, quick).map((step) => step.id),
    ['review'],
  );
  const reviewed = { ...task, reviews: [approval('qa-1', 'review')] };
  assert.equal(isReviewComplete(reviewed, quick), true);
  assert.deepEqual(startableSteps(reviewed, quick), []);
});

await test('approval steps and gates wait for a human bound to the current head', () => {
  const workflow = quickWith(
    [{ id: 'sign-off', kind: 'approve', title: 'Sign off', roles: [], after: ['review'] }],
    ['sign-off'],
  );
  const feature = objective(workflow);
  const task = delivery(feature);
  assert.deepEqual(awaitingApproval(task, workflow), []);
  const reviewed = { ...task, reviews: [approval('qa-1', 'review')] };
  assert.deepEqual(
    awaitingApproval(reviewed, workflow).map((step) => step.id),
    ['sign-off'],
  );
  assert.equal(isReviewComplete(reviewed, workflow), false);
  const signed = {
    ...reviewed,
    approvals: [{ stepId: 'sign-off', head: 'h', base: 'b', note: '', at: now, requestId: randomUUID() }],
  };
  assert.equal(isReviewComplete(signed, workflow), true);
  assert.equal(isReviewComplete({ ...signed, head: 'newer' }, workflow), false);

  const gated = quickWith([], ['review']);
  const gate = gated.delivery.find((step) => step.id === 'review');
  assert.ok(gate !== undefined);
  gate.gate = true;
  const gatedTask = { ...delivery(objective(gated)), reviews: [approval('qa-1', 'review')] };
  assert.deepEqual(
    awaitingApproval(gatedTask, gated).map((step) => step.id),
    ['review'],
  );
  assert.equal(isReviewComplete(gatedTask, gated), false);
});

await test('later steps start only after their predecessors are satisfied', () => {
  const workflow = quickWith(
    [{ id: 'security', title: 'Security review', roles: ['qa-2'], after: ['review'], provider: 'claude' }],
    ['security'],
  );
  const task = delivery(objective(workflow));
  assert.deepEqual(
    startableSteps(task, workflow).map((step) => step.id),
    ['review'],
  );
  const reviewed = { ...task, reviews: [approval('qa-1', 'review')] };
  assert.deepEqual(
    startableSteps(reviewed, workflow).map((step) => step.id),
    ['security'],
  );
});

await test('blind reviews see no peer findings; others see only steps they may read', () => {
  const workflow = quickWith(
    [{ id: 'blind', title: 'Blind review', roles: ['qa-2'], blind: true }],
    ['review', 'blind'],
  );
  const task = delivery(objective(workflow), {
    reviews: [approval('qa-1', 'review'), approval('qa-2', 'blind')],
    feedback: ['Earlier defect'],
  });
  const blind = workflow.delivery.find((step) => step.id === 'blind');
  const review = workflow.delivery.find((step) => step.id === 'review');
  const final = workflow.delivery.find((step) => step.id === 'final');
  assert.ok(blind !== undefined && review !== undefined && final !== undefined);
  const blindView = stepEvidence(task, workflow, blind);
  assert.deepEqual(blindView.reviews, []);
  assert.deepEqual(blindView.feedback, []);
  assert.deepEqual(stepEvidence(task, workflow, review).reviews, []);
  assert.deepEqual(
    stepEvidence(task, workflow, final).reviews.map((entry) => entry.stepId),
    ['review', 'blind'],
  );
});

await test('seats are chosen deterministically and a running step is never duplicated', () => {
  const step = assuredStep(0);
  assert.equal(seatFor(step, []), 'developer-1');
  assert.equal(seatFor(step, [{ role: 'developer-1' }]), 'developer-2');
  assert.equal(seatFor(step, [{ role: 'developer-1' }, { role: 'developer-2' }]), null);
  const review = assuredStep(1);
  const taskId = randomUUID();
  assert.equal(isStepRunning(review, taskId, [{ role: 'qa-1', kind: 'review', taskId, step: review.id }]), true);
  assert.equal(isStepRunning(review, taskId, [{ role: 'qa-1', kind: 'review', taskId, step: null }]), true);
  assert.equal(isStepRunning(review, taskId, [{ role: 'qa-2', kind: 'review', taskId, step: 'other' }]), false);
});

await test('planning follows the workflow and holds deliveries for planning approvals', () => {
  const assured = builtin('malt-assured');
  const queued = objective(assured, { phase: 'queued' });
  assert.equal(planningStep(queued, assured)?.kind, 'plan');
  const refined = { ...queued, productPlan: queued.plan ?? null };
  const planResult = {
    outcome: 'success' as const,
    summary: 'Plan',
    findings: [],
    deliveries: [],
    skillActions: [],
    instructionReceipts: [],
  };
  assert.equal(planningStep({ ...refined, productPlan: planResult }, assured)?.kind, 'refine');
  assert.equal(planningStep({ ...refined, productPlan: planResult, plan: planResult }, assured), null);

  const approved = workflowSchema.parse({
    ...assured,
    id: 'approved-plans',
    planning: [
      ...assured.planning,
      { id: 'approve-plan', kind: 'approve', title: 'Approve plan', roles: [], after: ['plan'] },
    ],
  });
  const planned = objective(approved, { productPlan: planResult, plan: planResult });
  assert.deepEqual(
    planningApprovals(planned, approved).map((step) => step.id),
    ['approve-plan'],
  );
  const decided = {
    ...planned,
    approvals: [{ stepId: 'approve-plan', head: null, base: null, note: '', at: 1, requestId: randomUUID() }],
  };
  assert.deepEqual(planningApprovals(decided, approved), []);
});

await test('the scheduler follows each objective workflow and carries step and provider preference', () => {
  const workflow = quickWith(
    [{ id: 'security', title: 'Security review', roles: ['qa-2'], provider: 'claude' }],
    ['review', 'security'],
  );
  const feature = objective(workflow);
  const task = delivery(feature);
  const intents = jobIntents({ config, tasks: [task], features: [feature], jobs: [], skillRequests: [], now });
  assert.deepEqual(
    intents.map((intent) => [intent.role, intent.step, intent.preferredProvider]),
    [
      ['qa-1', 'review', null],
      ['qa-2', 'security', 'claude'],
    ],
  );
  const running = jobSchema.parse({
    id: randomUUID(),
    role: 'qa-1',
    provider: 'codex',
    kind: 'review',
    taskId: task.id,
    featureId: feature.id,
    token: randomUUID(),
    state: 'running',
    startedAt: now,
    finishedAt: null,
    expiresAt: now + 1,
    reservation: 0,
    usageTokens: null,
    pid: null,
    head: 'h',
    base: 'b',
    summary: null,
    artifact: 'fixture',
    step: 'review',
  });
  const busy = jobIntents({ config, tasks: [task], features: [feature], jobs: [running], skillRequests: [], now });
  assert.deepEqual(
    busy.map((intent) => intent.step),
    ['security'],
  );
});

await test('a preferred provider waits while busy and falls back only when disabled', () => {
  const capacity = (provider: 'codex' | 'claude'): Capacity => {
    return {
      provider,
      usedTokens: 0,
      reservedTokens: 0,
      resetAt: now + 1,
      cooldownUntil: 0,
      subscriptionUsedPercent: null,
      subscriptionResetAt: null,
      telemetrySource: null,
      updatedAt: now,
    };
  };
  const capacities = [capacity('codex'), capacity('claude')];
  const busyClaude = [{ id: 'one', provider: 'claude' as const, state: 'running' as const }];
  const single = factoryConfigSchema.parse({
    ...config,
    providers: { codex: { executable: 'codex', concurrency: 1 }, claude: { executable: 'claude', concurrency: 1 } },
  });
  assert.equal(chooseProvider({ config: single, capacities, jobs: [], now }, 'claude'), 'claude');
  assert.equal(chooseProvider({ config: single, capacities, jobs: busyClaude, now }, 'claude'), null);
  assert.equal(chooseProvider({ config: single, capacities, jobs: busyClaude, now }), 'codex');
  const disabled = factoryConfigSchema.parse({
    ...single,
    providers: { ...single.providers, claude: { executable: 'claude', enabled: false } },
  });
  assert.equal(chooseProvider({ config: disabled, capacities, jobs: [], now }, 'claude'), 'codex');
});

await test('only runnable workflows are offered until plan review steps are supported', () => {
  assert.deepEqual(unsupportedSteps(builtin('malt-assured')), []);
  assert.deepEqual(unsupportedSteps(builtin('direct')), []);
  assert.ok(unsupportedSteps(builtin('full-assurance')).length > 0);
});

/**
 * One fixer ruling.
 *
 * @param id - Finding id the ruling names.
 * @param decision - Adopted, rejected or merged.
 * @param evidence - Supporting evidence text.
 * @returns Disposition record.
 */
function ruling(id: string, decision: 'adopted' | 'rejected' | 'merged', evidence = 'proof'): Disposition {
  return { id, decision, reason: 'Because', evidence };
}

await test('a disposition ledger rules on every finding exactly once with evidence', () => {
  assert.deepEqual(dispositionProblems(['a-1', 'a-2'], [ruling('a-1', 'adopted'), ruling('a-2', 'rejected', '')]), []);
  assert.deepEqual(dispositionProblems(['a-1'], [ruling('a-1', 'merged', ' ')]), [
    'Disposition a-1 (merged) needs evidence.',
  ]);
  assert.deepEqual(dispositionProblems(['a-1', 'a-2'], [ruling('a-1', 'adopted'), ruling('a-1', 'rejected')]), [
    'Finding a-1 needs exactly one disposition; found 2.',
    'Finding a-2 needs exactly one disposition; found 0.',
  ]);
  assert.deepEqual(dispositionProblems([], [ruling('ghost', 'adopted')]), [
    'Disposition ghost names no current finding.',
  ]);
});
