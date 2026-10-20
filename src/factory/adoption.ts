/**
 * Operator-only, unpaid reconciliation of the factory ledger with GitHub. Closed
 * issues are adopted as done and finished objectives are retired without a model job.
 *
 * @file
 */
import { createHash } from 'node:crypto';

import { MeshError } from '../protocol.ts';

import { OPERATOR_ADOPTED } from './adoption-schema.ts';
import { recoverObjective } from './recovery.ts';
import { factorySchemas } from './schema.ts';
import { formatTrackerKey, issueKey, issueLabel, objectiveParentKey } from './tracker-key.ts';
import { decideTriage, decisionById } from './triage.ts';

import type { FactoryContext } from './context.ts';
import type { FactoryRepository } from './repository.ts';
import type { FactoryJob, FactoryTask, Feature } from './schema.ts';
import type { TriageDecision } from './triage.ts';

/** GitHub close reasons that never represent a delivery. */
const UNDELIVERED: ReadonlySet<string> = new Set(['not_planned', 'duplicate']);

/** One proposed operator decision file. */
interface Proposal {
  /** Operation that accepts the input file. */
  readonly operation: 'factory_triage' | 'factory_recover';
  /** Delivery or parent issue re-read from GitHub. */
  readonly issue: number;
  /** GitHub close reason. */
  readonly closedAs: string;
  /** Exact fenced input for factory-triage or factory-recover. */
  readonly input: Record<string, unknown>;
}

/** An applied proposal's receipt or rejection. */
type Outcome = Proposal & { readonly result?: unknown; readonly error?: string };

/** An issue that could not be read or needs an explicit operator decision. */
interface Unresolved {
  /** Delivery or parent issue. */
  readonly issue: number;
  /** Reason no proposal was made. */
  readonly error: string;
}

/** Dry-run or applied reconciliation report. */
export interface ReconcileReport {
  /** Whether decisions were applied. */
  readonly applied: boolean;
  /** Every proposed decision with current versions. */
  readonly proposals: readonly Proposal[];
  /** Results of the applied batch. */
  readonly outcomes: readonly Outcome[];
  /** Issues without a proposal that need attention. */
  readonly unresolved: readonly Unresolved[];
  /** Proposals left for another applied batch. */
  readonly remaining: number;
}

/**
 * Describe an error without leaking non-error values.
 *
 * @param error - Caught value.
 * @returns Operator-visible message.
 */
function message(error: unknown): string {
  return Error.isError(error) ? error.message : 'GitHub reconciliation failed.';
}

/**
 * Derive a stable request identity so repeated applies of one revision replay instead of duplicating.
 *
 * @param key - Decision and revision key.
 * @returns RFC 4122 name-based UUID.
 */
function stableId(key: string): string {
  const hex = createHash('sha256').update(`malt-reconcile:${key}`).digest('hex');
  const parts = /^(?<a>.{8})(?<b>.{4}).(?<c>.{3}).(?<d>.{3})(?<e>.{12})/v.exec(hex)?.groups ?? {};
  return `${parts['a'] ?? ''}-${parts['b'] ?? ''}-5${parts['c'] ?? ''}-8${parts['d'] ?? ''}-${parts['e'] ?? ''}`;
}

/**
 * Move an operator-adopted closing delivery to done; its merge must remain contained in the recorded main head.
 *
 * @param context - Project ledger and Git.
 * @param task - Closing delivery with operator proof.
 */
export async function closeAdopted(context: FactoryContext, task: FactoryTask): Promise<void> {
  const proof = task.verifiedMain;
  if (task.phase !== 'closing' || proof?.jobId !== OPERATOR_ADOPTED) {
    return;
  }
  if (task.merge !== null) {
    await context.workspaces.contains(task.merge, proof.head);
  }
  if (context.repository.task(task.id).version === task.version) {
    context.repository.editTask(task.id, (current) => ({ ...current, phase: 'done', error: null }));
  }
}

/**
 * Adopt one closed issue as done after re-reading GitHub and main. No job is created.
 *
 * @param context - Project services.
 * @param input - Exact triage decision.
 * @param actorId - Attached agent identity; only the operator (null) may adopt.
 * @returns Durable triage receipt.
 * @throws {MeshError} When the issue is open, the merge is not on main or the request is stale.
 */
export async function adoptDeliveredIssue(
  context: FactoryContext,
  input: unknown,
  actorId: string | null,
): Promise<TriageDecision> {
  const value = factorySchemas.factory_triage.parse(input);
  const { repository } = context;
  if (actorId !== null || decisionById(repository, value.requestId) !== undefined) {
    return decideTriage(repository, value, actorId);
  }
  const task = repository.task(value.taskId);
  if (task.version !== value.expectedVersion) {
    throw new MeshError('FACTORY_GATED', 'The delivery changed. Refresh its evidence before deciding.');
  }
  if (value.mergeCommit !== undefined && task.merge !== null && task.merge !== value.mergeCommit) {
    throw new MeshError('FACTORY_GATED', `This delivery already records merge ${task.merge}.`);
  }
  const issue = await context.remote.issueState(issueKey(task));
  if (issue.state !== 'closed') {
    throw new MeshError('FACTORY_GATED', `Issue ${issueLabel(task)} is still open; adopt only closed issues.`);
  }
  const reason = issue.stateReason ?? 'completed';
  const isDelivered = !UNDELIVERED.has(reason);
  const merge = value.mergeCommit ?? task.merge;
  if (!isDelivered && merge !== null) {
    throw new MeshError('FACTORY_GATED', `Issue was closed as ${reason}; a merge cannot be adopted as its delivery.`);
  }
  const head = await context.workspaces.base();
  if (merge !== null) {
    await context.workspaces.contains(merge, head);
  }
  const receipt = decideTriage(repository, value, actorId, { head, merge, reason, isDelivered });
  await closeAdopted(context, repository.task(task.id));
  return receipt;
}

