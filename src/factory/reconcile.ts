/**
 * Unpaid delivery reconciliation. Remote retries, PR publication, serialized
 * merges and ticket cleanup do not restart an already-successful model turn.
 * Main/head changes invalidate recorded approvals before any merge.
 *
 * @file
 */

import { randomUUID } from 'node:crypto';

import { MeshError } from '../protocol.ts';

import { OPERATOR_ADOPTED } from './adoption-schema.ts';
import { closeAdopted } from './adoption.ts';
import { hasParkedPRUpdate } from './blocked-pr.ts';
import { definitionProgress, isDefinitionMet } from './objective-goals.ts';
import { logObjective } from './objective-log.ts';
import { featureWorkflow, planningApprovals } from './pipeline.ts';
import { retainProvisionedIssues } from './provisioning-identity.ts';
import { isIntakeParked } from './recommendation-intake.ts';
import { mergeBlocker } from './remote.ts';
import { didHandleFailedChecks } from './repairs.ts';
import { hasApprovals, hasFinalApproval } from './scheduler.ts';
import { recoverSupersededMerge } from './superseded-merge.ts';
import { reconcileSuperseded } from './supersession.ts';

import type { FactoryContext } from './context.ts';
import type { PullRequest } from './remote.ts';
import type { ReadyIssue } from './scheduler.ts';
import type { FactoryTask, Feature } from './schema.ts';

/** Commit id characters shown in progress log entries. */
const SHORT_SHA = 12;

/**
 * Abbreviate a commit id for a progress log entry.
 *
 * @param sha - Full commit id.
 * @returns Its first characters.
 */
function shortSha(sha: string): string {
  return sha.slice(0, SHORT_SHA);
}

/**
 * Build one ledger task from a GitHub atomic issue.
 *
 * @param context - Project ledger and clock.
 * @param issue - Native delivery issue.
 * @param featureId - Owning product request.
 * @returns Initial dependency-ready task state.
 */
export function deliveryTask(context: FactoryContext, issue: ReadyIssue, featureId: string | null): FactoryTask {
  const feature = context.repository.features().find((candidate) => candidate.id === featureId);
  return {
    id: randomUUID(),
    featureId,
    issue: issue.issue,
    parentIssue: issue.parentIssue,
    key: `issue-${String(issue.issue)}`,
    title: issue.title,
    description: issue.description,
    acceptanceCriteria: [...issue.acceptanceCriteria],
    dependencies: [],
    capabilityTier: null,
    skills: [],
    phase: 'ready',
    developer: null,
    branch: null,
    worktree: null,
    head: null,
    base: null,
    pr: null,
    prUrl: null,
    merge: null,
    reviews: [],
    feedback: [],
    finalReview: null,
    verifiedMain: null,
    attempts: 0,
    version: 0,
    error: null,
    approvals: [],
    implementation: null,
    stepResults: [],
    hold: null,
    archive: null,
    repairs: [],
    revalidation: null,
    workflow: feature?.workflow,
    ...(feature?.gates !== undefined && { gates: { merge: feature.gates.merge } }),
    ...(feature?.stepOverrides !== undefined && { stepOverrides: feature.stepOverrides }),
    updatedAt: context.repository.store.now(),
  };
}

/**
 * Provision reviewed plans and resume partial native issue creation.
 *
 * @param context - Project-scoped GitHub and task ledger.
 */
async function provision(context: FactoryContext): Promise<void> {
  // An objective waiting for a planning approval keeps its plan unprovisioned.
  const candidates1 = context.repository
    .features()
    .filter(
      (candidate) =>
        candidate.phase === 'provisioning' && planningApprovals(candidate, featureWorkflow(candidate)).length === 0,
    );
  for (const feature of candidates1) {
    try {
      // eslint-disable-next-line no-await-in-loop -- Features are provisioned sequentially with durable remote checkpoints.
      await provisionFeature(context, feature);
    } catch (error) {
      const current = context.repository.features().find((candidate) => candidate.id === feature.id);
      if (current === undefined || current.scopeReplacement !== undefined) {
        continue;
      }
      context.repository.saveFeature({
        ...current,
        error: Error.isError(error) ? error.message : 'GitHub provisioning failed.',
        updatedAt: context.repository.store.now(),
      });
    }
  }
}

