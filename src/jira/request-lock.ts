/**
 * One owner per Jira request at a time. A lock file next to the request's
 * journal is created exclusively before reconciliation and removed after the
 * journal records the result, so two callers, in one process or in several
 * sharing the ledger, can never both decide that nothing exists yet and both
 * create it. A lock left by a crashed owner is taken over once it is stale.
 *
 * @file
 */
import { rmSync, statSync } from 'node:fs';

import { writeIfAbsent } from '../config.ts';
import { MeshError } from '../protocol.ts';

/** Milliseconds per minute. */
const MINUTE_MS = 60_000;
/** Minutes a lock may be held before another caller may assume its owner died. */
const LOCK_STALE_MINUTES = 5;
/** How long a lock may be held before another caller may assume its owner died. */
export const LOCK_STALE_MS = LOCK_STALE_MINUTES * MINUTE_MS;

/**
 * Run an operation while holding a request's lock.
 *
 * @param file - Lock file path, next to the request's journal.
 * @param now - Current time.
 * @param operation - Reconcile-or-perform work, completed while the lock is held.
 * @returns The operation's result.
 * @throws {MeshError} FACTORY_GATED while another caller holds a fresh lock for the same request.
 */
export async function withRequestLock<T>(file: string, now: number, operation: () => Promise<T>): Promise<T> {
  if (writeIfAbsent(file, `${JSON.stringify({ pid: process.pid, at: now })}\n`) !== 'created') {
    let age = Infinity;
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- The project's own private request journal.
      age = now - statSync(file).mtimeMs;
    } catch {
      // The holder finished between our attempt and this check; try once more below.
    }
    if (age < LOCK_STALE_MS) {
      throw new MeshError(
        'FACTORY_GATED',
        'This Jira request is already in progress; retry it once that attempt ends.',
      );
    }
    rmSync(file, { force: true });
    if (writeIfAbsent(file, `${JSON.stringify({ pid: process.pid, at: now })}\n`) !== 'created') {
      throw new MeshError(
        'FACTORY_GATED',
        'This Jira request is already in progress; retry it once that attempt ends.',
      );
    }
  }
  try {
    return await operation();
  } finally {
    rmSync(file, { force: true });
  }
}
