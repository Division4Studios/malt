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

/** A validated delivery is parked for a human size decision. */
export class PublicationSizeError extends MeshError {
  /** Exact source whose checks already passed. */
  public readonly measured: PublicationSize;

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
