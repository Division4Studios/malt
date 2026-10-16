/**
 * Pure workflow interpreter: given a delivery and the workflow its objective
 * froze, decide which steps are satisfied, which may start, which wait for a
 * human, and which seat performs each step. The scheduler, completion and
 * console projections all ask this module instead of hard-coding roles.
 *
 * A step result counts only for the exact head and base it judged. Any new
 * source invalidates it automatically, so approvals can never outlive the code
 * they approved.
 *
 * @file
 */

import { DEFAULT_WORKFLOW_ID, ancestorIds, builtinWorkflows } from './workflows.ts';

import type { FactoryJob, FactoryRole, FactoryTask, Feature } from './schema.ts';
import type { StepKind, Workflow, WorkflowStep } from './workflows.ts';

/** Step kinds the supervisor can run today. */
const RUNNABLE_KINDS: ReadonlySet<StepKind> = new Set([
  'specify',
  'plan',
  'implement',
  'review',
  'approve',
  'final',
  'verify',
]);
/** Steps with dedicated delivery phases rather than results recorded during review. */
const SPINE_KINDS: ReadonlySet<StepKind> = new Set(['implement', 'final', 'verify']);

/**
 * The pipeline MALT ran before workflows existed; objectives saved earlier keep it.
 *
 * @returns The built-in default definition.
 * @throws {Error} When the source tree lacks its default workflow.
 */
export function legacyWorkflow(): Workflow {
  const found = builtinWorkflows().find((workflow) => workflow.id === DEFAULT_WORKFLOW_ID);
  if (found === undefined) {
    throw new Error('The built-in default workflow is missing from resources/workflows.');
  }
  return found;
}

/**
 * Explain why a workflow cannot run yet, so it is refused before any work starts.
 *
 * @param workflow - Candidate workflow.
 * @returns Unsupported step titles; empty when runnable.
 */
export function unsupportedSteps(workflow: Workflow): string[] {
  return [...workflow.planning, ...workflow.delivery]
    .filter((step) => !RUNNABLE_KINDS.has(step.kind))
    .map((step) => `${step.title} (${step.kind})`);
}

/**
 * The workflow an objective runs.
 *
 * @param feature - Objective, possibly saved before workflows existed.
 * @returns Its frozen workflow, or the legacy pipeline.
 */
export function featureWorkflow(feature: Feature | null | undefined): Workflow {
  return feature?.workflow?.workflow ?? legacyWorkflow();
}

/**
 * The workflow one delivery runs: its own frozen copy, else its objective's.
 *
 * @param task - Delivery.
 * @param features - Known objectives, consulted for deliveries without a frozen copy.
 * @returns Frozen workflow, or the legacy pipeline for deliveries saved before workflows.
 */
export function taskWorkflow(task: FactoryTask, features: readonly Feature[] = []): Workflow {
  return task.workflow?.workflow ?? featureWorkflow(features.find((feature) => feature.id === task.featureId));
}

/**
 * The single step of a required spine kind. Validation guarantees it exists.
 *
 * @param workflow - Validated workflow.
 * @param kind - Implement, final or verify.
 * @returns That step.
 * @throws {Error} For a definition that bypassed validation.
 */
export function spineStep(workflow: Workflow, kind: 'implement' | 'final' | 'verify'): WorkflowStep {
  const step = workflow.delivery.find((candidate) => candidate.kind === kind);
  if (step === undefined) {
    throw new Error(`Workflow ${workflow.id} has no ${kind} step.`);
  }
  return step;
}

/**
 * Whether a delivery has reached a stage where its implementation exists for review.
 *
 * @param task - Delivery.
 * @returns True once its published head is under review or later.
 */
function isImplemented(task: FactoryTask): boolean {
  // Publication sets the head before the review phase, so the phase alone is authoritative.
  return ['review', 'merge_ready', 'merging', 'verifying', 'closing', 'done'].includes(task.phase);
}

/**
 * The recorded human approval for one step at the delivery's current source.
 *
 * @param task - Delivery.
 * @param step - Gated or approval step.
 * @returns Whether an approval binds the current head and base.
 */
function isApproved(task: FactoryTask, step: WorkflowStep): boolean {
  return task.approvals.some(
    (approval) => approval.stepId === step.id && approval.head === task.head && approval.base === task.base,
  );
}

