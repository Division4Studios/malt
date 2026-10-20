/**
 * Unpaid pre-launch guard: GitHub is read before any paid delivery assignment
 * starts. A delivery whose issue is already closed is parked as blocked
 * instead of receiving a developer, reviewer, fixer, final tester or brief
 * revalidation, and a published delivery whose PR is already merged or closed
 * starts no paid run (reconciliation adopts or reports it). Reads are limited
 * to deliveries about to be dispatched, a confirmed-open read is reused for
 * the same delivery revision until the next reconcile interval, and a read
 * never overwrites an operator edit made while it was in flight.
 *
 * @file
 */
import { JOB_PHASE } from './seats.ts';
import { issueKey, issueLabel } from './tracker-key.ts';

import type { FactoryContext } from './context.ts';
import type { IssueState } from './remote.ts';
import type { FactoryRepository } from './repository.ts';
import type { JobIntent } from './scheduler.ts';
import type { FactoryJob, FactoryTask } from './schema.ts';
/** Longest retained waiting explanation. */
const WAITING_LIMIT = 300;
/** Paid delivery assignments guarded by the issue and PR read; verification runs after the merge closes the issue. */
const GUARDED_KINDS: ReadonlySet<string> = new Set([
  'develop',
  'review',
  'adjudicate',
  'document',
  'regress',
  'final',
  'revalidate',
]);
/** How each guarded assignment is named in messages. */
const ASSIGNMENT_NAMES: Readonly<Record<string, string>> = {
  develop: 'developer',
  review: 'review',
  adjudicate: 'fix',
  document: 'documentation',
  regress: 'regression',
  final: 'final test',
  revalidate: 'brief revalidation',
};

/**
 * Whether a running attempt already performs this assignment for the delivery. Workflow steps are matched by
 * step, so independent reviews on different seats run together; attempts without a step are matched by kind.
 *
 * @param jobs - Recorded attempts.
 * @param intent - Assignment about to start.
 * @param taskId - Its delivery.
 * @returns True when starting it would duplicate a running attempt.
 */
export function isAlreadyRunning(
  jobs: readonly Pick<FactoryJob, 'state' | 'kind' | 'taskId' | 'step'>[],
  intent: Pick<JobIntent, 'kind' | 'step'>,
  taskId: string,
): boolean {
  const step = intent.step ?? null;
  return jobs.some((job) => {
    if (job.state !== 'running' || job.taskId !== taskId) {
      return false;
    }
    return step === null || job.step === null ? job.kind === intent.kind : job.step === step;
  });
}

/**
 * Explain why a closed issue blocks the assignment and how to recover.
 *
 * @param issue - Delivery issue, as people see it.
 * @param kind - Assignment kind that was not started.
 * @param reason - GitHub close reason.
 * @returns Operator-facing blocker.
 */
function closedMessage(issue: string, kind: string, reason = 'unspecified'): string {
  return `Issue ${issue} is closed (state_reason: ${reason}), so no ${ASSIGNMENT_NAMES[kind] ?? kind} assignment was started. Operator decision required: adopt the merge that delivered it, or reopen or re-scope the issue. Head, base, branch and worktree are preserved.`;
}

/**
 * Confirm the intent still describes an unchanged, dispatchable delivery.
 *
 * @param task - Current ledger revision.
 * @param intent - Candidate assignment.
 * @returns Whether the delivery may still start this assignment.
 */
function isEligible(task: FactoryTask, intent: JobIntent): boolean {
  const phase = intent.kind === 'develop' ? 'development' : JOB_PHASE[intent.kind];
  const isPhase = task.phase === phase || (intent.kind === 'develop' && task.phase === 'ready');
  return isPhase && task.scopeReplacement === undefined && task.head === intent.head && task.base === intent.base;
}

/** What GitHub reported for a delivery about to be dispatched. */
interface Observation {
  /** Issue state and close reason. */
  readonly issue: IssueState;
  /** PR state (`OPEN`, `MERGED` or `CLOSED`); `OPEN` before publication. */
  readonly pr: string;
}

/**
 * Read a delivery's issue and, once published and past development, its PR state.
 *
 * @param context - GitHub boundary.
 * @param task - Delivery about to be dispatched.
 * @param intent - Its assignment.
 * @returns Issue state and PR state.
 */
async function readState(context: FactoryContext, task: FactoryTask, intent: JobIntent): Promise<Observation> {
  const issue = await context.remote.issueState(issueKey(task));
  if (intent.kind === 'develop' || task.pr === null) {
    return { issue, pr: 'OPEN' };
  }
  const pr = await context.remote.inspect(task.pr);
  return { issue, pr: pr.state };
}

