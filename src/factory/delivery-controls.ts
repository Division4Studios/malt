/**
 * Operator controls over individual deliveries. A hold stops new attempts on
 * a delivery without interrupting one already running; resuming clears it.
 * Finished deliveries leave the board a week after they finish, or at once
 * when archived; unarchiving keeps one on the board for good. Every control
 * accepts several deliveries, one objective or all of them in one
 * transaction, so bulk actions need no separate code path.
 *
 * @file
 */
import { MeshError } from '../protocol.ts';

import { archiveRequestSchema, holdRequestSchema } from './delivery-control-schema.ts';
import { spendGate } from './spend.ts';
import { isCurrentTriage } from './triage.ts';

import type { ArchiveRequest, HoldRequest } from './delivery-control-schema.ts';
import type { FactoryRepository } from './repository.ts';
import type { FactoryJob, FactoryTask } from './schema.ts';

/** Finished deliveries archive themselves after this long (seven days) unless kept. */
export const AUTO_ARCHIVE_MS = 604_800_000;

/** What one control request changed. */
export interface ControlResult {
  /** Deliveries whose state changed. */
  readonly changed: number;
  /** Named deliveries the control does not apply to, with the reason. */
  readonly skipped: readonly { readonly taskId: string; readonly reason: string }[];
}

/**
 * Whether a delivery is off the board: archived by the operator, or finished
 * for longer than the automatic archive delay without being kept.
 *
 * @param task - Delivery to place.
 * @param now - Current time.
 * @returns True when the board hides it.
 */
export function isArchived(task: FactoryTask, now: number): boolean {
  return task.archive === null
    ? task.phase === 'done' && now - task.updatedAt >= AUTO_ARCHIVE_MS
    : task.archive.state === 'archived';
}

/**
 * Whether new attempts may start on a delivery: it is neither replaced by a
 * scope change nor held by the operator.
 *
 * @param task - Delivery a proposed attempt would work on.
 * @returns True when an attempt may be admitted.
 */
export function isAdmissible(task: FactoryTask): boolean {
  return task.scopeReplacement === undefined && task.hold === null;
}

/**
 * Fence superseded, out-of-focus, held and over-budget work inside the same
 * transaction as role admission, so a hold or reached spend cap after
 * scheduling still stops the claim.
 *
 * @param repository - Project ledger, inside the admission transaction.
 * @param job - Proposed claim.
 * @returns Whether its scope is still eligible.
 */
export function isClaimEligible(repository: FactoryRepository, job: FactoryJob): boolean {
  const queue = repository.objectiveQueue.read();
  const focus = queue.focusedFeatureId;
  return (
    (job.kind !== 'triage' || isCurrentTriage(repository, job)) &&
    (queue.existingOnly ? job.taskId !== null : focus === null || job.featureId === focus) &&
    (job.taskId === null || isAdmissible(repository.task(job.taskId))) &&
    spendGate(repository).block(job) === null
  );
}

/**
 * The live deliveries a request selects.
 *
 * @param repository - Project ledger.
 * @param request - Parsed selector.
 * @returns Selected deliveries and whether they were named one by one.
 * @throws {MeshError} When the selector is ambiguous or names an unknown delivery.
 */
function selected(
  repository: FactoryRepository,
  request: HoldRequest | ArchiveRequest,
): { tasks: FactoryTask[]; isNamed: boolean } {
  const selectors = [request.taskIds, request.featureId, request.all].filter((value) => value !== undefined);
  if (selectors.length !== 1) {
    throw new MeshError('INVALID_INPUT', 'Name deliveries, one objective, or all deliveries: exactly one of them.');
  }
  const tasks = repository.tasks().filter((task) => task.scopeReplacement === undefined);
  if (request.taskIds === undefined) {
    const { featureId } = request;
    return {
      tasks: featureId === undefined ? tasks : tasks.filter((task) => task.featureId === featureId),
      isNamed: false,
    };
  }
  const wanted = new Set(request.taskIds);
  const found = tasks.filter((task) => wanted.has(task.id));
  if (found.length !== wanted.size) {
    throw new MeshError('NOT_FOUND', 'Some named deliveries are not in this project. Refresh and try again.');
  }
  return { tasks: found, isNamed: true };
}

/**
 * Apply one change to every eligible selected delivery in a transaction.
 *
 * @param repository - Project ledger.
 * @param request - Parsed selector.
 * @param rule - Why a delivery is ineligible (or `null`), whether it already
 *   has the requested state, and the edit to apply.
 * @param rule.ineligible - Reason a delivery cannot take the change, or `null`.
 * @param rule.isCurrent - Whether a delivery already has the requested state.
 * @param rule.edit - The change for an eligible delivery.
 * @returns Changed count and skipped named deliveries.
 */
function applyControl(
  repository: FactoryRepository,
  request: HoldRequest | ArchiveRequest,
  rule: {
    ineligible: (task: FactoryTask) => string | null;
    isCurrent: (task: FactoryTask) => boolean;
    edit: (task: FactoryTask, now: number) => FactoryTask;
  },
): ControlResult {
  return repository.store.transaction(() => {
    const { tasks, isNamed } = selected(repository, request);
    const now = repository.store.now();
    const skipped: { taskId: string; reason: string }[] = [];
    let changed = 0;
    for (const task of tasks) {
      const reason = rule.ineligible(task);
      if (reason !== null) {
        if (isNamed) {
          skipped.push({ taskId: task.id, reason });
        }
      } else if (!rule.isCurrent(task)) {
        // Marks leave the version alone, so an attempt already running finishes and publishes normally.
        repository.markTask(task.id, (current) => rule.edit(current, now));
        changed += 1;
      }
    }
    return { changed, skipped };
  });
}

/**
 * Handle `factory_hold`: hold or resume deliveries.
 *
 * @param repository - Selected project ledger.
 * @param input - Untrusted request.
 * @returns What changed.
 */
export function holdDeliveries(repository: FactoryRepository, input: unknown): ControlResult {
  const request = holdRequestSchema.parse(input);
  const result = applyControl(repository, request, {
    ineligible: (task) => (task.phase === 'done' ? 'Already finished.' : null),
    isCurrent: (task) => (task.hold !== null) === request.hold,
    edit: (task, now) => ({ ...task, hold: request.hold ? { at: now, reason: request.reason } : null }),
  });
  if (result.changed > 0) {
    const verb = request.hold ? 'Held' : 'Resumed';
    repository.notify(`${verb} ${String(result.changed)} deliver${result.changed === 1 ? 'y' : 'ies'}.`);
  }
  return result;
}

/**
 * Handle `factory_archive`: archive finished deliveries or keep them on the board.
 *
 * @param repository - Selected project ledger.
 * @param input - Untrusted request.
 * @returns What changed.
 */
export function archiveDeliveries(repository: FactoryRepository, input: unknown): ControlResult {
  const request = archiveRequestSchema.parse(input);
  const state = request.archive ? 'archived' : 'kept';
  return applyControl(repository, request, {
    ineligible: (task) => (task.phase === 'done' ? null : 'Only finished deliveries can be archived.'),
    isCurrent: (task) => task.archive?.state === state,
    edit: (task, now) => ({ ...task, archive: { state, at: now } }),
  });
}
