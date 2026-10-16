/** @file Paused history recovers abandoned terminals without stealing a live lease. */
import type { FactoryRepository } from './repository.ts';
import type { TerminalService } from './terminals.ts';

/** Active metadata needs an owner, unlike ended history. */
const ACTIVE: ReadonlySet<string> = new Set(['requested', 'starting', 'running', 'closing']);

/**
 * Recover abandoned metadata only under the real supervisor lease; launch nothing.
 *
 * @param repository - Exact project ledger.
 * @param terminals - Current in-process native ownership.
 * @param owner - This supervisor's identity.
 * @param shouldKeepLease - Existing supervisor keeps its normal heartbeat.
 */
export function recoverTerminalMetadata(
  repository: FactoryRepository,
  terminals: TerminalService,
  owner: string,
  shouldKeepLease: boolean,
): void {
  if (terminals.size > 0 || repository.terminals.list().every((session) => !ACTIVE.has(session.state))) {
    return;
  }
  if (repository.lease(owner)) {
    try {
      terminals.recover();
    } finally {
      if (!shouldKeepLease) {
        repository.release(owner);
      }
    }
  }
}
