/**
 * Public factory state is a projection of one durable ledger.
 *
 * @file
 */
import { automationsStatus } from './automations.ts';
import { consoleView } from './console-view.ts';
import { conversationWindow } from './conversations.ts';
import { handoffFeed } from './handoff-feed.ts';
import { policyBlocker } from './policy-blockers.ts';
import { ownedProcessUsage } from './process-usage.ts';
import { PROVIDERS } from './schema.ts';
import { triageStatus } from './triage.ts';
import { workflowState } from './workflow.ts';
import { workflowLibrary } from './workflows.ts';

import type { MeshConfig } from '../config.ts';
import type { FactoryRepository } from './repository.ts';
import type { AdmissionEvidence, ResourceSnapshot } from './resources.ts';

// The broker-side doctor checks are a read-only projection too.
export { preflight } from './preflight.ts';

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
  const queue = repository.objectiveQueue.snapshot();
  return {
    configured: settings !== null,
    active: repository.active(),
    connected: telemetry.connected,
    error: telemetry.error ?? policyBlocker(repository),
    resources: telemetry.resources,
    admission: telemetry.admission,
    processUsage,
    settings,
    ...queue,
    // Frozen workflow copies stay server-side; the console projection describes each pipeline.
    features: queue.features.map((feature) => ({ ...feature, workflow: undefined })),
    tasks: repository.tasks().map((task) => ({ ...task, workflow: undefined })),
    console: consoleView(repository),
    triage: triageStatus(repository),
    jobs: repository.jobs(),
    pendingEffects: repository.effects(),
    skillRequests: repository.skillRequests(),
    instructions: repository.instructionLedger.recent(),
    conversations: conversationWindow(repository.store, mesh),
    handoffs: handoffFeed(repository.store, mesh),
    workflow: workflowState(repository),
    workflows: workflowLibrary(repository.store).status(),
    automations: automationsStatus(repository.store),
    // Where local scripts POST webhook triggers; the team header addresses a workspace project.
    triggerEndpoint: { url: mesh.url, team: mesh.team ?? null },
    capacities: settings === null ? [] : PROVIDERS.map((provider) => repository.capacity(provider, settings, false)),
  };
}
