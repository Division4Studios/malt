/**
 * Adopt a pull request that GitHub merged outside the factory's own merge
 * step, for example by a maintainer after main advanced and invalidated the
 * factory's approvals. GitHub is the source of truth: when the merged head is
 * exactly the delivery's recorded source, nothing local is left unpublished
 * and the merge commit is on fetched main, the delivery moves to merged-main
 * verification instead of waiting for an operator. No approvals are implied;
 * the issue closes only after that verification passes. A different head,
 * unpublished local work or a merge that is not on main stays a genuine
 * conflict for the operator.
 *
 * @file
 */
import { logObjective } from './objective-log.ts';
import { issueLabel } from './tracker-key.ts';

import type { FactoryContext } from './context.ts';
import type { PullRequest } from './remote.ts';
import type { FactoryTask } from './schema.ts';

/** Commit prefix shown in notices. */
const SHORT_SHA = 12;

/**
 * Whether the delivery's owned worktree holds nothing beyond the merged head.
 *
 * @param context - Owned worktrees.
 * @param task - Delivery.
 * @param head - Merged PR head.
 * @returns True when there is no worktree, or it sits at the merged head with no changes.
 */
async function hasNoUnpublishedWork(context: FactoryContext, task: FactoryTask, head: string): Promise<boolean> {
  if (task.worktree === null) {
    return true;
  }
  try {
    const source = await context.workspaces.snapshot(task.worktree);
    return source.head === head && source.status === '';
  } catch {
    return false;
  }
}

/**
 * Move an externally merged delivery to merged-main verification when that is safe.
 *
 * @param context - Project ledger, Git and main.
 * @param task - Delivery whose PR GitHub reports merged.
 * @param pr - Current PR state.
 * @returns True when the merge was adopted; false leaves the operator decision in place.
 */
export async function didAdoptExternalMerge(
  context: FactoryContext,
  task: FactoryTask,
  pr: PullRequest,
): Promise<boolean> {
  const merge = pr.mergeCommit?.oid;
  if (
    merge === undefined ||
    task.head === null ||
    pr.state !== 'MERGED' ||
    pr.headRefOid !== task.head ||
    !(await hasNoUnpublishedWork(context, task, pr.headRefOid))
  ) {
    return false;
  }
  try {
    await context.workspaces.contains(merge, await context.workspaces.base());
  } catch {
    return false;
  }
  const adopted = context.repository.editTask(task.id, (current) => {
    if (current.version !== task.version) {
      return current;
    }
    return {
      ...current,
      phase: 'verifying',
      merge,
      head: pr.headRefOid,
      base: pr.baseRefOid,
      reviews: [],
      finalReview: null,
      verifiedMain: null,
      error: null,
    };
  });
  if (adopted.phase !== 'verifying') {
    return false;
  }
  logObjective(context.repository.store, task.featureId, {
    kind: 'delivery',
    actor: 'supervisor',
    body: `${issueLabel(task)} ${task.title} was merged on GitHub as ${merge.slice(0, SHORT_SHA)} outside the factory; adopted, verifying on main.`,
  });
  context.repository.notify(
    `PR #${String(pr.number)} was merged outside the factory at ${merge}. Adopted it without implying QA approvals; merged-main verification runs before its issue closes.`,
  );
  return true;
}
