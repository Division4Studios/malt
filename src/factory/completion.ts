/**
 * Apply bounded role results to the delivery ledger. Rejections return to the
 * original developer; approval evidence cannot survive a changed source head.
 * Tickets close only after actual merged-main checks and final verification.
 *
 * @file
 */

import { randomUUID } from 'node:crypto';

import { MeshError } from '../protocol.ts';

import { canApplyInstructionStage } from './controls.ts';
import { runChecks } from './execution.ts';
import { PublicationSizeError } from './publication-size.ts';
import { hasApprovals, validatePlan } from './scheduler.ts';
import { completeTriage } from './triage.ts';

import type { ExecutedJob, FactoryContext } from './context.ts';
import type { AgentResult, FactoryJob, FactoryTask } from './schema.ts';

/**
 * Persist a deterministic outbox effect tied to a particular delivery revision.
 *
 * @param context - Workspace ledger.
 * @param task - Current delivery revision.
 * @param value - Public finding or completion evidence.
 */
function queueComment(context: FactoryContext, task: FactoryTask, value: string): void {
  context.repository.enqueueEffect({
    id: `${task.id}:${String(task.version)}:comment`,
    kind: 'comment',
    issue: task.issue,
    value,
    attempts: 0,
    retryAt: 0,
    error: null,
  });
}

/**
 * Publish validated developer completion without claiming merged acceptance.
 *
 * @param context - Current delivery ledger.
 * @param taskId - Owned task.
 * @param role - Responsible developer.
 * @param summary - Bounded structured handoff.
 */
function queueDevelopmentComment(context: FactoryContext, taskId: string, role: string, summary: string): void {
  const updated = context.repository.task(taskId);
  const head = updated.head ?? 'unknown';
  queueComment(
    context,
    updated,
    `${role} implementation prepared.\n\n${summary}\n\nConfigured validation passed on commit ${head}. Next: focused PR publication and independent QA. This is not merged-main acceptance.`,
  );
}

/**
 * Record outcome-based learning without copying raw logs or credentials.
 *
 * @param context - Project learning service.
 * @param task - Delivery outcome.
 * @param finding - Concrete reviewed finding.
 * @param outcome - Result category.
 */
async function recordLesson(
  context: FactoryContext,
  task: FactoryTask,
  finding: string,
  outcome: 'rework' | 'success',
): Promise<void> {
  await context.learning.execute(
    'learning_record',
    {
      summary: `Issue #${String(task.issue)}: ${outcome}`,
      cause: finding,
      prevention:
        outcome === 'success'
          ? 'Retain the project-specific acceptance checks and exact-head review evidence for similar deliveries.'
          : 'The original developer must reproduce and fix the finding, rerun acceptance checks and obtain new independent approvals on the changed head.',
      evidence: [
        `Issue #${String(task.issue)}`,
        task.prUrl ?? `Project-local task ${task.id}`,
        `Source head ${task.head ?? 'not published'}`,
      ],
      outcome,
      ticket: task.issue,
    },
    'factory-runtime',
  );
}

/**
 * Return a defect to its responsible developer, preserving unfinished work.
 *
 * @param context - Delivery services.
 * @param task - Original delivery.
 * @param finding - Reproducible QA/test/final finding.
 * @returns Updated delivery state.
 */
export async function rejectDelivery(
  context: FactoryContext,
  task: FactoryTask,
  finding: string,
): Promise<FactoryTask> {
  const wasMerged = task.merge !== null;
  const isExhausted = task.attempts >= context.settings.maxAttempts;
  const returned = context.repository.editTask(task.id, (current) => {
    return {
      ...current,
      phase: isExhausted ? 'blocked' : 'development',
      reviews: [],
      finalReview: null,
      verifiedMain: null,
      error: finding,
      feedback: [...current.feedback, `Return to ${current.developer ?? 'the responsible developer'}: ${finding}`],
      ...(wasMerged && { branch: null, worktree: null, head: null, base: null, pr: null, prUrl: null, merge: null }),
    };
  });
  queueComment(
    context,
    returned,
    `Changes requested for ${returned.developer ?? 'the responsible developer'}:\n\n${finding}\n\nQA reports the defect; implementation remains assigned to the developer. New source requires two new independent reviews.`,
  );
  await recordLesson(context, returned, finding, 'rework');
  return returned;
}