/** Remembers failed reads so one unreachable GitHub call is not repeated every heartbeat. */
export class IssueGuard {
  /** Unresolved observations remain visible when another delivery reads successfully. */
  private readonly failures = new Map<string, { reason: string; version: number; phase: string }>();
  /** Earliest retry per delivery after a failed or malformed read. */
  private readonly retryAt = new Map<string, number>();
  /** Confirmed-open reads reused for the same delivery revision until the time given. */
  private readonly confirmed = new Map<string, { version: number; until: number }>();

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
      if (task?.version === failure.version && task.scopeReplacement === undefined && task.phase === failure.phase) {
        continue;
      }
      this.failures.delete(id);
      this.retryAt.delete(id);
    }
    return this.failures.values().next().value?.reason ?? null;
  }

  /**
   * Start an assignment unless its delivery's issue is closed, its PR already merged or closed, or either cannot be read.
   *
   * @param context - Project ledger and GitHub boundary.
   * @param intent - Assignment about to be claimed.
   * @param start - Rechecks supervisor authority and claims the unchanged assignment.
   */
  public async launch(context: FactoryContext, intent: JobIntent, start: () => void): Promise<void> {
    this.waitingReason(context.repository);
    if (!GUARDED_KINDS.has(intent.kind) || intent.taskId === null || (await this.isOpen(context, intent))) {
      start();
    }
  }

  /**
   * Read the issue (and, once published, the PR) for an intent and park the delivery when its issue is closed.
   *
   * @param context - Project ledger and GitHub boundary.
   * @param intent - Paid delivery assignment about to be claimed.
   * @returns Whether the delivery was confirmed open for the unchanged revision.
   */
  private async isOpen(context: FactoryContext, intent: JobIntent): Promise<boolean> {
    const { repository } = context;
    const task = repository.tasks().find((candidate) => candidate.id === intent.taskId);
    const now = repository.store.now();
    if (
      task === undefined ||
      !isEligible(task, intent) ||
      (this.retryAt.get(task.id) ?? 0) > now ||
      isAlreadyRunning(repository.jobs(), intent, task.id)
    ) {
      return false;
    }
    if (this.isConfirmed(task, intent, now)) {
      return true;
    }
    const observed = await this.observe(context, task, intent);
    const current = repository.tasks().find((candidate) => candidate.id === task.id);
    return (
      observed !== null &&
      current?.version === task.version &&
      isEligible(current, intent) &&
      this.decide(context, { task, intent, observed, now })
    );
  }

  /**
   * Whether a recent read already confirmed this delivery revision open.
   *
   * @param task - Delivery about to be dispatched.
   * @param intent - Its assignment.
   * @param now - Current time.
   * @returns True within one reconcile interval of a confirmation; development always reads again.
   */
  private isConfirmed(task: FactoryTask, intent: JobIntent, now: number): boolean {
    const cached = intent.kind === 'develop' ? undefined : this.confirmed.get(task.id);
    return cached?.version === task.version && cached.until > now;
  }

  /**
   * Park a closed issue, hold a merged or closed PR, or confirm the delivery open.
   *
   * @param context - Project ledger and policy.
   * @param read - The delivery, its assignment, what GitHub reported and when.
   * @param read.task - Delivery revision that was read.
   * @param read.intent - Assignment about to be claimed.
   * @param read.observed - Issue and PR states.
   * @param read.now - Read time.
   * @returns Whether the assignment may start.
   */
  private decide(
    context: FactoryContext,
    read: { task: FactoryTask; intent: JobIntent; observed: Observation; now: number },
  ): boolean {
    const { task, intent, observed } = read;
    if (observed.issue.state === 'closed') {
      context.repository.editTask(task.id, (value) => {
        return {
          ...value,
          phase: 'blocked',
          error: closedMessage(issueLabel(task), intent.kind, observed.issue.stateReason ?? undefined),
        };
      });
      return false;
    }
    if (observed.pr !== 'OPEN') {
      // Reconciliation adopts a merge made elsewhere, or reports a closed PR, on its next pass.
      this.failures.set(task.id, {
        version: task.version,
        phase: task.phase,
        reason: `PR #${String(task.pr)} is ${observed.pr.toLowerCase()} on GitHub, so no paid ${ASSIGNMENT_NAMES[intent.kind] ?? intent.kind} assignment was started.`,
      });
      return false;
    }
    this.confirmed.set(task.id, { version: task.version, until: read.now + context.settings.reconcileMs });
    return true;
  }

  /**
   * Read the issue and, for a published delivery, its PR state.
   *
   * @param context - GitHub boundary and clock.
   * @param task - Delivery about to be dispatched.
   * @param intent - Its assignment.
   * @returns Issue and PR states, or null after a failed read (recorded as a bounded wait).
   */
  private async observe(context: FactoryContext, task: FactoryTask, intent: JobIntent): Promise<Observation | null> {
    try {
      const observed = await readState(context, task, intent);
      this.retryAt.delete(task.id);
      this.failures.delete(task.id);
      return observed;
    } catch (error) {
      this.retryAt.set(task.id, context.repository.store.now() + context.settings.reconcileMs);
      const detail = Error.isError(error) ? error.message : 'unknown failure';
      const stage = intent.kind === 'develop' ? 'development' : `the ${ASSIGNMENT_NAMES[intent.kind] ?? intent.kind}`;
      this.failures.set(task.id, {
        version: task.version,
        phase: task.phase,
        reason: `Waiting to confirm issue ${issueLabel(task)} is open before ${stage}: ${detail}`.slice(
          0,
          WAITING_LIMIT,
        ),
      });
      return null;
    }
  }
}
