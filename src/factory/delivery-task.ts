/**
 * The initial ledger task for a native delivery issue: dependency-ready, with
 * the owning objective's frozen workflow, merge gate and step overrides.
 *
 * @file
 */
import { randomUUID } from 'node:crypto';

import type { FactoryContext } from './context.ts';
import type { ReadyIssue } from './scheduler.ts';
import type { FactoryTask } from './schema.ts';

/**
 * Build one ledger task from a GitHub atomic issue.
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
    // Always frozen, so a later change to the objective's gate affects only deliveries provisioned after it.
    gates: { merge: feature?.gates?.merge ?? false },
    ...(feature?.stepOverrides !== undefined && { stepOverrides: feature.stepOverrides }),
    updatedAt: context.repository.store.now(),
  };
}