/**
 * Import explicit Ready atomic issues without importing another project's backlog.
 *
 * @param context - Current Project and ledger.
 */
async function importReady(context: FactoryContext): Promise<void> {
  const ready = await context.remote.readyIssues();
  for (const issue of ready) {
    if (context.repository.tasks().some((task) => task.issue === issue.issue)) {
      continue;
    }
    let feature = context.repository.features().find((candidate) => candidate.parentIssue === issue.parentIssue);
    if (feature === undefined) {
      const now = context.repository.store.now();
      feature = {
        id: randomUUID(),
        objective: `Existing feature #${String(issue.parentIssue)}`,
        phase: 'active',
        productPlan: null,
        plan: null,
        parentIssue: issue.parentIssue,
        error: null,
        createdAt: now,
        updatedAt: now,
        approvals: [],
      };
      context.repository.saveFeature(feature);
    }
    if (feature.scopeReplacement === undefined) {
      context.repository.addTask(deliveryTask(context, issue, feature.id));
    }
  }
}

/**
 * Invalidate approvals when remote source or main has changed.
 *
 * @param context - GitHub evidence and original owner ledger.
 * @param task - Current delivery.
 * @param reason - Freshness failure.
 */
function refreshRequired(context: FactoryContext, task: FactoryTask, reason: string): void {
  context.repository.editTask(task.id, (current) => {
    return {
      ...current,
      phase: 'development',
      reviews: [],
      finalReview: null,
      verifiedMain: null,
      error: reason,
      feedback: [...current.feedback, `${reason} The original developer must refresh main and obtain new reviews.`],
    };
  });
}

/**
 * Publish or reuse a PR without another paid developer turn after API failure.
 *
 * @param context - Owned branch and target GitHub Project.
 * @param task - Tested publication intent.
 */
async function publish(context: FactoryContext, task: FactoryTask): Promise<void> {
  const base = await context.workspaces.base();
  if (!isCurrent(context, task)) {
    return;
  }
  if (base !== task.base) {
    refreshRequired(context, task, 'Main advanced before PR submission.');
    return;
  }
  await context.workspaces.retryPublication(task);
  if (!isCurrent(context, task)) {
    return;
  }
  const pr = await context.remote.pullRequest(task, context.settings);
  context.repository.editTask(task.id, (current) => {
    return {
      ...current,
      pr: pr.number,
      prUrl: pr.url,
      phase: current.version === task.version && current.scopeReplacement === undefined ? 'review' : current.phase,
      error: current.version === task.version && current.scopeReplacement === undefined ? null : current.error,
    };
  });
}

/**
 * Inspect open PRs, recover ambiguous merges and serialize a verified merge intent.
 *
 * @param context - Actual GitHub and main state.
 * @param task - Delivery with a PR.
 */
async function inspect(context: FactoryContext, task: FactoryTask): Promise<void> {
  const record = task;
  if (record.pr === null) {
    return;
  }
  const pr = await context.remote.inspect(record.pr);
  if (!isCurrent(context, task)) {
    return;
  }
  if (pr.state === 'MERGED') {
    recoverMerge(context, task, pr);
    return;
  }
  if (pr.headRefOid !== record.head || pr.baseRefOid !== record.base) {
    refreshRequired(context, record, 'The remote PR head or main advanced. Previous approvals are invalid.');
    return;
  }
  if (await didHandleFailedChecks(context, record, pr)) {
    return;
  }
  if (record.phase === 'merge_ready') {
    const gateReason = mergeBlocker(pr, record, context.settings);
    if (gateReason !== record.error) {
      context.repository.editTask(record.id, (current) => ({ ...current, error: gateReason }));
    }
    return;
  }
  if (record.phase === 'merging') {
    await serializeMerge(context, record, pr);
  }
}

