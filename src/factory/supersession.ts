/**
 * Unpaid, checkpointed retirement of operator-superseded delivery scopes.
 * Changed PR heads and actual merges remain gated for source reconciliation.
 *
 * @file
 */
import { issueKey, issueLabel, parentKey } from './tracker-key.ts';

import type { FactoryContext } from './context.ts';
import type { FactoryTask, FactoryEffect, Feature } from './schema.ts';

/** Identity suffix of the comment a superseded delivery's pull request receives. */
const PR_COMMENT = ':pr-comment';

/**
 * Whether an effect acts on a pull request rather than a tracker issue. Both
 * share one number space on GitHub and the local hub, but not with Jira.
 *
 * @param effect - Durable effect.
 * @returns True for a pull request closure or comment.
 */
export function isPullRequestEffect(effect: Pick<FactoryEffect, 'id' | 'kind'>): boolean {
  return effect.kind === 'close_pr' || (effect.kind === 'comment' && effect.id.endsWith(PR_COMMENT));
}

/**
 * Enqueue ordered retirement effects and clean only confirmed closed scopes.
 *
 * @param context - Selected project's remote outbox and owned source manager.
 */
export async function reconcileSuperseded(context: FactoryContext): Promise<void> {
  for (const task of context.repository.tasks()) {
    if (
      task.scopeReplacement === undefined ||
      task.scopeCleanup !== undefined ||
      task.merge !== null ||
      context.repository.jobs().some((job) => job.taskId === task.id && job.state === 'running')
    ) {
      continue;
    }
    const key = `${task.id}:superseded:${task.scopeReplacement}`;
    if (!isPullRequestRetired(context, task, key)) {
      continue;
    }
    queue(context, {
      id: `${key}:comment`,
      kind: 'comment',
      issue: task.issue,
      value: `Scope superseded by replacement objective ${task.scopeReplacement}. Retained source and evidence remain in project memory; this issue is not delivered.`,
    });
    if (!context.repository.effectCompleted(`${key}:comment`)) {
      continue;
    }
    queue(context, {
      id: `${key}:close`,
      kind: 'close_not_planned',
      issue: task.issue,
      value: 'Operator-authorized scope replacement.',
    });
    if (!context.repository.effectCompleted(`${key}:close`)) {
      continue;
    }
    // eslint-disable-next-line no-await-in-loop -- Each retirement waits for its own remote receipts and preserves ordered ownership cleanup.
    const note = await context.workspaces.cleanup(task);
    context.repository.editTask(task.id, (current) => {
      return {
        ...current,
        scopeCleanup: { at: context.repository.store.now(), note },
      };
    });
    context.repository.notify(`Superseded issue ${issueLabel(task)} closed as not planned. ${note}`);
  }
  await retireParents(context);
}

/**
 * Retire replaced parents only after local and actual native children settle.
 *
 * @param context - Durable replacement intents and remote closure receipts.
 */
async function retireParents(context: FactoryContext): Promise<void> {
  const candidates = context.repository.features().filter((feature) => {
    return (
      feature.scopeReplacement !== undefined &&
      feature.scopeCleanup === undefined &&
      context.repository.jobs().every((job) => job.featureId !== feature.id || job.state !== 'running')
    );
  });
  for (const feature of candidates) {
    // eslint-disable-next-line no-await-in-loop -- Retire each parent after its own actual-child and durable receipt checks.
    await retireParent(context, feature);
  }
}

/**
 * Reconcile one superseded feature without declaring it delivered.
 *
 * @param context - Durable scope and remote effect authority.
 * @param feature - Unretired replacement history.
 */
async function retireParent(context: FactoryContext, feature: Feature): Promise<void> {
  const replacement = feature.scopeReplacement;
  if (replacement === undefined) {
    return;
  }
  const tasks = context.repository.tasks().filter((task) => task.featureId === feature.id);
  if (
    tasks.some((task) => task.phase !== 'done' && task.scopeCleanup === undefined) ||
    context.repository.effects().some((effect) => tasks.some((task) => task.issue === effect.issue))
  ) {
    return;
  }
  const parent = feature.parentIssue;
  const key = `feature-${feature.id}:superseded:${replacement}`;
  if (parent !== null) {
    if (
      !(await context.remote.parentComplete(
        parentKey({ parentIssue: parent, parentKey: feature.parentKey }),
        tasks.map((task) => issueKey(task)),
      ))
    ) {
      return;
    }
    const latest = context.repository.features().find((candidate) => candidate.id === feature.id);
    if (latest?.scopeReplacement !== replacement || latest.scopeCleanup !== undefined) {
      return;
    }
    queue(context, {
      id: `${key}:comment`,
      kind: 'comment',
      issue: parent,
      value: `Feature scope superseded by objective ${replacement}. Completed child proof and retained source remain available; this feature is not reported as delivered.`,
    });
    if (!context.repository.effectCompleted(`${key}:comment`)) {
      return;
    }
    queue(context, {
      id: `${key}:close`,
      kind: 'close_not_planned',
      issue: parent,
      value: 'Replaced feature scope.',
    });
    if (!context.repository.effectCompleted(`${key}:close`)) {
      return;
    }
  }
  const current = context.repository.features().find((candidate) => candidate.id === feature.id);
  if (current?.scopeReplacement !== replacement || current.scopeCleanup !== undefined) {
    return;
  }
  context.repository.saveFeature({
    ...current,
    phase: 'blocked',
    scopeCleanup: { at: context.repository.store.now(), note: 'Superseded feature retired as not planned.' },
    updatedAt: context.repository.store.now(),
  });
  context.repository.notify(
    `Superseded feature ${feature.id} retired; its retained history is not a delivered outcome.`,
  );
}

/**
 * Queue a PR comment before expected-head retirement; a changed PR is preserved.
 *
 * @param context - Durable outbox and receipt ledger.
 * @param task - Superseded owned scope.
 * @param key - Stable replacement identity.
 * @returns Whether no open PR retirement remains outstanding.
 */
function isPullRequestRetired(context: FactoryContext, task: FactoryTask, key: string): boolean {
  if (task.pr === null) {
    return true;
  }
  if (task.head === null) {
    return false;
  }
  queue(context, {
    id: `${key}${PR_COMMENT}`,
    kind: 'comment',
    issue: task.pr,
    value: `Scope superseded by replacement objective ${task.scopeReplacement ?? ''}. Preserve source history; do not merge this obsolete scope.`,
  });
  if (!context.repository.effectCompleted(`${key}${PR_COMMENT}`)) {
    return false;
  }
  queue(context, { id: `${key}:pr-close`, kind: 'close_pr', issue: task.pr, value: task.head });
  return context.repository.effectCompleted(`${key}:pr-close`);
}

/**
 * Add a stable effect without replaying paid implementation or acknowledged work.
 *
 * @param context - Durable project outbox.
 * @param effect - Stable identity, retirement kind, native number and expected value.
 */
function queue(context: FactoryContext, effect: Pick<FactoryEffect, 'id' | 'kind' | 'issue' | 'value'>): void {
  context.repository.enqueueEffect({ ...effect, attempts: 0, retryAt: 0, error: null });
}
