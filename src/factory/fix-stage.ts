/**
 * Completion of fix-stage steps. A fixer rules on every review finding and its
 * adopted fixes are validated and published exactly like developer work; a
 * librarian's documentation is published the same way; an independent
 * regression check verifies the fixes on the exact resulting head. A failed
 * regression sends the work back to the fixer, a bounded number of times.
 *
 * @file
 */

import { MeshError } from '../protocol.ts';

import { queueComment } from './comments.ts';
import { runChecks } from './execution.ts';
import { MergeConflictError } from './merge-conflict.ts';
import {
  boundSource,
  dispositionProblems,
  findingsToRule,
  isReviewComplete,
  startableSteps,
  stepOf,
  taskWorkflow,
} from './pipeline.ts';
import { PublicationSizeError } from './publication-size.ts';
import { recordConflict } from './repairs.ts';

import type { FactoryContext } from './context.ts';
import type { AgentResult, FactoryJob, FactoryTask } from './schema.ts';
import type { StepResult, Workflow, WorkflowStep } from './workflows.ts';

/** Recent fix-stage results retained per delivery; older rounds are history only. */
const MAX_STEP_RESULTS = 50;

/**
 * Apply one fix-stage attempt while its step is still the next thing to do.
 *
 * @param context - Project services.
 * @param job - Fenced fix-stage claim.
 * @param task - Delivery at completion time.
 * @param evidence - Structured result and cancellation.
 */
export async function completeFixStage(
  context: FactoryContext,
  job: FactoryJob,
  task: FactoryTask,
  evidence: { result: AgentResult; signal: AbortSignal },
): Promise<void> {
  const workflow = taskWorkflow(task, context.repository.features());
  const step = stepOf(workflow, job);
  if (
    step === undefined ||
    task.phase !== 'review' ||
    startableSteps(task, workflow).every((candidate) => candidate.id !== step.id)
  ) {
    return;
  }
  const { result } = evidence;
  if (step.kind === 'regress') {
    completeRegression(context, { job, task, workflow, step }, result);
    return;
  }
  if (result.outcome !== 'success') {
    blockForOperator(context, task, `${step.title} could not finish: ${result.summary}`);
    return;
  }
  if (step.kind === 'adjudicate') {
    const ids = findingsToRule(task, workflow, step).map((finding) => finding.id);
    const problems = dispositionProblems(ids, result.dispositions ?? []);
    if (problems.length > 0) {
      blockForOperator(context, task, `${step.title} returned an incomplete ruling: ${problems.join(' ')}`);
      return;
    }
  }
  await publishFix(context, { job, task, step }, result, evidence.signal);
}

/**
 * A recorded result for a fix-stage step.
 *
 * @param job - Attempt that produced it.
 * @param step - Its step.
 * @param source - Head and base it produced or judged.
 * @param result - Structured provider result.
 * @returns Result entry for the delivery ledger.
 */
function stepResult(
  job: FactoryJob,
  step: WorkflowStep,
  source: { head: string; base: string; at: number },
  result: AgentResult,
): StepResult {
  return {
    stepId: step.id,
    kind: step.kind === 'regress' || step.kind === 'document' ? step.kind : 'adjudicate',
    role: job.role,
    jobId: job.id,
    head: source.head,
    base: source.base,
    outcome: result.outcome === 'success' ? 'success' : 'changes_requested',
    summary: result.summary,
    findings: result.findings,
    dispositions: result.dispositions ?? [],
    at: source.at,
  };
}

/**
 * Validate, commit and push the fixer's or librarian's changes as new source.
 *
 * @param context - Project Git, checks and ledger.
 * @param scope - Attempt, delivery and step.
 * @param scope.job - Fenced attempt.
 * @param scope.task - Delivery with an owned worktree.
 * @param scope.step - Adjudicate or document step.
 * @param result - Successful structured result.
 * @param signal - Cancellation before publication.
 * @throws {MeshError} When the worktree is missing or the claim expired before publication.
 */
