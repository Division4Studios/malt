/**
 * The initial ledger task for a native delivery issue: dependency-ready, with
 * the owning objective's frozen workflow, merge gate and step overrides.
 *
 * @file
 */
import { randomUUID } from 'node:crypto';

import { objectiveGates } from './gate-controls.ts';
import { branchKey, issueKey, parentLabel } from './tracker-key.ts';

import type { FactoryContext } from './context.ts';
import type { FactoryRepository } from './repository.ts';
import type { ReadyIssue } from './scheduler.ts';
import type { FactoryTask, Feature } from './schema.ts';

/**
 * The objective an imported Ready issue belongs to: the one already recorded
 * for its parent, or a new active objective for that parent.
 *
 * @param repository - Project ledger.
 * @param issue - Imported delivery issue.
 * @returns Existing or newly saved objective.
 */
export function parentFeature(repository: FactoryRepository, issue: ReadyIssue): Feature {
  const existing = repository.features().find((candidate) => candidate.parentIssue === issue.parentIssue);
  if (existing !== undefined) {
    return existing;
  }
  const now = repository.store.now();
  const feature: Feature = {
    id: randomUUID(),
    objective: `Existing feature ${parentLabel(issue)}`,
    phase: 'active',
    productPlan: null,
    plan: null,
    parentIssue: issue.parentIssue,
    ...(issue.parentKey !== undefined && { parentKey: issue.parentKey }),
    error: null,
    createdAt: now,
    updatedAt: now,
    approvals: [],
    gates: objectiveGates(repository),
  };
  repository.saveFeature(feature);
  return feature;
}

/**
 * Build one ledger task from a native atomic issue, keeping a non-GitHub tracker's typed keys.
 *
 * @param context - Project ledger and clock.
 * @param issue - Native delivery issue.
 * @param featureId - Owning product request.
 * @returns Initial dependency-ready task state.
 */
export function deliveryTask(
  context: Pick<FactoryContext, 'repository'>,
  issue: ReadyIssue,
  featureId: string | null,
): FactoryTask {
  const feature = context.repository.features().find((candidate) => candidate.id === featureId);
  return {
    id: randomUUID(),
    featureId,
    issue: issue.issue,
    parentIssue: issue.parentIssue,
    ...(issue.trackerKey !== undefined && { trackerKey: issue.trackerKey }),
    ...(issue.parentKey !== undefined && { parentKey: issue.parentKey }),
    // `issue-12` for GitHub, as before; `proj-12` for Jira.
    key: branchKey(issueKey(issue)).toLowerCase(),
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
    // Always frozen, so a later change to the objective's gate affects only deliveries provisioned after it.
    gates: { merge: feature?.gates?.merge ?? false },
    ...(feature?.stepOverrides !== undefined && { stepOverrides: feature.stepOverrides }),
    updatedAt: context.repository.store.now(),
  };
}
