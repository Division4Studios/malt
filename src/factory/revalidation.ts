/**
 * Brief revalidation for bound predecessors. A plan is made against one
 * version of main; by the time a dependent delivery may start, its
 * predecessors have merged real code that may differ from what the plan
 * assumed. When the project enables `briefRevalidation`, the team lead
 * rechecks the dependent brief on current main before implementation, once
 * per set of predecessor merges. A confirmed brief starts implementation; a
 * brief that needs revising stops the delivery with the lead's findings, and
 * the operator either retries it unchanged or replans its scope through the
 * existing instruction path.
 *
 * @file
 */

import { logObjective } from './objective-log.ts';
import { deliveryFocus } from './objective-queue-schema.ts';
import { isBackingOff } from './retry-policy.ts';
import { REVALIDATION_TEXT_MAX } from './revalidation-schema.ts';
import { sealedHead } from './source-reader.ts';
import { issueLabel } from './tracker-key.ts';

import type { FactoryContext } from './context.ts';
import type { FactoryRepository } from './repository.ts';
import type { Predecessor, Revalidation } from './revalidation-schema.ts';
import type { JobIntent } from './scheduler.ts';
import type { AgentResult, FactoryConfig, FactoryJob, FactoryTask, Feature } from './schema.ts';

/** Phases in which a delivery has not started implementation. */
const UNSTARTED_PHASES: ReadonlySet<string> = new Set(['ready', 'development']);
/** Bound a predecessor's merged summary in evidence. */
const SUMMARY_MAX = 1500;
/** Bound findings kept on a verdict. */
const MAX_FINDINGS = 20;

/**
 * The delivery's predecessors once every one of them is done.
 *
 * @param task - Dependent delivery.
 * @param tasks - Every delivery.
 * @returns Predecessors in dependency order, or `null` while any is unfinished.
 */
export function predecessorsOf(task: FactoryTask, tasks: readonly FactoryTask[]): Predecessor[] | null {
  const byId = new Map(tasks.map((candidate) => [candidate.id, candidate]));
  const found: Predecessor[] = [];
  for (const id of task.dependencies) {
    const dependency = byId.get(id);
    if (dependency?.phase !== 'done') {
      return null;
    }
    found.push({ taskId: dependency.id, issue: dependency.issue, merge: dependency.merge });
  }
  return found;
}

/**
 * Whether a recorded verdict judged exactly these predecessor merges.
 *
 * @param record - Recorded verdict, if any.
 * @param predecessors - Current predecessors.
 * @returns True when nothing merged since the verdict.
 */
function isJudged(record: Revalidation | null, predecessors: readonly Predecessor[]): boolean {
  const key = (list: readonly Predecessor[]): string => {
    return list
      .map((entry) => `${entry.taskId}:${entry.merge ?? ''}`)
      .toSorted((left, right) => left.localeCompare(right))
      .join(',');
  };
  return record !== null && key(record.predecessors) === key(predecessors);
}

/**
 * Whether a delivery must be revalidated before implementation starts.
 *
 * @param task - Candidate delivery.
 * @param tasks - Every delivery, for its predecessors.
 * @param config - Project settings.
 * @returns True while revalidation is enabled, due and not yet recorded.
 */
export function isRevalidationDue(
  task: FactoryTask,
  tasks: readonly FactoryTask[],
  config: Pick<FactoryConfig, 'briefRevalidation'>,
): boolean {
  if (
    !config.briefRevalidation ||
    task.dependencies.length === 0 ||
    !UNSTARTED_PHASES.has(task.phase) ||
    task.developer !== null ||
    task.head !== null ||
    task.scopeReplacement !== undefined
  ) {
    return false;
  }
  const predecessors = predecessorsOf(task, tasks);
  return predecessors !== null && !isJudged(task.revalidation, predecessors);
}

/**
 * The lead's next revalidation, when one is due and the lead is free.
 *
 * @param input - Durable scheduling state.
 * @param input.config - Project settings.
 * @param input.tasks - Every delivery.
 * @param input.jobs - Every recent attempt, for backoff.
 * @param input.now - Current time.
 * @param live - Running attempts.
 * @returns At most one intent.
 */
