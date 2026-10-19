/**
 * Recover merges that completed while an operator replaced their scope.
 * Historical approval evidence authorizes verification, never a new merge.
 *
 * @file
 */
import { hasApprovals, hasFinalApproval } from './scheduler.ts';

import type { FactoryContext } from './context.ts';
import type { FactoryTask } from './schema.ts';

/**
 * Preserve actual merged source before obsolete-scope retirement can close it.
 *
 * @param context - Actual remote state and immutable historical task versions.
 * @param task - Superseded delivery with no recorded merge yet.
 */
export async function recoverSupersededMerge(context: FactoryContext, task: FactoryTask): Promise<void> {
  if (task.pr === null || task.scopeReplacement === undefined || task.merge !== null) {
    return;
  }
  const pr = await context.remote.inspect(task.pr);
  if (pr.state === 'OPEN' && pr.autoMergeRequest !== null && pr.autoMergeRequest !== undefined) {
    // An obsolete scope must not merge while its retirement waits on the outbox.
    await context.remote.disarm?.(pr.number);
  }
  const current = context.repository.task(task.id);
  if (current.version !== task.version || current.scopeReplacement !== task.scopeReplacement || pr.state !== 'MERGED') {
    return;
  }
  if (pr.mergeCommit === null) {
    context.repository.editTask(task.id, (delivery) => {
      return {
        ...delivery,
        error:
          'GitHub reports a merged superseded PR without its merge commit; preserve source and retry reconciliation.',
      };
    });
    return;
  }
  const approved = context.repository.taskVersions(task.id).findLast((version) => {
    return (
      version.scopeReplacement === undefined &&
      version.phase === 'merging' &&
      version.pr === task.pr &&
      version.head === pr.headRefOid &&
      version.base === pr.baseRefOid &&
      hasApprovals(version) &&
      hasFinalApproval(version)
    );
  });
  const merge = pr.mergeCommit.oid;
  context.repository.store.transaction(() => {
    const key = `${task.id}:superseded:${task.scopeReplacement ?? ''}`;
    for (const suffix of ['pr-close', 'close']) {
      context.repository.discardEffect(`${key}:${suffix}`, `Superseded PR actually merged at ${merge}.`);
    }
    context.repository.editTask(task.id, (delivery) => {
      return {
        ...delivery,
        merge,
        phase: approved === undefined ? 'blocked' : 'verifying',
        ...(approved !== undefined && {
          scopeReplacement: undefined,
          reviews: approved.reviews,
          finalReview: approved.finalReview,
          head: approved.head,
          base: approved.base,
        }),
        verifiedMain: null,
        error:
          approved === undefined
            ? 'Superseded PR merged without retained exact-head/base factory merge approval. Investigate; preserve source and issue.'
            : 'Merge completed during scope replacement; retained approvals recovered. Verify actual merged main before closure.',
      };
    });
    context.repository.notify(`Superseded PR #${String(task.pr)} actually merged at ${merge}; retirement stopped.`);
  });
}
