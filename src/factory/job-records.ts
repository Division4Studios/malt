/**
 * Build the durable record of one bounded attempt from a scheduling intent.
 *
 * @file
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { featureWorkflow, stepOf, taskWorkflow } from './pipeline.ts';
import { LEASE_MS } from './schema.ts';
import { grantedSecrets } from './vault.ts';

import type { FactoryContext } from './context.ts';
import type { JobIntent } from './scheduler.ts';
import type { FactoryJob, FactoryTask, Provider } from './schema.ts';

/**
 * The organization profile a workflow step assigns, if any.
 *
 * @param context - Project ledger.
 * @param intent - Scheduled step.
 * @param task - Its delivery, if any.
 * @returns Profile name, or `null` to use the seat's own type.
 */
export function stepProfile(context: FactoryContext, intent: JobIntent, task: FactoryTask | null): string | null {
  if (intent.step === undefined || intent.step === null) {
    return null;
  }
  const features = context.repository.features();
  const workflow =
    task === null
      ? featureWorkflow(features.find((feature) => feature.id === intent.featureId))
      : taskWorkflow(task, features);
  return stepOf(workflow, { step: intent.step })?.profile ?? null;
}

/**
 * A running attempt for an intent, before its transactional claim.
 *
 * @param context - Project policy and ledger.
 * @param intent - Scheduled step for one seat.
 * @param admitted - Admitted provider family and its frozen routing.
 * @param admitted.provider - Provider family.
 * @param admitted.routing - Routing resolved at admission.
 * @returns Attempt record with a fresh fencing token and the names of the secrets its role type is granted.
 */
export function attemptRecord(
  context: FactoryContext,
  intent: JobIntent,
  { provider, routing }: { provider: Provider; routing: NonNullable<FactoryJob['routing']> },
): FactoryJob {
  const id = randomUUID();
  const now = context.repository.store.now();
  return {
    role: intent.role,
    kind: intent.kind,
    taskId: intent.taskId,
    featureId: intent.featureId,
    head: intent.head,
    base: intent.base,
    step: intent.step ?? null,
    target: intent.target ?? null,
    id,
    provider,
    routing:
      routing.organization === undefined
        ? routing
        : {
            ...routing,
            organization: {
              ...routing.organization,
              secrets: grantedSecrets(context.repository.store, routing.organization.type),
            },
          },
    token: randomUUID(),
    state: 'running',
    startedAt: now,
    finishedAt: null,
    expiresAt: now + LEASE_MS,
    reservation: context.settings.providers[provider].reservationTokens,
    usageTokens: null,
    pid: null,
    summary: null,
    artifact: path.join(context.mesh.directory, 'factory', 'jobs', id),
  };
}
