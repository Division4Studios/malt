/** @file Semantic local objective observations for safe intake and human freshness decisions. */
import { createHash } from 'node:crypto';

import type { FactoryRepository } from './repository.ts';
import type { RecommendationBody } from './schema.ts';

/**
 * Observe scope and retained child ownership/acceptance without hashing transient execution state.
 *
 * @param repository - Actual selected project ledger.
 * @param id - Existing local objective identity, never an arbitrary path.
 * @returns Semantic content address, or null for missing/superseded objectives.
 */
export function objectiveObservation(
  repository: FactoryRepository,
  id: string,
): { id: string; revision: string } | null {
  const feature = repository.features().find((item) => item.id === id);
  if (feature === undefined || feature.scopeReplacement !== undefined) {
    return null;
  }
  const children = repository
    .tasks()
    .filter((task) => task.featureId === id)
    .map((task) => {
      return {
        id: task.id,
        issue: task.issue,
        acceptance: task.acceptanceCriteria,
        dependencies: task.dependencies.toSorted((a, b) => a.localeCompare(b)),
        developer: task.developer,
        scopeReplacement: task.scopeReplacement,
      };
    })
    .toSorted((a, b) => a.id.localeCompare(b.id));
  const scope = {
    objective: feature.objective,
    parentIssue: feature.parentIssue,
    productPlan: feature.productPlan,
    plan: feature.plan,
    children,
  };
  return { id, revision: createHash('sha256').update(JSON.stringify(scope)).digest('hex') };
}

/**
 * Recheck every local reference at both sides of an asynchronous native issue inspection.
 *
 * @param repository - Selected project only.
 * @param observed - Exact proposal observations; absent on historical native-ticket proposals.
 * @returns Whether each current semantic scope still agrees.
 */
export function areObjectivesCurrent(
  repository: FactoryRepository,
  observed: RecommendationBody['observedObjectives'],
): boolean {
  return (observed ?? []).every((item) => objectiveObservation(repository, item.id)?.revision === item.revision);
}
