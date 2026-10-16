/** @file Shared durable native issue identities, reused by provisioning and unpaid intake. */
import { createHash } from 'node:crypto';

import { z } from 'zod/v3';

import type { ProjectGitHub } from '../github.ts';
import type { OperationSnapshot } from './duplicate-detection.ts';

/** Existing native child request digest length; never change historical operation identities. */
const REQUEST_HASH_LENGTH = 32;
/** Project journal fields needed for reuse; private issue prose is intentionally omitted. */
const journalSchema = z.object({
  input: z.object({ requestId: z.string() }),
  phase: z.string(),
  issue: z.object({ number: z.number() }).optional(),
});
/** Existing authoritative GitHub creation journal, never a second operation store. */
const pendingSchema = z.object({ pendingOperations: z.array(journalSchema) });

/**
 * Identify one reviewed native child across interrupted provisioning.
 *
 * @param featureId - Original durable objective.
 * @param key - Original independently reviewed atomic scope key.
 * @returns The existing GitHub creation journal identity.
 */
export function deliveryOperationIdentity(featureId: string, key: string): string {
  const digest = createHash('sha256').update(`${featureId}:${key}`).digest('hex').slice(0, REQUEST_HASH_LENGTH);
  return `delivery-${digest}`;
}

/**
 * Inspect the existing local journal before proposing duplicate work.
 *
 * @param github - Verified selected-project integration.
 * @returns Original unresolved native request identities.
 */
export async function readProvisioningOperations(github: ProjectGitHub): Promise<OperationSnapshot[]> {
  const status = pendingSchema.parse(await github.execute('github_status', {}));
  return status.pendingOperations.map((operation) => {
    return {
      identity: operation.input.requestId,
      resolved: operation.phase === 'complete',
      issue: operation.issue?.number,
    };
  });
}
