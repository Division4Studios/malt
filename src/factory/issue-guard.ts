/**
 * Unpaid pre-launch guard: a delivery whose GitHub issue is already closed is parked as
 * blocked instead of receiving a developer assignment. Reads are limited to deliveries
 * about to be dispatched and never overwrite an operator edit made during the read.
 *
 * @file
 */

import type { FactoryContext } from './context.ts';
import type { FactoryRepository } from './repository.ts';
import type { JobIntent } from './scheduler.ts';
import type { FactoryTask } from './schema.ts';
/** Longest retained waiting explanation. */
const WAITING_LIMIT = 300;

/**
 * Explain why a closed issue blocks development and how to recover.
 *
 * @param issue - Delivery issue number.
 * @param reason - GitHub close reason.
 * @returns Operator-facing blocker.
 */
function closedMessage(issue: number, reason = 'unspecified'): string {
  return `Issue #${String(issue)} is closed (state_reason: ${reason}), so no developer assignment was started. Operator decision required: adopt the merge that delivered it, or reopen or re-scope the issue. Head, base, branch and worktree are preserved.`;
}

/**
 * Confirm the intent still describes an unchanged, dispatchable delivery.
 *
 * @param task - Current ledger revision.
 * @param intent - Candidate assignment.
 * @returns Whether the delivery may still start development.
 */
function isEligible(task: FactoryTask, intent: JobIntent): boolean {
  return (
    task.scopeReplacement === undefined &&
    (task.phase === 'ready' || task.phase === 'development') &&
    task.head === intent.head &&
    task.base === intent.base
  );
}

/** Remembers failed reads so one unreachable GitHub call is not repeated every heartbeat. */
export class IssueGuard {
  /** Unresolved observations remain visible when another delivery reads successfully. */
  private readonly failures = new Map<string, { reason: string; version: number }>();
  /** Earliest retry per delivery after a failed or malformed read. */
  private readonly retryAt = new Map<string, number>();

  /**
   * Surface one unresolved read without losing other deliveries' explanations.
   *
   * @param repository - Current task revisions, including operator re-scoping.
   * @returns Oldest still-unresolved bounded diagnostic.
   */
  public waitingReason(repository: FactoryRepository): string | null {
    const tasks = new Map(repository.tasks().map((task) => [task.id, task]));
    for (const [id, failure] of this.failures) {
      const task = tasks.get(id);
      if (!(
        task?.version !== failure.version ||
        task.scopeReplacement !== undefined ||
        (task.phase !== 'ready' && task.phase !== 'development')
      )) {
        continue;
      }

      this.failures.delete(id);
      this.retryAt.delete(id);
    }
    return this.failures.values().next().value?.reason ?? null;
  }

  /**
   * Start an assignment unless its delivery's issue is closed or cannot be confirmed open.
   *
   * @param context - Project ledger and GitHub boundary.
   * @param intent - Assignment about to be claimed.
   * @param start - Rechecks supervisor authority and claims the unchanged assignment.
   */
  public async launch(context: FactoryContext, intent: JobIntent, start: () => void): Promise<void> {
    if (intent.kind !== 'develop' || (await this.isOpen(context, intent))) {
      start();
    }
  }

  /**
   * Read the issue once for a development intent and park the delivery when it is closed.
   *
   * @param context - Project ledger and GitHub boundary.
   * @param intent - Develop assignment about to be claimed.
   * @returns Whether the issue was confirmed open for the unchanged delivery revision.
   */
  private async isOpen(context: FactoryContext, intent: JobIntent): Promise<boolean> {
    const { repository } = context;
    const task = repository.tasks().find((candidate) => candidate.id === intent.taskId);
    if (
      task === undefined ||
      !isEligible(task, intent) ||
      (this.retryAt.get(task.id) ?? 0) > repository.store.now() ||
      repository.jobs().some((job) => job.state === 'running' && job.kind === 'develop' && job.taskId === task.id)
    ) {
      return false;
    }
    let issue;
    try {
      issue = await context.remote.issueState(task.issue);
    } catch (error) {
      this.retryAt.set(task.id, repository.store.now() + context.settings.reconcileMs);
      const detail = Error.isError(error) ? error.message : 'unknown failure';
      this.failures.set(task.id, {
        version: task.version,
        reason: `Waiting to confirm issue #${String(task.issue)} is open before development: ${detail}`.slice(
          0,
          WAITING_LIMIT,
        ),
      });
      return false;
    }
    this.retryAt.delete(task.id);
    this.failures.delete(task.id);
    const current = repository.tasks().find((candidate) => candidate.id === task.id);
    if (current?.version !== task.version || !isEligible(current, intent)) {
      return false;
    }
    if (issue.state === 'closed') {
      repository.editTask(task.id, (value) => {
        return {
          ...value,
          phase: 'blocked',
          error: closedMessage(task.issue, issue.stateReason ?? undefined),
        };
      });
    }
    return issue.state === 'open';
  }
}