/**
 * Merge an approved delivery once its gates pass on the exact reviewed source.
 *
 * @param context - Actual GitHub and main state.
 * @param task - Delivery whose final check approved it.
 * @param pr - Current PR state at the recorded head and base.
 */
async function serializeMerge(context: FactoryContext, task: FactoryTask, pr: PullRequest): Promise<void> {
  const record = task;
  if (!hasApprovals(record) || !hasFinalApproval(record)) {
    refreshRequired(context, record, 'Final approval is stale.');
    return;
  }
  const reason = mergeBlocker(pr, record, context.settings);
  if (reason !== null) {
    context.repository.editTask(record.id, (current) => ({ ...current, error: reason }));
    return;
  }
  const base = await context.workspaces.base();
  if (base !== record.base) {
    refreshRequired(context, record, 'Main changed immediately before merge.');
    return;
  }
  if (!context.repository.active() || !isCurrent(context, task)) {
    return;
  }
  const merge = await context.remote.merge(record, context.settings);
  context.repository.editTask(record.id, (current) => {
    return {
      ...current,
      phase: 'verifying',
      merge,
      scopeReplacement: undefined,
      reviews: record.reviews,
      finalReview: record.finalReview,
      error:
        current.scopeReplacement === undefined
          ? null
          : 'Merge was already sent before scope replacement; verify its actual merged-main commit.',
    };
  });
  logObjective(context.repository.store, record.featureId, {
    kind: 'delivery',
    actor: 'supervisor',
    body: `#${String(record.issue)} ${record.title} merged as ${shortSha(merge)}; verifying on main.`,
  });
  context.repository.notify(
    `Merged PR #${String(record.pr)} at ${merge}. Refresh main in every remaining developer worktree before submission. Final merged-main testing is next.`,
  );
}

/**
 * Confirm saved verification still covers main, then queue closure and cleanup.
 *
 * @param context - Unpaid Git/remote reconciler.
 * @param task - Durable final verification intent.
 */
async function closeVerified(context: FactoryContext, task: FactoryTask): Promise<void> {
  const record = task;
  if (record.verifiedMain?.jobId === OPERATOR_ADOPTED) {
    await closeAdopted(context, record);
    return;
  }
  if (record.merge === null || record.verifiedMain === null) {
    throw new MeshError('FACTORY_GATED', 'No merged-main verification proof is recorded.');
  }
  const base = await context.workspaces.base();
  if (base !== record.verifiedMain.head) {
    context.repository.editTask(record.id, (current) => {
      return {
        ...current,
        phase: 'verifying',
        verifiedMain: null,
        error: 'Main advanced during final verification; rerun on updated main.',
      };
    });
    return;
  }
  await context.workspaces.contains(record.merge, base);
  context.repository.editTask(record.id, (current) => ({ ...current, phase: 'done', error: null }));
  logObjective(context.repository.store, record.featureId, {
    kind: 'delivery',
    actor: 'supervisor',
    body: `#${String(record.issue)} ${record.title} verified on main ${shortSha(base)} and done.`,
  });
  await context.learning.execute(
    'learning_record',
    {
      summary: `Issue #${String(record.issue)} delivered`,
      cause: record.verifiedMain.summary,
      prevention: 'Retain successful acceptance checks and head-specific reviews for similar deliveries.',
      evidence: [
        `Merged main ${base}`,
        `Final attempt ${record.verifiedMain.jobId}`,
        record.prUrl ?? `Issue #${String(record.issue)}`,
      ],
      outcome: 'success',
      ticket: record.issue,
    },
    'factory-runtime',
  );
}

/**
 * Repair completion effects after crashes and retire safe resources with history.
 *
 * @param context - Verified task ledger.
 * @param task - Completed delivery.
 */
