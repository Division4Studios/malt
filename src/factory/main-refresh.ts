/**
 * Keep a reviewed delivery current when main advances, without a developer
 * turn. If the PR's head is still the reviewed source and only its base moved,
 * the unpaid supervisor merges current main into the owned branch and pushes
 * that merge. Reviews are bound to exact heads, so they run again, but scoped:
 * reviewers are told the only change since their approval is the merge of
 * main. A conflicting merge becomes a merge-conflict repair round for the
 * original developer; anything the supervisor cannot do safely falls back to
 * the developer refresh.
 *
 * @file
 */
import { recordConflict } from './repairs.ts';

import type { FactoryContext } from './context.ts';
import type { PullRequest } from './remote.ts';
import type { FactoryTask } from './schema.ts';

/** Phases whose reviewed source the supervisor may refresh. */
const REFRESHABLE: ReadonlySet<string> = new Set(['review', 'merge_ready']);

/**
 * The merge-only review scope after a refresh. Only a fully approved delivery starts one; a scope still bound
 * to the current head (an earlier refresh nobody has changed since) carries on; anything else is reviewed in full.
 *
 * @param task - Delivery before the refresh.
 * @param merged - Head the refresh produced.
 * @param now - Refresh time.
 * @returns The scope, or undefined for a full review.
 */
function refreshScope(task: FactoryTask, merged: string, now: number): FactoryTask['refreshedFrom'] {
  if (task.phase === 'merge_ready' && task.head !== null && task.base !== null) {
    return { head: task.head, base: task.base, at: now, merged };
  }
  const previous = task.refreshedFrom;
  return previous?.merged === undefined || task.head === null || previous.merged !== task.head
    ? undefined
    : { ...previous, at: now, merged };
}

/**
 * Merge advanced main into a reviewed delivery without a developer turn.
 *
 * @param context - Project Git, ledger and repair policy.
 * @param task - Delivery whose PR base moved.
 * @param pr - Current PR state.
 * @returns True when this pass refreshed the delivery or started a conflict repair; false falls back to the developer.
 */
export async function didRefreshOntoMain(
  context: FactoryContext,
  task: FactoryTask,
  pr: PullRequest,
): Promise<boolean> {
  if (
    task.worktree === null ||
    task.head === null ||
    !REFRESHABLE.has(task.phase) ||
    pr.headRefOid !== task.head ||
    pr.baseRefOid === task.base
  ) {
    return false;
  }
  let refreshed;
  try {
    refreshed = await context.workspaces.refreshPublished(task);
  } catch {
    return false;
  }
  if ('conflicts' in refreshed) {
    await recordConflict(context, task, {
      files: refreshed.conflicts,
      head: task.head,
      base: refreshed.base,
      directory: task.worktree,
    });
    return true;
  }
  const now = context.repository.store.now();
  const scope = refreshScope(task, refreshed.head, now);
  context.repository.editTask(task.id, (current) => {
    if (current.version !== task.version) {
      return current;
    }
    const next: FactoryTask = {
      ...current,
      phase: 'review',
      head: refreshed.head,
      base: refreshed.base,
      reviews: [],
      finalReview: null,
      verifiedMain: null,
      implementation: { head: refreshed.head, base: refreshed.base, at: now },
      ...(scope !== undefined && { refreshedFrom: scope }),
      error: null,
    };
    if (scope === undefined) {
      delete next.refreshedFrom;
    }
    return next;
  });
  context.repository.notify(
    `Main advanced under PR #${String(task.pr)}; the supervisor merged it into the reviewed source as ${refreshed.head} without a developer turn. ${scope === undefined ? 'Its reviews were not complete, so they run again in full.' : 'Reviews run again on the merge only.'}`,
  );
  return true;
}