/**
 * Retire a queued or active objective whose parent issue is closed. GitHub is only read.
 *
 * @param context - Project services.
 * @param input - Exact recovery decision with action retire.
 * @param actorId - Attached agent identity; only the operator (null) may retire.
 * @returns Stable recovery receipt.
 * @throws {MeshError} For agents, an open parent or a stale objective.
 */
export async function retireObjective(
  context: FactoryContext,
  input: unknown,
  actorId: string | null,
): Promise<{ featureId: string }> {
  if (actorId !== null) {
    throw new MeshError('NOT_ORCHESTRATOR', 'Only the human operator may retire an objective.');
  }
  const value = factorySchemas.factory_recover.parse(input);
  const feature = context.repository.features().find((item) => item.id === value.featureId);
  const parent = feature === undefined ? null : objectiveParentKey(feature);
  if (parent === null || feature?.updatedAt !== value.expectedUpdatedAt) {
    // Replays an exact receipt, or rejects the stale or parentless request without GitHub I/O.
    return recoverObjective(context.repository, value);
  }
  const issue = await context.remote.issueState(parent);
  if (issue.state !== 'closed') {
    throw new MeshError('FACTORY_GATED', `Parent issue ${formatTrackerKey(parent)} is still open.`);
  }
  return recoverObjective(context.repository, value, feature.parentIssue);
}

/**
 * Route triage, adopting delivered issues only after asynchronous GitHub and main evidence.
 *
 * @param repository - Project ledger.
 * @param context - Lazily configured project services.
 * @param input - Untrusted triage control.
 * @param actorId - Attached agent identity; null denotes the operator.
 * @returns Durable receipt.
 */
export async function triageControl(
  repository: FactoryRepository,
  context: () => FactoryContext,
  input: unknown,
  actorId: string | null,
): Promise<TriageDecision> {
  const value = factorySchemas.factory_triage.parse(input);
  return actorId === null && value.action === 'adopt_delivered'
    ? adoptDeliveredIssue(context(), value, actorId)
    : decideTriage(repository, value, actorId);
}

/**
 * Route recovery, re-reading the parent issue only to retire.
 *
 * @param repository - Project ledger.
 * @param context - Lazily configured project services.
 * @param input - Untrusted recovery control.
 * @param actorId - Attached agent identity; null denotes the operator.
 * @returns Stable recovery receipt.
 */
export async function recoverControl(
  repository: FactoryRepository,
  context: () => FactoryContext,
  input: unknown,
  actorId: string | null,
): Promise<{ featureId: string }> {
  const value = factorySchemas.factory_recover.parse(input);
  return value.action === 'retire' ? retireObjective(context(), value, actorId) : recoverObjective(repository, value);
}

/**
 * Propose adoption of one unfinished delivery whose issue is closed.
 *
 * @param context - Project services.
 * @param task - Current delivery revision.
 * @returns Proposal, or null while the issue is open.
 * @throws {MeshError} When the closure contradicts a recorded merge.
 */
async function taskProposal(context: FactoryContext, task: FactoryTask): Promise<Proposal | null> {
  const issue = await context.remote.issueState(issueKey(task));
  if (issue.state !== 'closed') {
    return null;
  }
  const reason = issue.stateReason ?? 'completed';
  const isDelivered = !UNDELIVERED.has(reason);
  if (!isDelivered && task.merge !== null) {
    throw new MeshError('FACTORY_GATED', `Closed as ${reason} but records merge ${task.merge}; decide explicitly.`);
  }
  let { merge } = task;
  if (isDelivered && merge === null && task.pr !== null) {
    const pr = await context.remote.inspect(task.pr);
    merge = pr.state === 'MERGED' ? (pr.mergeCommit?.oid ?? null) : null;
  }
  const evidence = merge === null ? '' : ` Merge ${merge} must be contained in main.`;
  return {
    operation: 'factory_triage',
    issue: task.issue,
    closedAs: reason,
    input: {
      requestId: stableId(`adopt_delivered:${task.id}:${String(task.version)}`),
      taskId: task.id,
      expectedVersion: task.version,
      action: 'adopt_delivered',
      note: `GitHub reconciliation: issue ${issueLabel(task)} is closed as ${reason}.${evidence}`,
      ...(merge !== null && merge !== task.merge && { mergeCommit: merge }),
    },
  };
}

