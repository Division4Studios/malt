/**
 * Durable factory broadcasts inside the caller's state transition.
 *
 * @file
 */
import { z } from 'zod/v3';

import { selectAll } from '../database.ts';

import type { Store } from '../store.ts';

/**
 * Notify live logical agents without creating model sessions; observer and
 * system identities are never broadcast targets.
 *
 * @param store - Current transaction's project store.
 * @param sender - Supervisor identity, if prepared.
 * @param body - Public transition summary.
 */
export function broadcastFactoryNotice(store: Store, sender: string | null, body: string): void {
  if (sender === null) {
    return;
  }
  const agents = selectAll(
    store.db,
    z.object({ id: z.string() }),
    "SELECT id FROM agents WHERE lifetime != 'ended' AND role != 'observer'",
  );
  for (const agent of agents) {
    if (agent.id !== sender) {
      store.send(sender, agent.id, { body, type: 'broadcast' });
    }
  }
}