async function completionEffects(context: FactoryContext, task: FactoryTask): Promise<void> {
  const proof = task.verifiedMain;
  if (proof === null) {
    throw new MeshError('FACTORY_GATED', 'Done requires merged-main proof.');
  }
  const effect = { issue: task.issue, attempts: 0, retryAt: 0, error: null };
  // An operator-adopted issue is already closed on GitHub; adoption never comments on or edits it.
  if (proof.jobId !== OPERATOR_ADOPTED) {
    context.repository.enqueueEffect({
      ...effect,
      id: `${task.id}:verified:comment`,
      kind: 'comment',
      value: `Verified merged main ${proof.head} after merge ${task.merge ?? ''}.\n\n${proof.summary}\n\nEvidence: project-local attempt ${proof.jobId}.`,
    });
    context.repository.enqueueEffect({
      ...effect,
      id: `${task.id}:verified:close`,
      kind: 'close',
      value: 'Verified on merged main.',
    });
  }
  if (task.worktree === null) {
    return;
  }
  const notes = await context.workspaces.cleanup(task);
  if (notes.startsWith('Preserved') && task.error === notes) {
    return;
  }
  context.repository.editTask(task.id, (current) => {
    return {
      ...current,
      ...(!notes.startsWith('Preserved') && { worktree: null, branch: null }),
      error: notes.startsWith('Preserved') ? notes : null,
    };
  });
  context.repository.notify(`Issue #${String(task.issue)} delivered. ${notes}`);
}

/**
 * Flush retryable remote effects without rerunning models.
 *
 * @param context - Durable outbox and GitHub adapter.
 */
async function flushEffects(context: FactoryContext): Promise<void> {
  const candidates2 = context.repository
    .effects()
    .filter((candidate) => candidate.retryAt <= context.repository.store.now());
  for (const effect of candidates2) {
    try {
      // eslint-disable-next-line no-await-in-loop -- Remote effects are serialized and completed receipts are persisted after each call.
      await context.remote.effect(effect);
      context.repository.settleEffect(effect, null);
    } catch (error) {
      context.repository.settleEffect(effect, Error.isError(error) ? error.message : 'GitHub synchronization failed.');
    }
  }
}

/**
 * Close a parent only when verified children and actual native sub-issues agree.
 *
 * @param context - Product feature ledger and remote board.
 */
export async function closeParents(context: FactoryContext): Promise<void> {
  const candidates3 = context.repository
    .features()
    .filter(
      (candidate) =>
        candidate.phase === 'active' && candidate.parentIssue !== null && candidate.scopeReplacement === undefined,
    );
  for (const feature of candidates3) {
    const tasks = context.repository.tasks().filter((task) => task.featureId === feature.id);
    if (
      tasks.length === 0 ||
      tasks.some((task) => task.phase !== 'done') ||
      // Children closed without delivery never justify closing the parent as completed; the operator decides.
      tasks.some((task) => task.verifiedMain?.undelivered === true) ||
      context.repository.effects().some((effect) => tasks.some((task) => task.issue === effect.issue)) ||
      // Delivered work completes the objective only once its definition of done is met or waived.
      !isDefinitionMet(feature)
    ) {
      continue;
    }
    const parent = feature.parentIssue;
    if (
      parent === null ||
      // eslint-disable-next-line no-await-in-loop -- Confirm each feature's actual native children before committing its independent closure intent.
      !(await context.remote.parentComplete(
        parent,
        tasks.map((task) => task.issue),
      ))
    ) {
      continue;
    }
    context.repository.enqueueEffect({
      id: `feature-${feature.id}:status`,
      kind: 'status',
      issue: parent,
      value: 'Done',
      attempts: 0,
      retryAt: 0,
      error: null,
    });
    context.repository.enqueueEffect({
      id: `feature-${feature.id}:close`,
      kind: 'close',
      issue: parent,
      value: 'All native deliveries verified and closed.',
      attempts: 0,
      retryAt: 0,
      error: null,
    });
    if (
      !context.repository.effectCompleted(`feature-${feature.id}:status`) ||
      !context.repository.effectCompleted(`feature-${feature.id}:close`)
    ) {
      continue;
    }
    context.repository.saveFeature({
      ...feature,
      phase: 'done',
      error: null,
      updatedAt: context.repository.store.now(),
    });
    const { met, total } = definitionProgress(feature);
    const criteria = total === 0 ? '' : `, ${String(met)} of ${String(total)} done criteria met`;
    logObjective(context.repository.store, feature.id, {
      kind: 'objective',
      actor: 'supervisor',
      body: `Objective complete: every delivery verified and closed${criteria}.`,
    });
    context.repository.notify(
      `Feature #${String(parent)} is delivered: all atomic child issues were independently reviewed, merged, verified on main and closed.`,
    );
  }
}