/**
 * Commit a role's structured completion after its fencing token is checked.
 *
 * @param context - Current project services.
 * @param job - Current bounded attempt.
 * @param execution - Actual source/check/model evidence.
 * @param signal - Cancellation before any final remote action.
 * @throws {MeshError} When approvals or verification are stale.
 */
export async function completeJob(
  context: FactoryContext,
  job: FactoryJob,
  execution: ExecutedJob,
  signal: AbortSignal,
): Promise<void> {
  const record = job;
  if (execution.waiting !== null) {
    if (record.taskId !== null) {
      context.repository.editTask(record.taskId, (task) => ({ ...task, error: execution.waiting }));
    }
    return;
  }
  const result = execution.completion?.result;
  if (result === undefined || result === null) {
    throw new MeshError(
      'FACTORY_GATED',
      'The provider did not return a valid successful structured result. Inspect its local attempt logs.',
    );
  }
  context.repository.instructionLedger.validate(job, result.instructionReceipts);
  const canApply = canApplyInstructionStage(context, job);
  await applyOutcome(context, record, { result, execution, signal });
  signal.throwIfAborted();
  context.repository.instructionLedger.record(job, result, canApply);
}

/**
 * Apply one bounded role result independently of instruction reporting.
 *
 * @param context - Current project services.
 * @param record - Current fenced assignment.
 * @param evidence - Native result, executed source and stop signal.
 */
async function applyOutcome(
  context: FactoryContext,
  record: FactoryJob,
  evidence: { result: AgentResult; execution: ExecutedJob; signal: AbortSignal },
): Promise<void> {
  const { result, execution, signal } = evidence;
  if (record.kind === 'triage') {
    completeTriage(context.repository, record, result);
    return;
  }
  if (record.kind === 'plan' || record.kind === 'refine') {
    completePlan(context, record, result);
    return;
  }
  if (record.kind === 'learn') {
    completeLearning(context, result);
    return;
  }
  if (record.kind === 'skill') {
    completeSkillReview(context, record, result);
    return;
  }
  await applyDelivery(context, { ...record, kind: record.kind }, { result, execution, signal });
}

/**
 * Apply only a still-current delivery stage; stale QA findings cannot regress newer work.
 *
 * @param context - Current ledger.
 * @param job - Fenced delivery claim.
 * @param evidence - Result, checks and cancellation.
 * @throws {MeshError} For missing task or invalid stage.
 */
async function applyDelivery(
  context: FactoryContext,
  job: FactoryJob & { kind: 'develop' | 'review' | 'final' | 'verify' },
  evidence: { result: AgentResult; execution: ExecutedJob; signal: AbortSignal },
): Promise<void> {
  const record = job;
  const { result, execution, signal } = evidence;
  if (record.taskId === null) {
    throw new MeshError('FACTORY_GATED', 'A delivery record must name its task.');
  }
  const task = context.repository.task(record.taskId);
  const stages = {
    develop: 'development',
    review: 'review',
    final: 'merge_ready',
    verify: 'verifying',
    plan: '',
    refine: '',
    learn: '',
    skill: '',
    triage: '',
  } as const;
  if (task.phase !== stages[record.kind]) {
    return;
  }
  if (record.kind !== 'develop' && (task.head !== record.head || task.base !== record.base)) {
    return;
  }
  if (result.outcome !== 'success') {
    await rejectDelivery(context, task, [result.summary, ...result.findings].join('\n'));
    return;
  }
  switch (record.kind) {
    case 'develop': {
      await completeDevelopment(context, record, task, { signal, summary: result.summary });
      break;
    }
    case 'review': {
      completeReview(context, record, task, result);
      break;
    }
    case 'final': {
      completeFinal(context, record, task, result);
      break;
    }
    case 'verify': {
      completeVerification(context, record, task, { execution, result });
      break;
    }
  }
}

/**
 * Save product-owner refinement or the independent lead's atomic plan.
 *
 * @param context - Project ledger.
 * @param job - Product or lead role.
 * @param result - Reviewed plan or precise scope blocker.
 * @throws {Error} For invalid project state or failed execution.
 */
