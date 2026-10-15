/**
 * Public factory state is a projection of one durable ledger.
 *
 * @file
 */
import { conversationWindow } from './conversations.ts';
import { ownedProcessUsage } from './process-usage.ts';
import { PROVIDERS } from './schema.ts';
import { triageStatus } from './triage.ts';
import { workflowState } from './workflow.ts';

import type { MeshConfig } from '../config.ts';
import type { FactoryRepository } from './repository.ts';
import type { AdmissionEvidence, ResourceSnapshot } from './resources.ts';

/**
 * Project the current ledger without invoking a model or remote operation.
 *
 * @param repository - Selected project ledger.
 * @param mesh - Project-local runtime boundaries.
 * @param telemetry - Current supervisor connection and machine measurements.
 * @returns Operator/MCP projection with explicit unknown telemetry.
 */
export async function factoryStatus(
  repository: FactoryRepository,
  mesh: MeshConfig,
  telemetry: { connected: boolean; error: string | null; resources: ResourceSnapshot; admission: AdmissionEvidence },
): Promise<unknown> {
  const settings = repository.config();
  const processUsage = await ownedProcessUsage(repository.jobs());
  return {
    configured: settings !== null,
    active: repository.active(),
    connected: telemetry.connected,
    error: telemetry.error,
    resources: telemetry.resources,
    admission: telemetry.admission,
    processUsage,
    settings,
    ...repository.objectiveQueue.snapshot(),
    tasks: repository.tasks(),
    triage: triageStatus(repository),
    jobs: repository.jobs(),
    pendingEffects: repository.effects(),
    skillRequests: repository.skillRequests(),
    instructions: repository.instructionLedger.recent(),
    conversations: conversationWindow(repository.store, mesh),
    workflow: workflowState(repository),
    capacities: settings === null ? [] : PROVIDERS.map((provider) => repository.capacity(provider, settings, false)),
  };
}
