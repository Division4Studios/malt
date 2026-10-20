/**
 * Human decisions on workflow approval steps and gated steps. A delivery
 * approval binds the exact head and base it judged, so later source needs a
 * new decision. Rejections carry the operator's note back to the people who
 * act on it: the delivery's developer, or the lead who revises the plan.
 *
 * @file
 */

import { MeshError } from '../protocol.ts';

import { MERGE_GATE_PENDING } from './merge-path.ts';
import { awaitingApproval, featureWorkflow, isReviewComplete, planningApprovals, taskWorkflow } from './pipeline.ts';
import { attemptBudget } from './repair-schema.ts';
import { REJECTED_REQUESTS_MAX, factorySchemas } from './schema.ts';
import { issueLabel } from './tracker-key.ts';

import type { FactoryRepository } from './repository.ts';
import type { Feature } from './schema.ts';
import type { Workflow, WorkflowStep } from './workflows.ts';
import type { z } from 'zod/v3';

/** What a decision did. */
interface DecisionResult {
  /** Approved, rejected, or a repeat of an earlier identical request. */
  readonly result: 'approved' | 'rejected' | 'repeated';
}
/** One parsed decision. */
type Decision = z.output<typeof factorySchemas.factory_approve>;

/**
 * Apply one approval or rejection exactly once.
 *
 * @param repository - Selected project ledger.
 * @param input - Untrusted operator decision.
 * @returns What happened; a repeated request reports its first result.
 * @throws {MeshError} When the step is not waiting, the source changed, or a rejection lacks a reason.
 */
export function decideApproval(repository: FactoryRepository, input: unknown): DecisionResult {
  const decision = factorySchemas.factory_approve.parse(input);
  if (!decision.approve && decision.note.length === 0) {
    throw new MeshError('INVALID_INPUT', 'Explain what must change when you reject a step.');
  }
  if ((decision.taskId === undefined) === (decision.featureId === undefined)) {
    throw new MeshError('INVALID_INPUT', 'Name exactly one delivery or one objective.');
  }
  return repository.store.transaction(() =>
    decision.taskId === undefined ? decidePlanning(repository, decision) : decideDelivery(repository, decision),
  );
}

/**
 * Find the waiting step or explain why the decision does not apply.
 *
 * @param waiting - Steps currently awaiting a human.
 * @param stepId - Identifier of the step named in the operator decision.
 * @returns The step definition the decision applies to.
 * @throws {MeshError} When that step is not waiting.
 */
function waitingStep(waiting: readonly WorkflowStep[], stepId: string): WorkflowStep {
  const step = waiting.find((candidate) => candidate.id === stepId);
  if (step === undefined) {
    throw new MeshError('FACTORY_GATED', 'That step is not waiting for a decision. Refresh to see its current state.');
  }
  return step;
}

/**
 * Whether a decision request was already applied, as an approval or a rejection.
 *
 * @param scope - Delivery or objective.
 * @param scope.approvals - Recorded approvals.
 * @param scope.rejectedRequests - Recent rejection request ids.
 * @param requestId - Request to look for.
 * @returns True for a retried decision.
 */
function isDecided(
  scope: {
    readonly approvals: readonly { readonly requestId: string }[];
    readonly rejectedRequests?: readonly string[] | undefined;
  },
  requestId: string,
): boolean {
  return (
    scope.approvals.some((approval) => approval.requestId === requestId) ||
    (scope.rejectedRequests ?? []).includes(requestId)
  );
}

/**
 * The recent rejection ids after recording one more.
 *
 * @param scope - Delivery or objective.
 * @param scope.rejectedRequests - Ids recorded so far.
 * @param requestId - Rejection being recorded.
 * @returns Bounded ids, newest last.
 */
function rejected(scope: { readonly rejectedRequests?: readonly string[] | undefined }, requestId: string): string[] {
  return [...(scope.rejectedRequests ?? []), requestId].slice(-REJECTED_REQUESTS_MAX);
}

/**
 * Decide a delivery step bound to the source under review.
 *
 * @param repository - Project ledger, inside a transaction.
 * @param decision - Parsed decision naming a delivery.
 * @returns Outcome.
 * @throws {MeshError} For stale source or a step that is not waiting.
 */
