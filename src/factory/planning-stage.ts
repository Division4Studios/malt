/**
 * Completion of planning steps: the product owner's specification, the lead's
 * atomic plan, independent plan reviews, and the lead's fresh revision that
 * must rule on every review finding. The interpreter decides what comes next,
 * so a plan is provisioned only after every planning step is complete.
 *
 * @file
 */

import { MeshError } from '../protocol.ts';

import { logObjective } from './objective-log.ts';
import {
  dispositionProblems,
  featureWorkflow,
  isPlanningWorkDone,
  planFindings,
  planningStep,
  stepOf,
} from './pipeline.ts';
import { validatePlan } from './scheduler.ts';
import { sealedHead } from './source-reader.ts';
import { STEP_OUTPUT_VERSION } from './workflow-schema.ts';

import type { FactoryContext } from './context.ts';
import type { AgentResult, FactoryJob, Feature } from './schema.ts';
import type { PlanOutput, PlanningResult, WorkflowStep } from './workflows.ts';

/** Recent planning results retained per objective. */
const MAX_PLANNING_RESULTS = 50;

/**
 * Apply one planning attempt to its objective.
 *
 * @param context - Project ledger.
 * @param job - Fenced planning attempt.
 * @param result - Structured result.
 * @throws {MeshError} When the objective no longer exists or a plan is invalid.
 */
export function completePlanning(context: FactoryContext, job: FactoryJob, result: AgentResult): void {
  const feature = context.repository.features().find((candidate) => candidate.id === job.featureId);
  if (feature === undefined) {
    throw new MeshError('NOT_FOUND', 'The product request no longer exists.');
  }
  if (feature.scopeReplacement !== undefined) {
    return;
  }
  const workflow = featureWorkflow(feature);
  const step = stepOf(workflow, job);
  if (result.outcome === 'blocked' || (result.outcome !== 'success' && step?.kind !== 'plan_review')) {
    stop(context, feature, [result.summary, ...result.findings].join('\n'));
    return;
  }
  const now = context.repository.store.now();
  const updated =
    step?.kind === 'plan_review'
      ? reviewed(feature, planningResult(job, step, result, now))
      : withOutput(planned(feature, job, result, now), planOutput(context, { job, step, result, now }));
  if (updated === null) {
    return;
  }
  if (typeof updated === 'string') {
    stop(context, feature, updated);
    return;
  }
  context.repository.saveFeature({
    ...updated,
    // Only decisions may remain once every planning attempt has its result.
    phase: isPlanningWorkDone(updated, workflow) ? 'provisioning' : 'refining',
    error: null,
    updatedAt: now,
  });
  logObjective(context.repository.store, feature.id, {
    kind: 'plan',
    actor: job.role,
    body: `${step?.title ?? job.kind}: ${result.outcome}. ${result.summary}`,
  });
}

/**
 * Record an independent review of the current plan.
 *
 * @param feature - Objective.
 * @param review - The recorded verdict and findings.
 * @returns Updated objective.
 */
function reviewed(feature: Feature, review: PlanningResult): Feature {
  return { ...feature, planningResults: [...(feature.planningResults ?? []), review].slice(-MAX_PLANNING_RESULTS) };
}

/**
 * Save a specification, plan or revision. A revision must rule on every review finding.
 *
 * @param feature - Objective.
 * @param job - Product owner or lead attempt.
 * @param result - Validated plan result.
 * @param now - Completion time.
 * @returns Updated objective, a reason to stop, or `null` when the step is no longer current.
 * @throws {MeshError} When the plan itself is invalid.
 */
function planned(feature: Feature, job: FactoryJob, result: AgentResult, now: number): PlanningUpdate {
  validatePlan(result);
  const workflow = featureWorkflow(feature);
  const step = stepOf(workflow, job);
  if (job.kind === 'plan') {
    return { ...feature, productPlan: result };
  }
  if (step?.kind !== 'plan_revise') {
    return { ...feature, plan: result, planAt: now };
  }
  if (planningStep(feature, workflow)?.step.id !== step.id) {
    return null;
  }
  const ids = planFindings(feature, workflow).map((finding) => finding.id);
  const problems = dispositionProblems(ids, result.dispositions ?? []);
  if (problems.length > 0) {
    return `${step.title} returned an incomplete ruling: ${problems.join(' ')}`;
  }
  return {
    ...feature,
    plan: result,
    planningResults: [...(feature.planningResults ?? []), planningResult(job, step, result, now)].slice(
      -MAX_PLANNING_RESULTS,
    ),
  };
}

/** What a planning attempt was and what it produced. */
interface PlanningAttempt {
  /** Product owner or lead attempt. */
  readonly job: FactoryJob;
  /** Its planning step, absent before workflows. */
  readonly step: WorkflowStep | undefined;
  /** Validated plan result. */
  readonly result: AgentResult;
  /** Completion time. */
  readonly now: number;
}

/** An updated objective, a reason to stop, or `null` when the step is no longer current. */
type PlanningUpdate = Feature | string | null;

/**
 * A typed record of the specification or plan an attempt produced.
 *
 * @param context - Project ledger, for the attempt's sealed source.
 * @param attempt - The attempt, its step, result and completion time.
 * @returns Output record bound to the exact source the attempt read.
 */
function planOutput(context: FactoryContext, attempt: PlanningAttempt): PlanOutput {
  const { job, step, result, now } = attempt;
  let kind: PlanOutput['kind'] = 'plan';
  if (job.kind === 'plan') {
    kind = 'specify';
  } else if (step?.kind === 'plan_revise') {
    kind = 'plan_revise';
  }
  return {
    schemaVersion: STEP_OUTPUT_VERSION,
    stepId: step?.id ?? null,
    kind,
    role: job.role,
    jobId: job.id,
    source: sealedHead(context.repository.store, job.id),
    deliveries: result.deliveries.length,
    at: now,
  };
}

/**
 * Append a plan output to an updated objective, keeping the bounded tail.
 *
 * @param updated - Objective after a specification, plan or revision, or a stop reason.
 * @param output - The typed output record.
 * @returns Objective with the record, or the unchanged stop reason or `null`.
 */
function withOutput(updated: PlanningUpdate, output: PlanOutput): PlanningUpdate {
  return updated === null || typeof updated === 'string'
    ? updated
    : { ...updated, planOutputs: [...(updated.planOutputs ?? []), output].slice(-MAX_PLANNING_RESULTS) };
}

/**
 * A recorded planning result.
 *
 * @param job - Attempt.
 * @param step - Review or revision step.
 * @param result - Structured result.
 * @param now - Completion time.
 * @returns Ledger entry.
 */
function planningResult(job: FactoryJob, step: WorkflowStep, result: AgentResult, now: number): PlanningResult {
  return {
    schemaVersion: STEP_OUTPUT_VERSION,
    stepId: step.id,
    kind: step.kind === 'plan_revise' ? 'plan_revise' : 'plan_review',
    role: job.role,
    jobId: job.id,
    outcome: result.outcome === 'success' ? 'success' : 'changes_requested',
    summary: result.summary,
    findings: result.findings,
    dispositions: result.dispositions ?? [],
    at: now,
  };
}

/**
 * Stop planning for a product or operator decision, keeping the evidence.
 *
 * @param context - Project ledger.
 * @param feature - Objective.
 * @param reason - What must be decided.
 */
function stop(context: FactoryContext, feature: Feature, reason: string): void {
  context.repository.saveFeature({
    ...feature,
    phase: 'blocked',
    error: reason,
    updatedAt: context.repository.store.now(),
  });
  context.repository.notify(`Product owner / lead clarification required: ${reason}`);
}
