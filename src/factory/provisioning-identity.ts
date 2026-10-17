/** @file Shared durable native issue identities, reused by provisioning and unpaid intake. */
import { createHash } from 'node:crypto';

import { z } from 'zod/v3';

import { readIntakeMetadata, saveIntakeMetadata } from './intake-corpus.ts';

import type { CapabilityPrincipal } from '../capability-policy.ts';
import type { ProjectGitHub } from '../github.ts';
import type { OperationSnapshot } from './duplicate-detection.ts';
import type { FactoryRepository } from './repository.ts';
import type { DeliveryPlanIssue } from './scheduler.ts';

/** Existing native child request digest length; never change historical operation identities. */
const REQUEST_HASH_LENGTH = 32;
/** The supervisor reads the provisioning journal for the lead-reviewed plan it provisions. */
const SUPERVISOR: CapabilityPrincipal = { kind: 'supervisor', role: 'team-lead' };
/** Maximum retained issue identities for one original objective. */
const MAPPING_MAX = 1000;
/** Project journal fields needed for reuse; private issue prose is intentionally omitted. */
const journalSchema = z.object({
  input: z.object({ requestId: z.string() }),
  phase: z.string(),
  issue: z.object({ number: z.number() }).optional(),
});
/** Existing authoritative GitHub creation journal, never a second operation store. */
const pendingSchema = z.object({ pendingOperations: z.array(journalSchema) });
/** Factual native identities, distinct from dependency-ready tasks or approval state. */
const mappingsSchema = z.object({
  repositoryId: z.string().min(1),
  issues: z.array(z.number().int().positive()).max(MAPPING_MAX),
});

/**
 * Retain confirmed creation receipts before dependency linking can fail.
 *
 * @param repository - Durable project ledger.
 * @param featureId - Original objective identity.
 * @param repositoryId - Verified native source node.
 * @param mappings - Actually created native children and parent.
 */
export function retainProvisionedIssues(
  repository: FactoryRepository,
  featureId: string,
  repositoryId: string,
  mappings: readonly DeliveryPlanIssue[],
): void {
  const prior = provisionedIssues(repository, featureId, repositoryId);
  const confirmed = new Set(prior);
  for (const mapping of mappings) {
    confirmed.add(mapping.issue);
    confirmed.add(mapping.parentIssue);
  }
  const issues = [...confirmed].toSorted((left, right) => left - right);
  saveIntakeMetadata(
    repository,
    `factory_native_mappings:${featureId}`,
    mappingsSchema.parse({ repositoryId, issues }),
  );
}

/**
 * Exclude only confirmed creations belonging to the currently verified repository.
 *
 * @param repository - Selected project ledger.
 * @param featureId - Original objective identity.
 * @param repositoryId - Current verified native source.
 * @returns Own native numbers, never foreign-source receipts.
 */
export function provisionedIssues(repository: FactoryRepository, featureId: string, repositoryId: string): number[] {
  const prior = mappingsSchema.nullable().parse(readIntakeMetadata(repository, `factory_native_mappings:${featureId}`));
  return prior?.repositoryId === repositoryId ? prior.issues : [];
}

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
  const status = pendingSchema.parse(await github.execute(SUPERVISOR, 'github_status', {}));
  return status.pendingOperations.map((operation) => {
    return {
      identity: operation.input.requestId,
      resolved: operation.phase === 'complete',
      issue: operation.issue?.number,
    };
  });
}