export function revalidationIntents(
  input: {
    config: FactoryConfig;
    tasks: readonly FactoryTask[];
    jobs: readonly FactoryJob[];
    now: number;
    isSpendBlocked?: (target: { readonly taskId: string | null; readonly featureId: string | null }) => boolean;
    objectiveQueue?: { readonly focusedFeatureId: string | null; readonly existingOnly?: boolean };
  },
  live: readonly FactoryJob[],
): JobIntent[] {
  if (!input.config.briefRevalidation || live.some((job) => job.role === 'team-lead')) {
    return [];
  }
  const timing = { now: input.now, reconcileMs: input.config.reconcileMs };
  const task = input.tasks.find((candidate) => {
    const scope = {
      kind: 'revalidate' as const,
      taskId: candidate.id,
      featureId: candidate.featureId,
      head: null,
      since: candidate.repairsResetAt,
    };
    // Admission filters apply before choosing: an unfocused or spend-blocked delivery must not hold the only slot.
    const focused = deliveryFocus(input.objectiveQueue);
    return (
      isRevalidationDue(candidate, input.tasks, input.config) &&
      candidate.hold === null &&
      (focused === null || candidate.featureId === focused) &&
      input.isSpendBlocked?.({ taskId: candidate.id, featureId: candidate.featureId }) !== true &&
      live.every((job) => job.taskId !== candidate.id) &&
      !isBackingOff(input.jobs, { ...scope, step: null }, timing)
    );
  });
  return task === undefined
    ? []
    : [
        {
          role: 'team-lead',
          kind: 'revalidate',
          taskId: task.id,
          featureId: task.featureId,
          head: null,
          base: null,
          step: null,
        },
      ];
}

/**
 * The source the objective's plan was made against.
 *
 * @param feature - Owning objective.
 * @returns Latest plan or revision source, when recorded.
 */
function plannedAgainst(feature: Feature | undefined): string | null {
  return (
    (feature?.planOutputs ?? []).findLast((output) => output.kind !== 'specify' && output.source !== null)?.source ??
    null
  );
}

/**
 * What the lead reads about one predecessor.
 *
 * @param dependency - Merged predecessor, if still known.
 * @returns Its issue, brief, merge and merged summary.
 */
function predecessorEvidence(dependency: FactoryTask | undefined): unknown {
  if (dependency === undefined) {
    return null;
  }
  const merged = dependency.verifiedMain?.summary ?? dependency.finalReview?.summary ?? '';
  return {
    issue: dependency.issue,
    title: dependency.title,
    acceptanceCriteria: dependency.acceptanceCriteria,
    merge: dependency.merge,
    prUrl: dependency.prUrl,
    mergedSummary: merged.slice(0, SUMMARY_MAX),
  };
}

/**
 * What the lead reads to revalidate a brief.
 *
 * @param repository - Project ledger.
 * @param task - Dependent delivery.
 * @returns Planned source and each predecessor's merged outcome.
 */
export function revalidationEvidence(repository: FactoryRepository, task: FactoryTask): unknown {
  const tasks = repository.tasks();
  const feature = repository.features().find((candidate) => candidate.id === task.featureId);
  const byId = new Map(tasks.map((candidate) => [candidate.id, candidate]));
  return {
    plannedAgainst: plannedAgainst(feature),
    predecessors: task.dependencies.map((id) => predecessorEvidence(byId.get(id))),
  };
}

/**
 * Apply the lead's verdict on a dependent brief.
 *
 * @param context - Project ledger.
 * @param job - Fenced revalidation attempt.
 * @param result - Structured result; success confirms the brief.
 */
export function completeRevalidation(context: FactoryContext, job: FactoryJob, result: AgentResult): void {
  const { repository } = context;
  if (job.taskId === null) {
    return;
  }
  const tasks = repository.tasks();
  const task = tasks.find((candidate) => candidate.id === job.taskId);
  const predecessors = task === undefined ? null : predecessorsOf(task, tasks);
  if (task === undefined || predecessors === null || !isRevalidationDue(task, tasks, { briefRevalidation: true })) {
    return;
  }
  const isConfirmed = result.outcome === 'success';
  const feature = repository.features().find((candidate) => candidate.id === task.featureId);
  const record: Revalidation = {
    schemaVersion: 1,
    jobId: job.id,
    source: sealedHead(repository.store, job.id),
    plannedAgainst: plannedAgainst(feature),
    predecessors,
    outcome: isConfirmed ? 'confirmed' : 'revise',
    // A provider result may be longer than the recorded verdict allows; keep the verdict, bounded.
    summary: result.summary.slice(0, REVALIDATION_TEXT_MAX),
    findings: result.findings.slice(0, MAX_FINDINGS).map((finding) => finding.slice(0, REVALIDATION_TEXT_MAX)),
    at: repository.store.now(),
  };
  const reason = [`Brief revalidation proposes changes: ${result.summary}`, ...record.findings].join('\n');
  repository.editTask(task.id, (current) => {
    return isConfirmed
      ? { ...current, revalidation: record }
      : { ...current, revalidation: record, phase: 'blocked', error: reason };
  });
  logObjective(repository.store, task.featureId, {
    kind: 'plan',
    actor: job.role,
    body: `Brief of ${issueLabel(task)} ${isConfirmed ? 'confirmed' : 'needs revising'} after its predecessors merged. ${result.summary}`,
  });
  if (!isConfirmed) {
    repository.notify(`Delivery ${issueLabel(task)} needs a brief decision: ${result.summary}`);
  }
}
