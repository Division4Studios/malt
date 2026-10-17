/**
 * Pure workflow interpreter: given a delivery and the workflow its objective
 * froze, decide which steps are satisfied, which may start, which wait for a
 * human, and which seat performs each step. The scheduler, completion and
 * console projections all ask this module instead of hard-coding roles.
 *
 * One rule binds results to source. Every step judges the source produced by
 * its nearest code-writing ancestor (implement, adjudicate or document). A
 * code step's result stays current until a later regression check fails it.
 * New source therefore invalidates exactly the results that judged older
 * source, and approvals can never outlive the code they approved.
 *
 * @file
 */

import { MERGE_GATE_STEP } from './gate-schema.ts';
import { DEFAULT_WORKFLOW_ID, ancestorIds, builtinWorkflows } from './workflows.ts';

import type { FactoryJob, FactoryRole, FactoryTask, Feature } from './schema.ts';
import type { Disposition, PlanningResult, StepKind, StepResult, Workflow, WorkflowStep } from './workflows.ts';

/** Step kinds the supervisor can run today. */
const RUNNABLE_KINDS: ReadonlySet<StepKind> = new Set([
  'specify',
  'plan',
  'plan_review',
  'plan_revise',
  'implement',
  'review',
  'adjudicate',
  'document',
  'regress',
  'approve',
  'final',
  'verify',
]);
/** Steps with dedicated delivery phases rather than results recorded during review. */
const SPINE_KINDS: ReadonlySet<StepKind> = new Set(['implement', 'final', 'verify']);
/** Steps that write code; later steps judge what they produced. */
const CODE_KINDS: ReadonlySet<StepKind> = new Set(['implement', 'adjudicate', 'document']);
/** Phases in which the implementation has been published. */
const PUBLISHED_PHASES: ReadonlySet<string> = new Set([
  'review',
  'merge_ready',
  'merging',
  'verifying',
  'closing',
  'done',
]);

/** A source a step produced or must judge. */
export interface Source {
  /** Commit under judgement. */
  readonly head: string | null;
  /** Base it was measured against. */
  readonly base: string | null;
  /** When it was produced; results older than their source are stale. */
  readonly at: number;
}

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
 * A workflow with frozen gates applied: the plan gate gates the plan step, and
 * the merge gate adds one approval step right before the final check. Gates
 * live beside the frozen copy, so its revision still names what was frozen.
 *
 * @param workflow - Frozen workflow.
 * @param gates - Gates frozen on the objective or delivery.
 * @param gates.plan - Approve the plan before deliveries exist.
 * @param gates.merge - Approve the exact head before the final check.
 * @returns The workflow the interpreter runs.
 */
export function withGates(workflow: Workflow, gates: { plan?: boolean; merge?: boolean }): Workflow {
  const planning =
    gates.plan === true
      ? workflow.planning.map((step) => (step.kind === 'plan' ? { ...step, gate: true } : step))
      : workflow.planning;
  const final = workflow.delivery.find((step) => step.kind === 'final');
  if (final === undefined || gates.merge !== true || workflow.delivery.some((step) => step.id === MERGE_GATE_STEP)) {
    return planning === workflow.planning ? workflow : { ...workflow, planning };
  }
  const gate: WorkflowStep = {
    id: MERGE_GATE_STEP,
    kind: 'approve',
    title: 'Merge approval',
    roles: [],
    profile: null,
    after: [...final.after],
    inputs: null,
    blind: false,
    gate: false,
    optional: false,
    provider: null,
    instructions: '',
  };
  const delivery = workflow.delivery.flatMap((step) =>
    step === final ? [gate, { ...step, after: [...step.after, MERGE_GATE_STEP] }] : [step],
  );
  return { ...workflow, planning, delivery };
}

/**
 * The workflow an objective runs.
 *
 * @param feature - Objective, possibly saved before workflows existed.
 * @returns Its frozen workflow with its gates, or the legacy pipeline.
 */
export function featureWorkflow(feature: Feature | null | undefined): Workflow {
  return withGates(feature?.workflow?.workflow ?? legacyWorkflow(), feature?.gates ?? {});
}

/**
 * The workflow one delivery runs: its own frozen copy, else its objective's,
 * with the merge gate the delivery froze (or its objective's, for older ones).
 *
 * @param task - Delivery.
 * @param features - Known objectives, consulted for deliveries without a frozen copy.
 * @returns Frozen workflow, or the legacy pipeline for deliveries saved before workflows.
 */
