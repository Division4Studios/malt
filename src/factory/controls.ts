/**
 * Durable operator stop transitions, independent of transport and process handles.
 *
 * @file
 */

import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { MeshError } from '../protocol.ts';
import { writeAtomic } from '../summary.ts';

import { hasCriticalMemoryPressure } from './resources.ts';
import { factoryConfigSchema, factorySchemas } from './schema.ts';
import { installFactorySkills } from './skills.ts';
import { isCurrentTriage, cancelTriage } from './triage.ts';

import type { FactoryContext } from './context.ts';
import type { FactoryRepository } from './repository.ts';
import type { ResourceSnapshot } from './resources.ts';
import type { FactoryJob } from './schema.ts';
import type { MeshConfig } from '../config.ts';
import type { Store } from '../store.ts';

/**
 * Read dispatch authority afresh after an asynchronous external observation.
 *
 * @param repository - Current project ledger.
 * @param isStopped - Current supervisor shutdown state.
 * @returns Whether the supervisor may claim another assignment.
 */
export function canDispatch(repository: FactoryRepository, isStopped: boolean): boolean {
  return !isStopped && repository.active();
}

/**
 * Persist verified project policy without starting any agent.
 *
 * @param mesh - Selected project.
 * @param repository - Durable policy owner.
 * @param input - Untrusted operator policy.
 */
export function configureProject(mesh: MeshConfig, repository: FactoryRepository, input: unknown): void {
  const settings = factoryConfigSchema.parse(input);
  repository.configure(settings);
  installFactorySkills(mesh);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Private project policy directory.
  mkdirSync(path.join(mesh.directory, 'factory'), { recursive: true, mode: 0o700 });
  writeAtomic(path.join(mesh.directory, 'factory', 'config.json'), `${JSON.stringify(settings, null, 2)}\n`);
}

/**
 * Cancel only a currently owned managed assignment.
 *
 * @param repository - Durable claim owner.
 * @param running - Live handles in this supervisor.
 * @param input - Operator request.
 * @throws {MeshError} For absent or unowned jobs.
 */
export function cancelOwnedJob(
  repository: FactoryRepository,
  running: ReadonlyMap<string, { controller: AbortController }>,
  input: unknown,
): void {
  const { jobId } = factorySchemas.factory_cancel_job.parse(input);
  const job = repository.jobs().find((candidate) => candidate.id === jobId);
  if (job?.state !== 'running' || !running.has(jobId)) {
    throw new MeshError('FACTORY_GATED', 'Only a live job owned by this supervisor can be cancelled.');
  }
  recordCancellation(repository, job);
  running.get(jobId)?.controller.abort(new Error('Operator cancelled this attempt; explicit retry required.'));
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
    assignment.controller.abort(
      new Error('Critical free-memory pressure; owned processes are stopping and work is preserved.'),
    );
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
    repository.store.transaction(() => {
      repository.editTask(job.taskId ?? '', (task) => {
        return {
          ...task,
          phase: 'blocked',
          error,
          reviews: [],
          finalReview: null,
          verifiedMain: null,
        };
      });
      if (job.kind === 'triage') {
        cancelTriage(repository, job);
      }
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
    repository.finishJob(job, null, 'interrupted', {
      reason: 'Recovered after supervisor restart; the previous process outcome was not observed.',
    });
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
  if (job.kind === 'triage') {
    return isCurrentTriage(context.repository, job);
  }
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
    triage: '',
  } as const;
  return (
    task.phase === stages[job.kind] && (job.kind === 'develop' || (task.head === job.head && task.base === job.base))
  );
}

/**
 * A local gate or interrupted attempt must not consume an implementation retry.
 *
 * @param repository - Current project ledger.
 * @param job - Settled original assignment.
 * @param outcome - Fenced settlement and whether inference was skipped.
 */
export function refundUnpaidAttempt(
  repository: FactoryRepository,
  job: FactoryJob,
  outcome: { hasSettled: boolean; isUnpaidGate: boolean; state: string },
): void {
  if (
    outcome.hasSettled &&
    job.kind === 'develop' &&
    job.taskId !== null &&
    (outcome.isUnpaidGate || outcome.state === 'interrupted')
  ) {
    repository.editTask(job.taskId, (task) => ({ ...task, attempts: Math.max(0, task.attempts - 1) }));
  }
}

/**
 * Latest shared learning request used to avoid repeated idle research assignments.
 *
 * @param repository - Current project ledger.
 * @returns Most recent explicit guidance timestamp, or zero.
 */
export function latestLearningFeedback(repository: FactoryRepository): number {
  return Math.max(0, ...repository.instructions('learning-steward', null).map((instruction) => instruction.createdAt));
}
