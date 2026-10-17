/**
 * The typed failure a conflicted refresh onto current main raises, so the
 * supervisor can record a conflict repair round instead of failing the attempt.
 *
 * @file
 */
import { MeshError } from '../protocol.ts';

/** Conflicted paths named in the error message. */
const CONFLICT_PATHS_SHOWN = 10;
/** Conflicted paths kept on the error. */
const CONFLICT_PATHS_KEPT = 50;

/** A refresh onto current main stopped on conflicts; the owner's commits are kept. */
export class MergeConflictError extends MeshError {
  /** Conflicted paths. */
  public readonly files: readonly string[];
  /** Source whose merge conflicted. */
  public readonly head: string;
  /** Main it was merged with. */
  public readonly base: string;

  /**
   * Describe a conflicted refresh.
   *
   * @param conflict - Conflicted paths and both sides.
   * @param conflict.files - Conflicted paths.
   * @param conflict.head - Source whose merge conflicted.
   * @param conflict.base - Main it was merged with.
   */
  public constructor(conflict: { files: readonly string[]; head: string; base: string }) {
    super(
      'FACTORY_GATED',
      `Refreshing onto current main conflicts in ${conflict.files.length === 0 ? 'the worktree' : conflict.files.slice(0, CONFLICT_PATHS_SHOWN).join(', ')}.`,
    );
    this.name = 'MergeConflictError';
    this.files = conflict.files.slice(0, CONFLICT_PATHS_KEPT);
    this.head = conflict.head;
    this.base = conflict.base;
  }
}