export function taskWorkflow(task: FactoryTask, features: readonly Feature[] = []): Workflow {
  const feature = features.find((candidate) => candidate.id === task.featureId);
  const workflow = task.workflow?.workflow ?? feature?.workflow?.workflow ?? legacyWorkflow();
  return withGates(workflow, { merge: task.gates?.merge ?? feature?.gates?.merge ?? false });
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
 * The latest code-writing ancestor of a step: what the step must judge.
 *
 * @param workflow - Delivery workflow.
 * @param step - Any delivery step.
 * @returns That ancestor, or `undefined` for the implement step itself.
 */
function producerOf(workflow: Workflow, step: WorkflowStep): WorkflowStep | undefined {
  const ancestors = ancestorIds(workflow.delivery, step.id);
  return workflow.delivery.findLast((candidate) => ancestors.has(candidate.id) && CODE_KINDS.has(candidate.kind));
}

/**
 * The latest successful result of a fix-stage step.
 *
 * @param task - Delivery.
 * @param step - Fix-stage step.
 * @returns That result, if any.
 */
function latestResult(task: FactoryTask, step: WorkflowStep): StepResult | undefined {
  return task.stepResults.findLast((result) => result.stepId === step.id && result.outcome === 'success');
}

/**
 * The source a code step produced, while it is still current.
 *
 * @param task - Delivery.
 * @param workflow - Its workflow.
 * @param step - Implement, adjudicate or document step.
 * @returns Produced source, or `null` when missing or invalidated.
 */
function producedSource(task: FactoryTask, workflow: Workflow, step: WorkflowStep): Source | null {
  if (step.kind === 'implement') {
    return PUBLISHED_PHASES.has(task.phase)
      ? (task.implementation ?? { head: task.head, base: task.base, at: 0 })
      : null;
  }
  const result = latestResult(task, step);
  const input = boundSource(task, workflow, step);
  const isRejected = task.stepResults.some(
    (later) => later.kind === 'regress' && later.outcome === 'changes_requested' && later.at > (result?.at ?? 0),
  );
  return isRejected || result === undefined || input === null || result.at < input.at
    ? null
    : { head: result.head, base: result.base, at: result.at };
}

/**
 * The source a step must judge: what its nearest code-writing ancestor produced.
 *
 * @param task - Delivery.
 * @param workflow - Its workflow.
 * @param step - Any delivery step except implement.
 * @returns Bound source, or `null` while that ancestor has no current result.
 */
export function boundSource(task: FactoryTask, workflow: Workflow, step: WorkflowStep): Source | null {
  const producer = producerOf(workflow, step);
  return producer === undefined ? null : producedSource(task, workflow, producer);
}

/**
 * The head a human approves for a step: what it produced, or what it judged.
 *
 * @param task - Delivery.
 * @param workflow - Its workflow.
 * @param step - Approval or gated step.
 * @returns Source the approval binds, or `null` when not yet available.
 */
export function approvalSource(task: FactoryTask, workflow: Workflow, step: WorkflowStep): Source | null {
  return CODE_KINDS.has(step.kind) ? producedSource(task, workflow, step) : boundSource(task, workflow, step);
}

/**
 * Whether a human approved this step for the source it binds.
 *
 * @param task - Delivery.
 * @param workflow - Its workflow.
 * @param step - Gated or approval step.
 * @returns True when an approval names the bound head.
 */
function isApproved(task: FactoryTask, workflow: Workflow, step: WorkflowStep): boolean {
  const source = approvalSource(task, workflow, step);
  return (
    source !== null && task.approvals.some((approval) => approval.stepId === step.id && approval.head === source.head)
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
 * Whether a later adjudicate step rules on this review's findings, so a review
 * that requests changes still completes its step.
 *
 * @param workflow - Delivery workflow.
 * @param step - Review step.
 * @returns True when a fixer downstream consumes its findings.
 */
export function isAdjudicated(workflow: Workflow, step: WorkflowStep): boolean {
  return workflow.delivery.some(
    (candidate) => candidate.kind === 'adjudicate' && ancestorIds(workflow.delivery, candidate.id).has(step.id),
  );
}

/**
 * The review recorded for a step at the source it must judge.
 *
 * @param task - Delivery.
 * @param workflow - Its workflow.
 * @param step - The review step whose recorded result to find.
 * @returns Current review, if any.
 */
export function currentReview(
  task: FactoryTask,
  workflow: Workflow,
  step: WorkflowStep,
): FactoryTask['reviews'][number] | undefined {
  const source = boundSource(task, workflow, step);
  return source === null
    ? undefined
    : task.reviews.findLast(
        (review) => isReviewOf(review, step) && review.head === source.head && review.base === source.base,
      );
}

/**
 * Whether a review step's current result completes it. A review requesting
 * changes still completes when a fixer downstream rules on its findings.
 *
 * @param task - Delivery.
 * @param workflow - Its workflow.
 * @param step - Review step.
 * @returns True when the review judged the bound source.
 */
function isReviewed(task: FactoryTask, workflow: Workflow, step: WorkflowStep): boolean {
  const outcome = currentReview(task, workflow, step)?.outcome;
  return outcome === 'success' || (outcome === 'changes_requested' && isAdjudicated(workflow, step));
}

/**
 * Whether a regression check passed on exactly the source it must judge.
 *
 * @param task - Delivery.
 * @param workflow - Its workflow.
 * @param step - Regress step.
 * @returns True for a passing verdict no older than that source.
 */
function isVerified(task: FactoryTask, workflow: Workflow, step: WorkflowStep): boolean {
  const source = boundSource(task, workflow, step);
  const result = latestResult(task, step);
  const isRecorded = source !== null && result !== undefined;
  return isRecorded && result.head === source.head && result.at >= source.at;
}

/**
 * Whether the final check approved exactly the current head and base.
 *
 * @param task - Delivery.
 * @returns True when the recorded final approval is current.
 */
function isFinalCurrent(task: FactoryTask): boolean {
  const review = task.finalReview;
  return review !== null && task.head === review.head && task.base === review.base;
}

/** How each step kind proves its work is done; planning kinds never appear in delivery sections. */
const RESULT_CHECKS: Readonly<
  Record<StepKind, (task: FactoryTask, workflow: Workflow, step: WorkflowStep) => boolean>
> = {
  implement: (task, workflow, step) => producedSource(task, workflow, step) !== null,
  adjudicate: (task, workflow, step) => producedSource(task, workflow, step) !== null,
  document: (task, workflow, step) => producedSource(task, workflow, step) !== null,
  review: isReviewed,
  regress: isVerified,
  approve: isApproved,
  final: (task) => isFinalCurrent(task),
  verify: (task) => task.verifiedMain !== null,
  specify: () => false,
  plan: () => false,
  plan_review: () => false,
  plan_revise: () => false,
};

/**
 * Whether a delivery step's work is done for its bound source, ignoring its gate.
 *
 * @param task - Delivery.
 * @param workflow - Its workflow.
 * @param step - Any delivery step.
 * @returns True when its current result exists.
 */
function hasResult(task: FactoryTask, workflow: Workflow, step: WorkflowStep): boolean {
  return RESULT_CHECKS[step.kind](task, workflow, step);
}

/**
 * Whether a step is complete, including any human approval its gate requires.
 *
 * @param task - Delivery.
 * @param workflow - Its workflow.
 * @param step - Delivery step.
 * @returns True when downstream steps may rely on it.
 */
export function isStepSatisfied(task: FactoryTask, workflow: Workflow, step: WorkflowStep): boolean {
  return hasResult(task, workflow, step) && (!step.gate || isApproved(task, workflow, step));
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
    return before !== undefined && isStepSatisfied(task, workflow, before);
  });
}

/**
 * Review-stage steps that may start now: model steps whose predecessors are
 * complete and whose own current result is missing.
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
      !hasResult(task, workflow, step) &&
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
          ? task.phase === 'review' && !isApproved(task, workflow, step) && isUnblocked(task, workflow, step)
          : step.gate && hasResult(task, workflow, step) && !isApproved(task, workflow, step);
      });
}

/**
 * Whether every step before the final check is complete for its bound source.
 *
 * @param task - Delivery.
 * @param workflow - Its workflow.
 * @returns True when the delivery may move to merge readiness.
 */
export function isReviewComplete(task: FactoryTask, workflow: Workflow): boolean {
  return workflow.delivery
    .filter((step) => step.kind !== 'final' && step.kind !== 'verify')
    .every((step) => isStepSatisfied(task, workflow, step));
}

/**
 * Every finding the fixer must rule on, with stable ids `<reviewStepId>-<n>`.
 *
 * @param task - Delivery.
 * @param workflow - Its workflow.
 * @param step - Adjudicate step.
 * @returns Findings from the current reviews that feed this step.
 */
export function findingsToRule(
  task: FactoryTask,
  workflow: Workflow,
  step: WorkflowStep,
): { id: string; step: string; finding: string }[] {
  const ancestors = ancestorIds(workflow.delivery, step.id);
  return workflow.delivery
    .filter((candidate) => candidate.kind === 'review' && ancestors.has(candidate.id))
    .flatMap((review) => {
      const findings = currentReview(task, workflow, review)?.findings ?? [];
      return findings.map((finding, index) => {
        return {
          id: `${review.id}-${String(index + 1)}`,
          step: review.title,
          finding,
        };
      });
    });
}

/**
 * Explain how a fixer's ledger fails to rule on every finding exactly once.
 *
 * @param ids - Finding ids that require a ruling.
 * @param dispositions - The fixer's ledger.
 * @returns Problems; empty when the ledger is complete.
 */
export function dispositionProblems(ids: readonly string[], dispositions: readonly Disposition[]): string[] {
  const problems: string[] = [];
  const ruled = new Map<string, number>();
  for (const disposition of dispositions) {
    ruled.set(disposition.id, (ruled.get(disposition.id) ?? 0) + 1);
    if (!ids.includes(disposition.id)) {
      problems.push(`Disposition ${disposition.id} names no current finding.`);
    }
    if (disposition.decision !== 'rejected' && disposition.evidence.trim().length === 0) {
      problems.push(`Disposition ${disposition.id} (${disposition.decision}) needs evidence.`);
    }
  }
  for (const id of ids) {
    const count = ruled.get(id) ?? 0;
    if (count !== 1) {
      problems.push(`Finding ${id} needs exactly one disposition; found ${String(count)}.`);
    }
  }
  return problems;
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
): { step: WorkflowStep; kind: 'plan' | 'refine' | 'plan_review' } | null {
  const specify = workflow.planning.find((step) => step.kind === 'specify');
  if (specify !== undefined && feature.productPlan === null) {
    return { step: specify, kind: 'plan' };
  }
  const plan = workflow.planning.find((step) => step.kind === 'plan');
  if (plan === undefined) {
    return null;
  }
  if (feature.plan === null) {
    return { step: plan, kind: 'refine' };
  }
  const review = workflow.planning.find(
    (step) => step.kind === 'plan_review' && planReview(feature, step) === undefined,
  );
  if (review !== undefined) {
    return { step: review, kind: 'plan_review' };
  }
  const revise = workflow.planning.find((step) => step.kind === 'plan_revise');
  return revise === undefined || isRevised(feature, workflow, revise) ? null : { step: revise, kind: 'refine' };
}

/**
 * The latest review a plan review step recorded for the current plan.
 *
 * @param feature - Objective.
 * @param step - The plan review step whose latest result to find.
 * @returns That review, if the current plan has one.
 */
function planReview(feature: Feature, step: WorkflowStep): PlanningResult | undefined {
  const planAt = feature.planAt ?? 0;
  return (feature.planningResults ?? []).findLast((result) => result.stepId === step.id && result.at >= planAt);
}

/**
 * Every plan review finding the revision must rule on, with ids `<reviewStepId>-<n>`.
 *
 * @param feature - Objective with a reviewed plan.
 * @param workflow - Its workflow.
 * @returns Findings from the current plan's reviews.
 */
export function planFindings(feature: Feature, workflow: Workflow): { id: string; step: string; finding: string }[] {
  return workflow.planning
    .filter((step) => step.kind === 'plan_review')
    .flatMap((step) => {
      const findings = planReview(feature, step)?.findings ?? [];
      return findings.map((finding, index) => ({ id: `${step.id}-${String(index + 1)}`, step: step.title, finding }));
    });
}

/**
 * Whether the revision step has addressed the current plan's reviews. A plan
 * whose reviews raised nothing needs no revision.
 *
 * @param feature - Objective.
 * @param workflow - Its workflow.
 * @param revise - Plan revision step.
 * @returns True when no revision is needed or one postdates every review.
 */
function isRevised(feature: Feature, workflow: Workflow, revise: WorkflowStep): boolean {
  const reviews = workflow.planning
    .filter((step) => step.kind === 'plan_review')
    .map((step) => planReview(feature, step));
  const isClean = reviews.every((review) => review?.outcome === 'success' && review.findings.length === 0);
  const latest = Math.max(0, ...reviews.map((review) => review?.at ?? 0));
  return (
    isClean || (feature.planningResults ?? []).some((result) => result.stepId === revise.id && result.at >= latest)
  );
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
 * results, approvals or earlier feedback; other steps see only results from
 * the steps they may read (their declared inputs, or else their ancestors).
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
    return { ...task, reviews: [], stepResults: [], approvals: [], feedback: [], repairs: [] };
  }
  const readable = new Set(step.inputs ?? ancestorIds(workflow.delivery, step.id));
  const visible = workflow.delivery.filter((candidate) => readable.has(candidate.id));
  return {
    ...task,
    reviews: task.reviews.filter((review) => visible.some((candidate) => isReviewOf(review, candidate))),
    stepResults: task.stepResults.filter((result) => readable.has(result.stepId)),
    approvals: task.approvals.filter((approval) => readable.has(approval.stepId)),
  };
}
