/**
 * Human exceptions cover one measured source pair, never project-wide gates.
 *
 * @file
 */
import { MeshError } from '../protocol.ts';

import type { FactoryRepository } from './repository.ts';
import type { FactoryTask } from './schema.ts';

/** One exact measured diff. */
type PublicationSize = NonNullable<FactoryTask['publicationGate']>;

/** Why a validated delivery could not be published. */
export type PublicationReason = 'nothing_to_commit' | 'empty_diff' | 'already_merged' | 'over_limit';

/** Operator-facing explanation of each empty-publication reason. */
const EMPTY_PUBLICATION: Readonly<Record<Exclude<PublicationReason, 'over_limit'>, string>> = {
  nothing_to_commit:
    'The agent finished without changing any file and the branch has no commits of its own, so there is nothing to publish. Retry with a clearer scope, or close the delivery if the work is already done.',
  already_merged:
    'Every commit on this delivery branch is already on main, so the work was merged elsewhere. Reconcile the delivery as delivered instead of publishing it again.',
  empty_diff:
    'The delivery has commits of its own, but together they change nothing compared with current main: their edits cancel out or main already contains them. Reconcile already-delivered work or rework the scope.',
};

/** A delivery with nothing new to publish, with the exact reason. */
export class EmptyPublicationError extends MeshError {
  /** Which kind of empty publication this is. */
  public readonly reason: Exclude<PublicationReason, 'over_limit'>;

  /**
   * Name the reason in both the code and the message.
   *
   * @param reason - Why nothing can be published.
   */
  public constructor(reason: Exclude<PublicationReason, 'over_limit'>) {
    super('FACTORY_GATED', EMPTY_PUBLICATION[reason]);
    this.name = 'EmptyPublicationError';
    this.reason = reason;
  }
}

/**
 * Classify a publication whose diff against main is empty.
 *
 * @param facts - Branch state measured by the publisher.
 * @param facts.ownCommitsBefore - Commits the branch had beyond main before refreshing.
 * @param facts.ownCommitsAfter - Commits it has beyond main after refreshing.
 * @param facts.hadEdits - Whether the agent left uncommitted edits to commit.
 * @returns `empty_diff` when own commits remain, `nothing_to_commit` when the agent changed nothing, else `already_merged`.
 */
export function emptyPublicationReason(facts: {
  ownCommitsBefore: number;
  ownCommitsAfter: number;
  hadEdits: boolean;
}): Exclude<PublicationReason, 'over_limit'> {
  if (facts.ownCommitsAfter > 0) {
    return 'empty_diff';
  }
  return facts.ownCommitsBefore === 0 && !facts.hadEdits ? 'nothing_to_commit' : 'already_merged';
}

/** A validated delivery is parked for a human size decision. */
export class PublicationSizeError extends MeshError {
  /** Exact source whose checks already passed. */
  public readonly measured: PublicationSize;
  /** Always `over_limit`, so every publication failure names its reason the same way. */
  public readonly reason = 'over_limit' satisfies PublicationReason;

  /**
   * Preserve structured measurements instead of an ambiguous combined error.
   *
   * @param measured - Actual diff after refreshing main and running checks.
   */
  public constructor(measured: PublicationSize) {
    super(
      'FACTORY_GATED',
      `Validated PR has ${String(measured.lines)} changed lines in ${String(measured.files)} files. Split the scope or approve this exact size exception in Mission.`,
    );
    this.name = 'PublicationSizeError';
    this.measured = measured;
  }
}

/**
 * Require an exact human approval only when a configured size ceiling is exceeded.
 *
 * @param measured - Refreshed head/base and actual numstat.
 * @param policy - Configured project ceilings.
 * @param approved - Previously approved exact source, if any.
 * @throws {PublicationSizeError} For oversized unapproved or changed source.
 */
export function assertPublicationSize(
  measured: PublicationSize,
  policy: { maxFiles: number; maxDiffLines: number },
  approved?: PublicationSize,
): void {
  if (measured.files <= policy.maxFiles && measured.lines <= policy.maxDiffLines) {
    return;
  }
  if (
    approved?.head === measured.head &&
    approved.base === measured.base &&
    approved.lines === measured.lines &&
    approved.files === measured.files
  ) {
    return;
  }
  throw new PublicationSizeError(measured);
}

/**
 * Apply a human exception only to a validated blocked publication checkpoint.
 *
 * @param repository - Current ledger.
 * @param task - Validated displayed task revision.
 * @param reason - Human explanation for preserving this indivisible diff.
 * @throws {MeshError} For absent or changed evidence or an empty reason.
 */
export function approvePublicationSize(repository: FactoryRepository, task: FactoryTask, reason: string): void {
  const gate = task.publicationGate;
  if (
    gate === undefined ||
    reason === '' ||
    task.phase !== 'blocked' ||
    task.head !== gate.head ||
    task.base !== gate.base
  ) {
    throw new MeshError('FACTORY_GATED', 'A size exception needs a validated exact-source blocker and your reason.');
  }
  repository.editTask(task.id, (current) => {
    return {
      ...current,
      phase: 'publishing',
      error: null,
      sizeApproval: { ...gate, reason, at: repository.store.now() },
    };
  });
}