/**
 * Reconcile a project through durable external steps, isolating per-ticket faults.
 *
 * @param context - Current workspace factory.
 */
export async function reconcile(context: FactoryContext): Promise<void> {
  await importReady(context);
  await provision(context);
  for (const task of context.repository.tasks()) {
    try {
      // eslint-disable-next-line no-await-in-loop -- Delivery transitions serialize merges and remote recovery per project.
      await reconcileTask(context, task);
    } catch (error) {
      context.repository.editTask(task.id, (current) => {
        return {
          ...current,
          error: Error.isError(error) ? error.message : 'Delivery reconciliation failed.',
        };
      });
    }
  }
  await flushEffects(context);
  await reconcileSuperseded(context);
  await flushEffects(context);
  await closeParents(context);
  await flushEffects(context);
}

/**
 * Provision one reviewed feature through stable issue identities.
 *
 * @param context - Project services.
 * @param feature - Reviewed product objective.
 * @throws {MeshError} For invalid scope or dependency mappings.
 */
async function provisionFeature(context: FactoryContext, feature: Feature): Promise<void> {
  if (isIntakeParked(context, feature)) {
    return;
  }
  const mappings = await context.remote.provision(feature, (created, repositoryId) => {
    retainProvisionedIssues(context.repository, feature.id, repositoryId, created);
  });
  const current = context.repository.features().find((candidate) => candidate.id === feature.id);
  if (current?.phase !== 'provisioning') {
    if (current?.scopeReplacement !== undefined) {
      retainSupersededMappings(context, current, mappings);
    }
    return;
  }
  const scopes = feature.plan?.deliveries ?? [];
  const existing = context.repository.tasks();
  const ids = new Map(
    mappings.map((mapping): readonly [string, string] => {
      const id = existing.find((candidate) => candidate.issue === mapping.issue)?.id ?? randomUUID();
      return [mapping.key, id];
    }),
  );
  for (const mapping of mappings) {
    const scope = scopes.find((candidate) => candidate.key === mapping.key);
    if (scope === undefined) {
      throw new MeshError('INVALID_INPUT', 'The issue mapping no longer matches the reviewed plan.');
    }
    if (existing.some((candidate) => candidate.issue === mapping.issue)) {
      continue;
    }
    const task = deliveryTask(
      context,
      { ...scope, issue: mapping.issue, parentIssue: mapping.parentIssue },
      feature.id,
    );
    context.repository.addTask({
      ...task,
      id: ids.get(mapping.key) ?? task.id,
      key: mapping.key,
      capabilityTier: scope.capabilityTier,
      assignmentProfiles: scope.assignmentProfiles,
      skills: scope.skills,
      dependencies: scope.dependencies.map((key) => {
        const id = ids.get(key);
        if (id === undefined) {
          throw new MeshError('INVALID_INPUT', 'Missing provisioned dependency.');
        }
        return id;
      }),
    });
  }
  context.repository.saveFeature({
    ...current,
    phase: 'active',
    parentIssue: mappings[0]?.parentIssue ?? null,
    error: null,
    updatedAt: context.repository.store.now(),
  });
}