/**
 * Propose retirement of an objective whose deliveries are finished and whose parent issue is closed.
 *
 * @param context - Project services.
 * @param feature - Current objective revision.
 * @param adopted - Deliveries proposed for adoption in this batch.
 * @returns Proposal, or null when it is not eligible.
 */
async function featureProposal(
  context: FactoryContext,
  feature: Feature,
  adopted: ReadonlySet<string>,
): Promise<Proposal | null> {
  const tasks = context.repository.tasks().filter((task) => task.featureId === feature.id);
  const isBusy = context.repository
    .jobs()
    .some(
      (job) =>
        job.state === 'running' && (job.featureId === feature.id || tasks.some((task) => task.id === job.taskId)),
    );
  if (
    isBusy ||
    feature.parentIssue === null ||
    feature.scopeReplacement !== undefined ||
    !['queued', 'active'].includes(feature.phase) ||
    tasks.some((task) => task.phase !== 'done' && task.scopeReplacement === undefined && !adopted.has(task.id))
  ) {
    return null;
  }
  const parent = objectiveParentKey(feature);
  if (parent === null) {
    return null;
  }
  const issue = await context.remote.issueState(parent);
  if (issue.state !== 'closed') {
    return null;
  }
  const reason = issue.stateReason ?? 'completed';
  return {
    operation: 'factory_recover',
    issue: feature.parentIssue,
    closedAs: reason,
    input: {
      requestId: stableId(`retire:${feature.id}:${String(feature.updatedAt)}`),
      featureId: feature.id,
      expectedUpdatedAt: feature.updatedAt,
      action: 'retire',
      note: `GitHub reconciliation: parent issue ${formatTrackerKey(parent)} is closed as ${reason}.`,
    },
  };
}

/**
 * Whether a delivery may be proposed for adoption without disturbing live or already-proven work.
 *
 * @param task - Current delivery.
 * @param running - Running assignments.
 * @returns Whether its issue should be re-read.
 */
function isCandidate(task: FactoryTask, running: readonly FactoryJob[]): boolean {
  const isProven = task.phase === 'closing' && task.verifiedMain !== null;
  return (
    !isProven &&
    task.phase !== 'done' &&
    task.scopeReplacement === undefined &&
    running.every((job) => job.taskId !== task.id)
  );
}

/**
 * Read GitHub for every unfinished delivery and objective, serially.
 *
 * @param context - Project services.
 * @returns Ordered proposals (adoptions before retirements) and unresolved issues.
 */
async function propose(context: FactoryContext): Promise<{ proposals: Proposal[]; unresolved: Unresolved[] }> {
  const { repository } = context;
  const running = repository.jobs().filter((job) => job.state === 'running');
  const proposals: Proposal[] = [];
  const unresolved: Unresolved[] = [];
  const adopted = new Set<string>();
  for (const task of repository.tasks()) {
    if (!isCandidate(task, running)) {
      continue;
    }
    try {
      // eslint-disable-next-line no-await-in-loop -- GitHub reads are serialized to respect API rate limits.
      const proposal = await taskProposal(context, task);
      if (proposal !== null) {
        proposals.push(proposal);
        adopted.add(task.id);
      }
    } catch (error) {
      unresolved.push({ issue: task.issue, error: message(error) });
    }
  }
  for (const feature of repository.features()) {
    try {
      // eslint-disable-next-line no-await-in-loop -- GitHub reads are serialized to respect API rate limits.
      const proposal = await featureProposal(context, feature, adopted);
      if (proposal !== null) {
        proposals.push(proposal);
      }
    } catch (error) {
      unresolved.push({ issue: feature.parentIssue ?? 0, error: message(error) });
    }
  }
  return { proposals, unresolved };
}

/**
 * Read GitHub issue and PR state and propose fenced decisions; apply a bounded batch only when asked.
 *
 * @param context - Project services.
 * @param input - Untrusted reconcile control.
 * @returns Proposals, applied outcomes and unresolved issues.
 */
export async function reconcileGitHub(context: FactoryContext, input: unknown): Promise<ReconcileReport> {
  const value = factorySchemas.factory_reconcile_github.parse(input);
  const { proposals, unresolved } = await propose(context);
  if (!value.apply) {
    return { applied: false, proposals, outcomes: [], unresolved, remaining: proposals.length };
  }
  const batch = proposals.slice(0, value.limit);
  const outcomes: Outcome[] = [];
  for (const proposal of batch) {
    try {
      const result =
        proposal.operation === 'factory_triage'
          ? // eslint-disable-next-line no-await-in-loop -- Decisions apply in order so adoptions precede retirements.
            await adoptDeliveredIssue(context, proposal.input, null)
          : // eslint-disable-next-line no-await-in-loop -- Decisions apply in order so adoptions precede retirements.
            await retireObjective(context, proposal.input, null);
      outcomes.push({ ...proposal, result });
    } catch (error) {
      outcomes.push({ ...proposal, error: message(error) });
    }
  }
  return { applied: true, proposals, outcomes, unresolved, remaining: proposals.length - batch.length };
}