function completePlan(context: FactoryContext, job: FactoryJob, result: AgentResult): void {
  const record = job;
  const feature = context.repository.features().find((candidate) => candidate.id === record.featureId);
  if (feature === undefined) {
    throw new MeshError('NOT_FOUND', 'The product request no longer exists.');
  }
  if (feature.scopeReplacement !== undefined) {
    return;
  }
  if (result.outcome !== 'success') {
    context.repository.saveFeature({
      ...feature,
      phase: 'blocked',
      error: [result.summary, ...result.findings].join('\n'),
      updatedAt: context.repository.store.now(),
    });
    context.repository.notify(`Product owner / lead clarification required: ${result.summary}`);
    return;
  }
  validatePlan(result);
  context.repository.saveFeature({
    ...feature,
    phase: record.kind === 'plan' ? 'refining' : 'provisioning',
    productPlan: record.kind === 'plan' ? result : feature.productPlan,
    plan: record.kind === 'refine' ? result : feature.plan,
    error: null,
    updatedAt: context.repository.store.now(),
  });
}

/**
 * Publish tested code into an unpaid, retryable PR-creation stage.
 *
 * @param context - Project Git and test services.
 * @param job - Responsible developer attempt.
 * @param task - Its owned branch.
 * @param evidence - Cancellation and validated developer handoff.
 */
async function completeDevelopment(
  context: FactoryContext,
  job: FactoryJob,
  task: FactoryTask,
  evidence: { signal: AbortSignal; summary: string },
): Promise<void> {
  const record = task;
  const { signal } = evidence;
  if (record.worktree === null) {
    throw new MeshError('FACTORY_GATED', 'The developer worktree is missing.');
  }
  const { worktree } = record;
  try {
    await context.workspaces.publish(record, async (source) => {
      signal.throwIfAborted();
      const snapshot = await context.workspaces.snapshot(worktree);
      await runChecks(context, job, { cwd: worktree, stage: 'test', signal });
      await context.workspaces.assertUnchanged(snapshot);
      signal.throwIfAborted();
      const claim = context.repository.jobs().find((candidate) => candidate.id === job.id);
      if (claim?.state !== 'running' || claim.token !== job.token) {
        throw new MeshError('FACTORY_GATED', 'The developer claim expired before publication.');
      }
      context.repository.store.transaction(() => {
        context.repository.editTask(record.id, (current) => {
          if (current.phase !== 'development' || current.version !== record.version || current.developer !== job.role) {
            throw new MeshError('FACTORY_GATED', 'The delivery changed or stopped before publication.');
          }
          return {
            ...current,
            phase: 'publishing',
            head: source.head,
            base: source.base,
            reviews: [],
            finalReview: null,
            error: null,
          };
        });
        queueDevelopmentComment(context, record.id, job.role, evidence.summary);
      });
    });
  } catch (error) {
    if (!(error instanceof PublicationSizeError)) {
      throw error;
    }
    signal.throwIfAborted();
    context.repository.instructionLedger.validate(job, []);
    context.repository.editTask(record.id, (current) => {
      if (
        current.phase !== 'publishing' ||
        current.head !== error.measured.head ||
        current.base !== error.measured.base
      ) {
        throw new MeshError('FACTORY_GATED', 'The validated publication changed before its size decision.');
      }
      return {
        ...current,
        phase: 'blocked',
        publicationGate: error.measured,
        error: error.message,
        reviews: [],
        finalReview: null,
      };
    });
  }
}

/**
 * Accept only the current immutable head/base from an independent QA role.
 *
 * @param context - Current task and GitHub evidence.
 * @param job - Independent QA claim.
 * @param task - Delivery at completion time.
 * @param result - Successful adversarial review.
 */
function completeReview(context: FactoryContext, job: FactoryJob, task: FactoryTask, result: AgentResult): void {
  const record = task;
  if (
    record.phase !== 'review' ||
    record.head !== job.head ||
    record.base !== job.base ||
    record.pr === null ||
    (job.role !== 'qa-1' && job.role !== 'qa-2')
  ) {
    return;
  }
  const { role } = job;
  const reviewed = context.repository.editTask(record.id, (current) => {
    const updated = {
      ...current,
      reviews: [
        ...current.reviews.filter((review) => review.role !== role),
        {
          role,
          head: job.head ?? '',
          base: job.base ?? '',
          outcome: 'success' as const,
          summary: result.summary,
          jobId: job.id,
        },
      ],
      error: null,
    };
    return { ...updated, phase: hasApprovals(updated) ? 'merge_ready' : 'review' };
  });
  queueComment(
    context,
    reviewed,
    `${role} approved head ${job.head ?? ''} against base ${job.base ?? ''}.\n\n${result.summary}`,
  );
}