async function publishFix(
  context: FactoryContext,
  scope: { job: FactoryJob; task: FactoryTask; step: WorkflowStep },
  result: AgentResult,
  signal: AbortSignal,
): Promise<void> {
  const { job, task, step } = scope;
  const { worktree } = task;
  if (worktree === null) {
    throw new MeshError('FACTORY_GATED', 'The delivery worktree is missing.');
  }
  try {
    await context.workspaces.publish(
      task,
      async (source) => {
        signal.throwIfAborted();
        const snapshot = await context.workspaces.snapshot(worktree);
        await runChecks(context, job, { cwd: worktree, stage: 'test', signal });
        await context.workspaces.assertUnchanged(snapshot);
        const claim = context.repository.jobs().find((candidate) => candidate.id === job.id);
        if (claim?.state !== 'running' || claim.token !== job.token) {
          throw new MeshError('FACTORY_GATED', `The ${step.title} claim expired before publication.`);
        }
        const now = context.repository.store.now();
        const published = context.repository.editTask(task.id, (current) => {
          if (current.phase !== 'review' || current.version !== task.version) {
            throw new MeshError('FACTORY_GATED', 'The delivery changed or stopped before publication.');
          }
          return {
            ...current,
            phase: 'publishing',
            head: source.head,
            base: source.base,
            stepResults: [...current.stepResults, stepResult(job, step, { ...source, at: now }, result)].slice(
              -MAX_STEP_RESULTS,
            ),
            error: null,
          };
        });
        queueComment(context, published, `${step.title} (${job.role}) published ${source.head}.\n\n${result.summary}`);
      },
      { step: step.id, kind: step.kind, role: job.role, jobId: job.id },
    );
  } catch (error) {
    if (error instanceof MergeConflictError) {
      await recordConflict(context, task, {
        files: error.files,
        head: error.head,
        base: error.base,
        directory: worktree,
      });
      return;
    }
    if (!(error instanceof PublicationSizeError)) {
      throw error;
    }
    blockForOperator(context, task, error.message);
  }
}

/**
 * Record a regression verdict on the exact current head; failures go back to the fixer.
 *
 * @param context - Project ledger and policy.
 * @param scope - Attempt, delivery, workflow and step.
 * @param scope.job - Fenced attempt.
 * @param scope.task - Delivery under review.
 * @param scope.workflow - Its workflow.
 * @param scope.step - Regress step.
 * @param result - Structured verdict.
 */
function completeRegression(
  context: FactoryContext,
  scope: { job: FactoryJob; task: FactoryTask; workflow: Workflow; step: WorkflowStep },
  result: AgentResult,
): void {
  const { job, task, workflow, step } = scope;
  const source = boundSource(task, workflow, step);
  if (source?.head !== job.head || source.base === null || source.head === null) {
    return;
  }
  if (result.outcome === 'blocked') {
    blockForOperator(context, task, `${step.title} is blocked: ${result.summary}`);
    return;
  }
  const since = task.implementation?.at ?? 0;
  const failures = task.stepResults.filter(
    (previous) => previous.kind === 'regress' && previous.outcome === 'changes_requested' && previous.at >= since,
  ).length;
  const isFailure = result.outcome !== 'success';
  if (isFailure && failures + 1 >= context.settings.maxAttempts) {
    blockForOperator(context, task, `${step.title} still fails after ${String(failures + 1)} fix rounds.`);
    return;
  }
  const entry = stepResult(
    job,
    step,
    { head: source.head, base: source.base, at: context.repository.store.now() },
    result,
  );
  const updated = context.repository.editTask(task.id, (current) => {
    const recorded = {
      ...current,
      stepResults: [...current.stepResults, entry].slice(-MAX_STEP_RESULTS),
      feedback: isFailure
        ? [
            ...current.feedback,
            `Return to the fixer — ${step.title} found unresolved findings: ${result.findings.join(' | ')}`,
          ]
        : current.feedback,
      error: null,
    };
    return isReviewComplete(recorded, workflow) ? { ...recorded, phase: 'merge_ready' } : recorded;
  });
  queueComment(
    context,
    updated,
    isFailure
      ? `${step.title} returned the delivery to the fixer.\n\n${result.findings.join('\n')}`
      : `${step.title} verified ${source.head}.\n\n${result.summary}`,
  );
}

/**
 * Stop a delivery for an operator decision, keeping its source and evidence.
 *
 * @param context - Project ledger.
 * @param task - Delivery to block.
 * @param reason - What the operator must decide.
 */
function blockForOperator(context: FactoryContext, task: FactoryTask, reason: string): void {
  context.repository.editTask(task.id, (current) => ({ ...current, phase: 'blocked', error: reason }));
  context.repository.notify(`Delivery #${String(task.issue)} needs a decision: ${reason}`);
}
