/**
 * Work bound to the external work tracker. Intake files each issue a
 * tracker's configured filter offers as one objective whose parent is that
 * issue, exactly once: the objective's identity is derived from the issue's
 * stable ID, and an issue already parenting an objective is never offered
 * again. The tracker fence refuses to switch the work tracker while work it
 * tracks is live, because the ledger addresses issues by numeric handles that
 * another tracker's issues could reuse.
 *
 * @file
 */
import { createHash } from 'node:crypto';

import { MeshError } from '../protocol.ts';

import { automaticWorkflow, queueObjective } from './objectives.ts';

import type { FactoryContext } from './context.ts';
import type { IntakeCandidate } from './remote.ts';
import type { FactoryRepository } from './repository.ts';

/** Hex digits of a UUID. */
const UUID_HEX = 32;

/**
 * The objective ID an intake issue is filed under, the same on every read.
 *
 * @param projectId - Workspace identity.
 * @param candidate - Offered issue.
 * @returns UUID-shaped identity derived from the tracker and the issue's stable ID.
 */
export function intakeObjectiveId(projectId: string, candidate: Pick<IntakeCandidate, 'issue' | 'key'>): string {
  const hex = createHash('sha256')
    .update(`${projectId}:tracker-intake:${candidate.key.provider}:${String(candidate.issue)}`)
    .digest('hex')
    .slice(0, UUID_HEX);
  return hex.replace(/^(?<a>.{8})(?<b>.{4})(?<c>.{4})(?<d>.{4})(?=.{12}$)/v, '$<a>-$<b>-$<c>-$<d>-');
}

/**
 * File one offered issue as an objective whose parent is that issue.
 *
 * @param context - Project ledger.
 * @param candidate - Offered issue.
 */
function fileCandidate(context: FactoryContext, candidate: IntakeCandidate): void {
  const { repository } = context;
  const id = intakeObjectiveId(context.mesh.projectId, candidate);
  if (repository.features().every((entry) => entry.id !== id)) {
    queueObjective(repository, {
      objective: candidate.objective,
      requestId: id,
      workflowId: automaticWorkflow(repository).workflow.id,
    });
  }
  const feature = repository.features().find((entry) => entry.id === id);
  if (feature?.parentIssue === null) {
    repository.saveFeature({
      ...feature,
      parentIssue: candidate.issue,
      parentKey: candidate.key,
      updatedAt: repository.store.now(),
    });
  }
}

/**
 * File the tracker's new intake matches as objectives. A failed read is
 * recorded by the remote and retried on a later pass; a full objective queue
 * stops filing until work completes.
 *
 * @param context - Project ledger and delivery remote.
 */
export async function fileTrackerObjectives(context: FactoryContext): Promise<void> {
  const { remote, repository } = context;
  if (remote.intake === undefined) {
    return;
  }
  const filed = new Set(repository.features().flatMap((feature) => feature.parentIssue ?? []));
  let candidates: readonly IntakeCandidate[];
  try {
    candidates = await remote.intake(filed);
  } catch {
    // The remote records the failure where the console shows it; the next pass reads again.
    return;
  }
  for (const candidate of candidates) {
    try {
      fileCandidate(context, candidate);
    } catch (error) {
      repository.notify(
        `Intake did not file ${candidate.key.key}: ${Error.isError(error) ? error.message : 'the objective was refused'}`,
      );
      return;
    }
  }
}

/**
 * How much ledger work is still bound to the current tracker.
 *
 * @param repository - Project ledger.
 * @returns Live deliveries, objectives with tracker issues, and pending remote effects.
 */
export function liveTrackerWork(repository: FactoryRepository): number {
  const tasks = repository.tasks().filter((task) => task.phase !== 'done' && task.scopeCleanup === undefined);
  const features = repository
    .features()
    .filter(
      (feature) => feature.parentIssue !== null && feature.phase !== 'done' && feature.scopeCleanup === undefined,
    );
  return tasks.length + features.length + repository.effects().length;
}

/**
 * Refuse a tracker switch while work tracked by the current tracker is live.
 *
 * @param repository - Project ledger.
 * @param change - Current and requested tracker.
 * @param change.from - Current tracker identity.
 * @param change.to - Requested tracker identity.
 * @throws {MeshError} FACTORY_GATED naming how much work is still live.
 */
export function assertTrackerSwitch(
  repository: FactoryRepository,
  change: { readonly from: string; readonly to: string },
): void {
  const live = liveTrackerWork(repository);
  if (live > 0) {
    throw new MeshError(
      'FACTORY_GATED',
      `The work tracker cannot change from ${change.from} to ${change.to} while ${String(live)} deliveries, objectives or tracker updates it tracks are still live: issue numbers of one tracker can be reused by the other. Finish, retire or supersede them first.`,
    );
  }
}