/**
 * Save final end-to-end approval as a durable merge intent, never merge here.
 *
 * @param context - Task ledger.
 * @param job - Final independent check.
 * @param task - Exact reviewed source.
 * @param result - Final acceptance.
 * @throws {MeshError} For stale or missing QA evidence.
 */
function completeFinal(context: FactoryContext, job: FactoryJob, task: FactoryTask, result: AgentResult): void {
  const record = task;
  if (
    !hasApprovals(record) ||
    record.head !== job.head ||
    record.base !== job.base ||
    record.head === null ||
    record.base === null
  ) {
    throw new MeshError('FACTORY_GATED', 'The final approval no longer covers two current independent QA approvals.');
  }
  context.repository.editTask(record.id, (current) => {
    return {
      ...current,
      phase: 'merging',
      finalReview: { head: record.head ?? '', base: record.base ?? '', jobId: job.id, summary: result.summary },
      error: null,
    };
  });
}

/**
 * Close a delivery only after actual merged-main verification remains current.
 *
 * @param context - Project verification services.
 * @param job - Merged-main final role.
 * @param task - Confirmed merged delivery.
 * @param evidence - Validated evidence input.
 * @throws {MeshError} When main advances before verification completes.
 */
function completeVerification(
  context: FactoryContext,
  job: FactoryJob,
  task: FactoryTask,
  evidence: { execution: ExecutedJob; result: AgentResult },
): void {
  const record = task;
  const { execution, result } = evidence;
  if (execution.snapshot === null || record.merge === null) {
    throw new MeshError('FACTORY_GATED', 'No merged-main snapshot was verified.');
  }
  context.repository.editTask(record.id, (delivery) => {
    return {
      ...delivery,
      phase: 'closing',
      error: null,
      verifiedMain: { head: execution.snapshot?.head ?? '', jobId: job.id, summary: result.summary },
    };
  });
}

/**
 * Queue researched skill changes for a separate lead process to review.
 *
 * @param context - Project skill ledger.
 * @param result - Learning steward's bounded proposals.
 */
function completeLearning(context: FactoryContext, result: AgentResult): void {
  for (const action of result.skillActions) {
    context.learning.candidateEvidence(action);
    if (
      context.repository
        .skillRequests()
        .some(
          (request) =>
            request.name === action.name && request.revision === action.revision && request.state === action.state,
        )
    ) {
      continue;
    }
    context.repository.saveSkillRequest({
      ...action,
      id: randomUUID(),
      status: 'pending',
      previousRevision: context.learning.skillLibrary().find((entry) => entry.name === action.name)?.revision ?? null,
      requestedAt: context.repository.store.now(),
      reviewedAt: null,
      summary: null,
    });
  }
  if (result.deliveries.length === 0) {
    return;
  }

  validatePlan(result);
  context.repository.saveFeature({
    id: randomUUID(),
    objective: `Evidence-based tooling improvement: ${result.summary}`,
    phase: 'queued',
    productPlan: null,
    plan: null,
    parentIssue: null,
    error: null,
    createdAt: context.repository.store.now(),
    updatedAt: context.repository.store.now(),
    approvals: [],
  });
}

/**
 * Apply a researched skill only after a separate lead process approves it.
 *
 * @param context - Project learning and lead-decision ledger.
 * @param job - Independent lead assignment.
 * @param result - Lead review outcome.
 */
function completeSkillReview(context: FactoryContext, job: FactoryJob, result: AgentResult): void {
  const record = result;
  const request = context.repository.skillRequests().find((candidate) => candidate.id === job.target);
  if (request?.status !== 'pending') {
    return;
  }
  context.repository.saveSkillRequest({
    ...request,
    status: record.outcome === 'success' ? 'awaiting_operator' : 'rejected',
    reviewedAt: context.repository.store.now(),
    leadSummary: [record.summary, ...record.findings].join('\n'),
    summary: [record.summary, ...record.findings].join('\n'),
  });
  context.repository.notify(
    `Project skill ${request.name}: ${record.outcome === 'success' ? 'awaiting human approval; current skills remain unchanged' : 'returned to the learning steward'}. ${record.summary}`,
  );
}
