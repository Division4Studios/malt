/**
 * Durable issue comments queued through the remote outbox.
 *
 * @file
 */

import type { FactoryContext } from './context.ts';
import type { FactoryTask } from './schema.ts';

/**
 * Persist a deterministic outbox effect tied to a particular delivery revision.
 *
 * @param context - Workspace ledger.
 * @param task - Current delivery revision.
 * @param value - Public finding or completion evidence.
 */
export function queueComment(context: FactoryContext, task: FactoryTask, value: string): void {
  context.repository.enqueueEffect({
    id: `${task.id}:${String(task.version)}:comment`,
    kind: 'comment',
    issue: task.issue,
    value,
    attempts: 0,
    retryAt: 0,
    error: null,
  });
}