/**
 * Whether a review result belongs to a step. Results saved before workflows
 * existed carry no step id and are matched by seat.
 *
 * @param review - A review result recorded on the delivery.
 * @param step - The workflow review step being evaluated.
 * @returns True when the result reports on this step.
 */
export function isReviewOf(review: FactoryTask['reviews'][number], step: WorkflowStep): boolean {
  return review.stepId === undefined ? step.roles.includes(review.role) : review.stepId === step.id;
}

/**
 * Whether one review step approved the exact current source.
 *
 * @param task - Delivery.
 * @param step - Review step.
 * @returns True for a successful review of the current head and base.
 */
function isReviewed(task: FactoryTask, step: WorkflowStep): boolean {
  return task.reviews.some((review) => {
    return (
      isReviewOf(review, step) && review.outcome === 'success' && review.head === task.head && review.base === task.base
    );
  });
}

/**
 * Whether a delivery step's work is done for the current source, ignoring its gate.
 *
 * @param task - Delivery.
 * @param step - Any delivery step.
 * @returns True when its result binds the current head and base.
 */
function hasResult(task: FactoryTask, step: WorkflowStep): boolean {
  switch (step.kind) {
    case 'implement': {
      return isImplemented(task);
    }
    case 'review': {
      return isReviewed(task, step);
    }
    case 'approve': {
      return isApproved(task, step);
    }
    case 'final': {
      return task.finalReview !== null && task.finalReview.head === task.head && task.finalReview.base === task.base;
    }
    case 'verify': {
      return task.verifiedMain !== null;
    }
    case 'adjudicate':
    case 'document':
    case 'regress':
    case 'specify':
    case 'plan':
    case 'plan_review':
    case 'plan_revise': {
      // Planning kinds never appear in delivery sections; fix-stage kinds are refused before they run.
      return false;
    }
  }
}

/**
 * Whether a step is complete, including any human approval its gate requires.
 *
 * @param task - Delivery.
 * @param step - Delivery step.
 * @returns True when downstream steps may rely on it.
 */
export function isStepSatisfied(task: FactoryTask, step: WorkflowStep): boolean {
  return hasResult(task, step) && (!step.gate || isApproved(task, step));
}

/**
 * Whether every predecessor of a step is complete.
 *
 * @param task - Delivery.
 * @param workflow - Its workflow.
 * @param step - Step to test.
 * @returns True when the step may start.
 */
function isUnblocked(task: FactoryTask, workflow: Workflow, step: WorkflowStep): boolean {
  return step.after.every((id) => {
    const before = workflow.delivery.find((candidate) => candidate.id === id);
    return before !== undefined && isStepSatisfied(task, before);
  });
}

/**
 * Review-stage steps that may start now: reviews and other model steps whose
 * predecessors are complete and whose own result is missing.
 *
 * @param task - Delivery in review.
 * @param workflow - Its workflow.
 * @returns Startable model steps, in workflow order.
 */
export function startableSteps(task: FactoryTask, workflow: Workflow): WorkflowStep[] {
  return workflow.delivery.filter((step) => {
    return (
      !SPINE_KINDS.has(step.kind) &&
      step.kind !== 'approve' &&
      !hasResult(task, step) &&
      isUnblocked(task, workflow, step)
    );
  });
}

/**
 * Steps currently waiting for a human: approval steps that may start, and gated
 * steps whose work is done but not yet approved.
 *
 * @param task - Delivery.
 * @param workflow - Its workflow.
 * @returns Steps the operator can approve or reject now.
 */
export function awaitingApproval(task: FactoryTask, workflow: Workflow): WorkflowStep[] {
  return task.phase === 'blocked' || task.phase === 'done' || task.head === null
    ? []
    : workflow.delivery.filter((step) => {
        return step.kind === 'approve'
          ? task.phase === 'review' && !isApproved(task, step) && isUnblocked(task, workflow, step)
          : step.gate && hasResult(task, step) && !isApproved(task, step) && step.kind !== 'verify';
      });
}

/**
 * Whether every step before the final check is complete for the current source.
 *
 * @param task - Delivery.
 * @param workflow - Its workflow.
 * @returns True when the delivery may move to merge readiness.
 */
export function isReviewComplete(task: FactoryTask, workflow: Workflow): boolean {
  return workflow.delivery
    .filter((step) => step.kind !== 'final' && step.kind !== 'verify')
    .every((step) => isStepSatisfied(task, step));
}