/**
 * Retain issue identities from an already-sent creation operation without making
 * its obsolete children eligible for import or dispatch.
 *
 * @param context - Project ledger.
 * @param feature - Current superseded objective.
 * @param mappings - Confirmed remote creation receipts.
 */
function retainSupersededMappings(
  context: FactoryContext,
  feature: Feature,
  mappings: readonly { key: string; issue: number; parentIssue: number }[],
): void {
  context.repository.store.transaction(() => {
    for (const mapping of mappings) {
      if (context.repository.tasks().some((candidate) => candidate.issue === mapping.issue)) {
        continue;
      }
      const scope = feature.plan?.deliveries.find((entry) => entry.key === mapping.key);
      const task = deliveryTask(
        context,
        {
          issue: mapping.issue,
          parentIssue: mapping.parentIssue,
          title: scope?.title ?? 'Superseded remote scope',
          description: scope?.description ?? feature.objective,
          acceptanceCriteria: scope?.acceptanceCriteria ?? ['Superseded; do not implement.'],
        },
        feature.id,
      );
      context.repository.addTask({
        ...task,
        scopeReplacement: feature.scopeReplacement,
        phase: 'blocked',
        error: feature.error,
      });
    }
    context.repository.saveFeature({ ...feature, parentIssue: mappings[0]?.parentIssue ?? feature.parentIssue });
  });
}

/**
 * Fence a resumed unpaid operation against operator edits committed during I/O.
 *
 * @param context - Authoritative delivery ledger.
 * @param task - Snapshot used to initiate the external operation.
 * @returns Whether the exact scope revision remains eligible.
 */
function isCurrent(context: FactoryContext, task: FactoryTask): boolean {
  const current = context.repository.task(task.id);
  return current.version === task.version && current.scopeReplacement === undefined;
}

/**
 * Reconcile one delivery stage without paid inference.
 *
 * @param context - Project services.
 * @param task - Durable stage intent.
 */
async function reconcileTask(context: FactoryContext, task: FactoryTask): Promise<void> {
  if (task.scopeReplacement !== undefined) {
    await recoverSupersededMerge(context, task);
    return;
  }
  if (await hasParkedPRUpdate(context, task)) {
    return;
  }
  switch (task.phase) {
    case 'publishing': {
      await publish(context, task);
      break;
    }

    case 'review':
    case 'merge_ready':
    case 'merging': {
      await inspect(context, task);
      break;
    }

    case 'closing': {
      await closeVerified(context, task);
      break;
    }

    case 'done': {
      await completionEffects(context, task);
      break;
    }
    case 'ready':
    case 'development':
    case 'blocked':
    case 'verifying':
  }
}

/**
 * Recover a confirmed merge only with matching independent approval proof.
 *
 * @param context - Durable ledger.
 * @param task - Reviewed source.
 * @param pr - Actual GitHub state.
 */
function recoverMerge(context: FactoryContext, task: FactoryTask, pr: PullRequest): void {
  const record = task;
  if (!hasApprovals(record) || !hasFinalApproval(record) || record.head !== pr.headRefOid || pr.mergeCommit === null) {
    context.repository.editTask(record.id, (current) => {
      return {
        ...current,
        phase: 'blocked',
        error: 'This PR was merged without the current factory QA/final gates. Investigate before closing its issue.',
      };
    });
    return;
  }
  context.repository.editTask(record.id, (current) => {
    return {
      ...current,
      phase: 'verifying',
      merge: pr.mergeCommit?.oid ?? null,
      error: null,
    };
  });
  logObjective(context.repository.store, record.featureId, {
    kind: 'delivery',
    actor: 'supervisor',
    body: `#${String(record.issue)} ${record.title} merged as ${shortSha(pr.mergeCommit.oid)}; verifying on main.`,
  });
  context.repository.notify(
    `Merged #${String(record.pr)} into ${context.settings.baseBranch}. Every developer must refresh main before its next submission.`,
  );
}
