/**
 * Durable operator stop transitions, independent of transport and process handles.
 *
 * @file
 */

import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { MeshError } from '../protocol.ts';
import { writeAtomic } from '../summary.ts';

import { updateModelPolicy } from './model-policy.ts';
import { hasCriticalMemoryPressure } from './resources.ts';
import { factoryConfigSchema, factorySchemas } from './schema.ts';
import { installFactorySkills } from './skills.ts';

import type { MeshConfig } from '../config.ts';
import type { FactoryContext } from './context.ts';
import type { FactoryRepository } from './repository.ts';
import type { ResourceSnapshot } from './resources.ts';
import type { FactoryJob, FactoryOperation } from './schema.ts';
import type { Store } from '../store.ts';

/** Paused-only controls replacing project settings or model policy. */
const POLICY_CONTROLS = ['factory_setup', 'factory_model_policy'] as const;
/** A paused-only policy control. */
export type PolicyControl = (typeof POLICY_CONTROLS)[number];

/**
 * Recognize paused-only policy controls.
 *
 * @param operation - Validated factory operation.
 * @returns Whether it replaces settings or model policy.
 */
export function isPolicyControl(operation: FactoryOperation): operation is PolicyControl {
  return (POLICY_CONTROLS as readonly string[]).includes(operation);
}

/**
 * Replace factory settings or model policy; each control preserves the other's state.
 *
 * @param context - Selected project and its settling state.
 * @param context.mesh - Project configuration.
 * @param context.repository - Project ledger.
 * @param context.isSettling - Whether this supervisor still owns settling pipelines.
 * @param operation - Settings or model policy replacement.
 * @param input - Validated control input.
 * @throws {MeshError} When work is active or unsettled, or a policy revision is stale.
 */
export function applyPolicyControl(
  context: { mesh: MeshConfig; repository: FactoryRepository; isSettling: boolean },
  operation: PolicyControl,
  input: unknown,
): void {
  if (operation === 'factory_model_policy') {
    updateModelPolicy(context.repository, input, context.isSettling);
    return;
  }
  if (context.repository.active() || context.isSettling) {
    throw new MeshError('FACTORY_GATED', 'Pause managed work before changing project policies.');
  }
  const settings = factoryConfigSchema.parse(input);
  context.repository.configure(settings);
  installFactorySkills(context.mesh);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Factory policy and execution artifacts are stored in this project's managed directory.
  mkdirSync(path.join(context.mesh.directory, 'factory'), { recursive: true, mode: 0o700 });
  writeAtomic(path.join(context.mesh.directory, 'factory', 'config.json'), `${JSON.stringify(settings, null, 2)}\n`);
}

/**
 * Persist explicitly sourced provider telemetry without fabricating a quota.
 *
 * @param context - Configured project accounting.
 * @param input - Validated operator control boundary.
 * @throws {MeshError} When the supplied reset deadline is already past.
 */
export function recordCapacity(context: FactoryContext, input: unknown): void {
  const value = factorySchemas.factory_capacity.parse(input);
  if (value.resetAt <= context.repository.store.now()) {
    throw new MeshError('INVALID_INPUT', 'Quota reset must be in the future.');
  }
  context.repository.saveCapacity({
    ...context.repository.capacity(value.provider, context.settings),
    subscriptionUsedPercent: value.usedPercent,
    subscriptionResetAt: value.resetAt,
    telemetrySource: value.source,
    updatedAt: context.repository.store.now(),
  });
}

/**
 * Release a stopped assignment's managed identity so the next provider can reconnect immediately.
 *
 * @param store - Selected team's durable presence.
 * @param job - Current fenced attempt, after owned native processes have settled.
 */
export function retireManagedPresence(store: Store, job: FactoryJob): void {
  const actor = store
    .execute('list_agents', {}, null)
    .find((agent) => agent.name === `factory-${job.role}` && agent.runtime === 'factory-managed');
  if (actor !== undefined && actor.status !== 'OFFLINE') {
    store.execute('disconnect', {}, actor.id);
  }
}