/**
 * Choose the seat for one step: its first listed seat with no live attempt.
 *
 * @param step - Step needing a seat.
 * @param live - Running attempts.
 * @returns A free seat, or `null` while every listed seat is busy.
 */
export function seatFor(step: WorkflowStep, live: readonly Pick<FactoryJob, 'role'>[]): FactoryRole | null {
  return step.roles.find((role) => live.every((job) => job.role !== role)) ?? null;
}

/**
 * Whether a running attempt already performs this step for this delivery.
 * Attempts started before workflows existed are matched by seat and kind.
 *
 * @param step - Workflow step.
 * @param taskId - Delivery.
 * @param live - Running attempts.
 * @returns True when another attempt would duplicate it.
 */
export function isStepRunning(
  step: WorkflowStep,
  taskId: string,
  live: readonly Pick<FactoryJob, 'role' | 'kind' | 'taskId' | 'step'>[],
): boolean {
  return live.some((job) => {
    if (job.taskId !== taskId) {
      return false;
    }
    return job.step === null ? job.kind === step.kind && step.roles.includes(job.role) : job.step === step.id;
  });
}

/**
 * The next planning step for an objective, mapped to its job kind.
 *
 * @param feature - Objective in planning.
 * @param workflow - Its workflow.
 * @returns The step and job kind, or `null` when planning is complete or empty.
 */
export function planningStep(
  feature: Feature,
  workflow: Workflow,
): { step: WorkflowStep; kind: 'plan' | 'refine' } | null {
  const specify = workflow.planning.find((step) => step.kind === 'specify');
  if (specify !== undefined && feature.productPlan === null) {
    return { step: specify, kind: 'plan' };
  }
  const plan = workflow.planning.find((step) => step.kind === 'plan');
  return plan === undefined || feature.plan !== null ? null : { step: plan, kind: 'refine' };
}

/**
 * Planning steps that need a human decision before deliveries are created.
 *
 * @param feature - Objective whose plan is complete.
 * @param workflow - Its workflow.
 * @returns Approval and gated steps without a recorded approval.
 */
export function planningApprovals(feature: Feature, workflow: Workflow): WorkflowStep[] {
  return feature.plan === null
    ? []
    : workflow.planning.filter(
        (step) =>
          (step.kind === 'approve' || step.gate) && feature.approvals.every((approval) => approval.stepId !== step.id),
      );
}

/**
 * The review step an attempt performed. Attempts saved before workflows carry
 * no step and are matched to the review step their seat serves.
 *
 * @param workflow - Delivery workflow.
 * @param job - Completed review attempt.
 * @returns The review step, or `undefined` when the attempt was not a review.
 */
export function reviewStepOf(workflow: Workflow, job: Pick<FactoryJob, 'role' | 'step'>): WorkflowStep | undefined {
  return workflow.delivery.find(
    (step) => step.kind === 'review' && (job.step === null ? step.roles.includes(job.role) : step.id === job.step),
  );
}

/**
 * The step an attempt performs, if it belongs to the delivery's workflow.
 *
 * @param workflow - Delivery workflow.
 * @param job - Attempt.
 * @returns The step, or `undefined` for attempts saved before workflows or outside them.
 */
export function stepOf(workflow: Workflow, job: Pick<FactoryJob, 'step'>): WorkflowStep | undefined {
  return [...workflow.planning, ...workflow.delivery].find((step) => step.id === job.step);
}

/**
 * What a step may see of its delivery. Blind reviews see no peer reviews,
 * approvals or earlier feedback; other steps see only results from the steps
 * they may read (their declared inputs, or else their ancestors).
 *
 * @param task - Full delivery record.
 * @param workflow - Its workflow.
 * @param step - The step being prompted, if known.
 * @returns A copy safe to place in that step's prompt.
 */
export function stepEvidence(task: FactoryTask, workflow: Workflow, step: WorkflowStep | undefined): FactoryTask {
  if (step === undefined) {
    return task;
  }
  if (step.blind) {
    return { ...task, reviews: [], approvals: [], feedback: [] };
  }
  const readable = new Set(step.inputs ?? ancestorIds(workflow.delivery, step.id));
  const visible = workflow.delivery.filter((candidate) => readable.has(candidate.id));
  return {
    ...task,
    reviews: task.reviews.filter((review) => visible.some((candidate) => isReviewOf(review, candidate))),
    approvals: task.approvals.filter((approval) => readable.has(approval.stepId)),
  };
}
