/**
 * Public factory state is a projection of one durable ledger.
 *
 * @file
 */
import { conversationWindow } from './conversations.ts';
import { ownedProcessUsage } from './process-usage.ts';
import { PROVIDERS } from './schema.ts';
import { workflowState } from './workflow.ts';

import type { MeshConfig } from '../config.ts';
import type { FactoryRepository } from './repository.ts';
import type { ResourceSnapshot } from './resources.ts';

/**
 * Project the current ledger without invoking a model or remote operation.
 *
 * @param repository - Selected project ledger.
 * @param mesh - Project-local runtime boundaries.
 * @param telemetry - Current supervisor connection and machine measurements.
 * @returns Operator/MCP projection with explicit unknown telemetry.
 */
export function factoryStatus(
  repository: FactoryRepository,
  mesh: MeshConfig,
  telemetry: { connected: boolean; error: string | null; resources: ResourceSnapshot },
): unknown {
  const settings = repository.config();
  return {
    configured: settings !== null,
    active: repository.active(),
    connected: telemetry.connected,
    error: telemetry.error,
    resources: telemetry.resources,
    processUsage: ownedProcessUsage(repository.jobs()),
    settings,
    features: repository.features(),
    tasks: repository.tasks(),
    jobs: repository.jobs(),
    pendingEffects: repository.effects(),
    skillRequests: repository.skillRequests(),
    instructions: repository.instructionLedger.recent(),
    conversations: conversationWindow(repository.store, mesh),
    workflow: workflowState(repository),
    capacities: settings === null ? [] : PROVIDERS.map((provider) => repository.capacity(provider, settings)),
  };
}