/**
 * Route explicit quality/scope feedback to clarification and bounded research.
 *
 * @param repository - Current project's durable instruction ledger.
 * @param body - Validated human feedback.
 */
export function recordScopeFeedback(repository: FactoryRepository, body: string): void {
  repository.store.transaction(() => {
    repository.instruct(
      'product-owner',
      null,
      `Clarify observable acceptance for this feedback before implementation: ${body}`,
    );
    repository.instruct(
      'learning-steward',
      null,
      `Investigate operator feedback: ${body}. Identify causes and relevant maintained skills/tools/connectors, preserve licensing and propose tailored revisions. Distinguish project preferences from reusable MALT improvements; do not modify or hot-patch the factory source.`,
    );
  });
}

/**
 * Stop only this supervisor's owned pipelines under critical memory pressure.
 *
 * @param context - Selected project's validated resource policy and ledger.
 * @param running - Owned controllers retained until descendant teardown finishes.
 * @param resources - Current machine-wide counters.
 * @returns Whether admission must remain parked.
 */
export function shouldParkForMemory(
  context: FactoryContext,
  running: ReadonlyMap<string, { controller: AbortController }>,
  resources: ResourceSnapshot,
): boolean {
  if (!hasCriticalMemoryPressure(context.settings, resources)) {
    return false;
  }
  for (const [id, assignment] of running) {
    if (assignment.controller.signal.aborted) {
      continue;
    }
    context.repository.store.transaction(() => {
      context.repository.store.event('FACTORY_RESOURCE_STOP', null, {
        jobId: id,
        reason: 'Critical free-memory pressure; owned processes are stopping and work is preserved.',
      });
    });
    assignment.controller.abort();
  }
  return true;
}

/**
 * Block an explicitly cancelled active scope before aborting its owned process.
 *
 * @param repository - Selected project's durable ledger.
 * @param job - Verified live job owned by the current supervisor.
 */
export function recordCancellation(repository: FactoryRepository, job: FactoryJob): void {
  const error = 'Operator cancelled this attempt; explicit retry required.';
  if (job.taskId !== null) {
    repository.editTask(job.taskId, (task) => {
      return {
        ...task,
        phase: 'blocked',
        error,
        reviews: [],
        finalReview: null,
        verifiedMain: null,
      };
    });
    return;
  }
  if (job.featureId === null) {
    return;
  }
  const feature = repository.features().find((candidate) => candidate.id === job.featureId);
  if (feature !== undefined) {
    repository.saveFeature({ ...feature, phase: 'blocked', error, updatedAt: repository.store.now() });
  }
}

/**
 * Fence prior claims only after this supervisor acquires the sole durable lease.
 *
 * @param repository - Current project's claim ledger.
 * @param owned - Processes still settling in the current supervisor.
 */
export function recoverUnownedClaims(repository: FactoryRepository, owned: ReadonlyMap<string, unknown>): void {
  const stale = repository.jobs().filter((job) => job.state === 'running' && !owned.has(job.id));
  repository.prepareSender();
  for (const job of stale) {
    repository.finishJob(job, null, 'interrupted');
  }
}

/**
 * Application reports require the current stage and exact source, beyond merely reading guidance.
 *
 * @param context - Selected project's actual task state.
 * @param job - Result's original assignment.
 * @returns Whether the original stage/source is still eligible for completion.
 */
export function canApplyInstructionStage(context: FactoryContext, job: FactoryJob): boolean {
  if (job.taskId === null) {
    return true;
  }
  const task = context.repository.task(job.taskId);
  const stages = {
    develop: 'development',
    review: 'review',
    final: 'merge_ready',
    verify: 'verifying',
    plan: '',
    refine: '',
    learn: '',
    skill: '',
  } as const;
  return (
    task.phase === stages[job.kind] && (job.kind === 'develop' || (task.head === job.head && task.base === job.base))
  );
}
