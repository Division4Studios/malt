/**
 * Reconcile native GitHub blocked-by relationships without replacing existing user edges.
 *
 * @file
 */
import { z } from 'zod/v3';

import { MeshError } from '../protocol.ts';

import type { GitHubRunner } from '../github.ts';
import type { DeliveryPlanIssue } from './scheduler.ts';
import type { AgentResult } from './schema.ts';

/** Native database IDs, rather than repository-local issue numbers, identify dependency writes. */
const issueIdentity = z.object({ id: z.number().int().positive() });
/** Paginated native edges are authoritative after an ambiguous successful write. */
const dependencyPages = z.array(z.array(issueIdentity));
/** Explicit supported API version for native issue dependency endpoints. */
const API_HEADER = 'X-GitHub-Api-Version: 2026-03-10';

/**
 * Add one set-like native edge after inspecting its actual current state.
 *
 * @param runner - Authenticated native GitHub boundary.
 * @param repository - Verified owner/repository identity.
 * @param issue - Child issue number.
 * @param blocker - Dependency's native database ID.
 */
async function ensureEdge(runner: GitHubRunner, repository: string, issue: number, blocker: number): Promise<void> {
  const endpoint = `repos/${repository}/issues/${String(issue)}/dependencies/blocked_by`;
  const pages = dependencyPages.parse(await runner(['api', endpoint, '--paginate', '--slurp', '-H', API_HEADER]));
  if (pages.flat().some((edge) => edge.id === blocker)) {
    return;
  }
  await runner(['api', endpoint, '--method', 'POST', '-H', API_HEADER, '--input', '-'], { issue_id: blocker });
}

/**
 * Publish reviewed dependency edges after all atomic native children have stable identities.
 *
 * @param runner - Native GitHub CLI adapter or isolated fixture boundary.
 * @param repository - Selected target connection, never a global repository.
 * @param mappings - Existing idempotently provisioned children.
 * @param scopes - Independently reviewed dependency-aware plan.
 * @throws {MeshError} For missing scope mappings; unsupported APIs remain provisioning blockers.
 */
export async function reconcileDependencies(
  runner: GitHubRunner,
  repository: string,
  mappings: readonly DeliveryPlanIssue[],
  scopes: AgentResult['deliveries'],
): Promise<void> {
  const ids = new Map<string, number>();
  for (const scope of scopes) {
    const issue = mappings.find((mapping) => mapping.key === scope.key);
    if (issue === undefined) {
      throw new MeshError('INVALID_INPUT', 'Missing native child for a dependency-aware scope.');
    }
    for (const dependency of scope.dependencies) {
      const blocker = mappings.find((mapping) => mapping.key === dependency);
      if (blocker === undefined) {
        throw new MeshError('INVALID_INPUT', 'Missing native blocking child.');
      }
      let id = ids.get(dependency);
      if (id === undefined) {
        const actual = issueIdentity.parse(
          // eslint-disable-next-line no-await-in-loop -- Native identity is fetched once before dependent edge mutations.
          await runner(['api', `repos/${repository}/issues/${String(blocker.issue)}`]),
        );
        id = actual.id;
        ids.set(dependency, id);
      }
      // eslint-disable-next-line no-await-in-loop -- Each native set-like edge is inspected and added sequentially; ambiguous retries inspect it again.
      await ensureEdge(runner, repository, issue.issue, id);
    }
  }
}
