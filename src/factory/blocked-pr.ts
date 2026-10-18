/**
 * Reconcile parked PRs before another paid implementation turn.
 *
 * @file
 */
import { didAdoptExternalMerge } from './external-merge.ts';

import type { FactoryContext } from './context.ts';
import type { FactoryTask } from './schema.ts';

/**
 * Inspect external progress without approving, merging or closing.
 *
 * @param context - Project services.
 * @param task - Exact ledger revision.
 * @returns Whether parked reconciliation consumed this pass.
 */
export async function hasParkedPRUpdate(context: FactoryContext, task: FactoryTask): Promise<boolean> {
  if (
    task.pr === null ||
    !['blocked', 'development', 'publishing'].includes(task.phase) ||
    context.repository.jobs().some((job) => job.taskId === task.id && job.state === 'running')
  ) {
    return false;
  }
  const pr = await context.remote.inspect(task.pr);
  const current = context.repository.task(task.id);
  if (current.version !== task.version || current.scopeReplacement !== undefined) {
    return true;
  }
  if (pr.state === 'MERGED' && pr.mergeCommit !== null) {
    if (await didAdoptExternalMerge(context, current, pr)) {
      return true;
    }
    const error = `PR #${String(task.pr)} is already merged. Operator decision required: verify actual merged main or investigate missing factory gates. No QA approvals are implied.`;
    if (current.merge !== pr.mergeCommit.oid || current.error !== error) {
      context.repository.editTask(task.id, (value) => {
        return {
          ...value,
          phase: 'blocked',
          merge: pr.mergeCommit?.oid ?? null,
          head: pr.headRefOid,
          base: pr.baseRefOid,
          reviews: [],
          finalReview: null,
          verifiedMain: null,
          error,
        };
      });
    }
    return true;
  }
  if (pr.state === 'CLOSED') {
    const error = 'The PR was closed without merge. Decide whether to preserve, re-scope or repair this delivery.';
    if (current.error !== error) {
      context.repository.editTask(task.id, (value) => ({ ...value, phase: 'blocked', error }));
    }
    return true;
  }
  // Publication may have committed a new local head before its remote PR catches up.
  // retryPublication uses ordinary fast-forward pushes; divergent remote work still rejects safely.
  if (task.phase !== 'publishing' && pr.headRefOid !== task.head) {
    context.repository.editTask(task.id, (value) => {
      return {
        ...value,
        phase: 'blocked',
        head: pr.headRefOid,
        base: pr.baseRefOid,
        reviews: [],
        finalReview: null,
        error:
          'The PR has a newer remote revision. Request fresh QA or original-owner repair; previous approvals are invalid.',
      };
    });
    return true;
  }
  return false;
}