function decideDelivery(repository: FactoryRepository, decision: Decision): DecisionResult {
  const task = repository.task(decision.taskId ?? '');
  if (isDecided(task, decision.requestId)) {
    return { result: 'repeated' };
  }
  const workflow = taskWorkflow(task, repository.features());
  const step = waitingStep(awaitingApproval(task, workflow), decision.stepId);
  if (decision.head !== task.head) {
    throw new MeshError('INVALID_REVISION', 'The delivery has new source since you reviewed it. Review the new head.');
  }
  if (!decision.approve) {
    const config = repository.config();
    repository.editTask(task.id, (current) => {
      return {
        ...current,
        phase: config !== null && current.attempts >= attemptBudget(current, config) ? 'blocked' : 'development',
        reviews: [],
        approvals: [],
        rejectedRequests: rejected(current, decision.requestId),
        finalReview: null,
        error: `${step.title} was rejected: ${decision.note}`,
        feedback: [...current.feedback, `Operator rejected "${step.title}": ${decision.note}`],
      };
    });
    repository.notify(`Delivery ${issueLabel(task)}: ${step.title} rejected — ${decision.note}`);
    return { result: 'rejected' };
  }
  repository.editTask(task.id, (current) => {
    const approved = {
      ...current,
      approvals: [
        ...current.approvals,
        {
          stepId: step.id,
          head: current.head,
          base: current.base,
          note: decision.note,
          at: repository.store.now(),
          requestId: decision.requestId,
        },
      ],
    };
    return current.phase === 'review' && isReviewComplete(approved, workflow)
      ? { ...approved, phase: 'merge_ready', error: MERGE_GATE_PENDING }
      : approved;
  });
  return { result: 'approved' };
}

/**
 * Whether a planning step comes before any plan step: no plan step is among
 * its predecessors, transitively.
 *
 * @param workflow - Objective workflow.
 * @param step - Decided step.
 * @returns True for specification-stage steps.
 */
function isBeforePlan(workflow: Workflow, step: WorkflowStep): boolean {
  const steps = new Map(workflow.planning.map((candidate) => [candidate.id, candidate]));
  const pending = [step];
  const seen = new Set<string>();
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    if (current.kind === 'plan') {
      return false;
    }
    for (const id of current.after) {
      const previous = steps.get(id);
      if (previous === undefined || seen.has(id)) {
        continue;
      }
      seen.add(id);
      pending.push(previous);
    }
  }
  return true;
}

/**
 * Decide a planning approval before deliveries are created.
 *
 * @param repository - Project ledger, inside a transaction.
 * @param decision - Parsed decision naming an objective.
 * @returns Outcome.
 * @throws {MeshError} For an unknown objective or a step that is not waiting.
 */
function decidePlanning(repository: FactoryRepository, decision: Decision): DecisionResult {
  const feature = repository.features().find((candidate) => candidate.id === decision.featureId);
  if (feature === undefined) {
    throw new MeshError('NOT_FOUND', 'No objective with that ID in this project.');
  }
  if (isDecided(feature, decision.requestId)) {
    return { result: 'repeated' };
  }
  const workflow = featureWorkflow(feature);
  const step = waitingStep(planningApprovals(feature, workflow), decision.stepId);
  const now = repository.store.now();
  const updated: Feature = decision.approve
    ? {
        ...feature,
        approvals: [
          ...feature.approvals,
          { stepId: step.id, head: null, base: null, note: decision.note, at: now, requestId: decision.requestId },
        ],
        updatedAt: now,
      }
    : {
        ...feature,
        phase: 'refining',
        plan: null,
        // Rejecting specification-stage work (its gate, or an approval before any plan) revises the specification.
        ...(isBeforePlan(workflow, step) && { productPlan: null }),
        approvals: [],
        rejectedRequests: rejected(feature, decision.requestId),
        error: `Plan rejected at "${step.title}": ${decision.note}`,
        updatedAt: now,
      };
  repository.saveFeature(updated);
  return { result: decision.approve ? 'approved' : 'rejected' };
}
