/** @file Durable, deduplicated model-policy blockers without paid retry loops. */
import { z } from 'zod/v3';

import { run, selectOne } from '../database.ts';

import { worktreeOwnerBlocker } from './worktree-owner.ts';

import type { FactoryContext } from './context.ts';
import type { FactoryRepository } from './repository.ts';
import type { JobIntent } from './scheduler.ts';
/** One current project gate; full outcome history remains in durable events/tasks. */
const KEY = 'factory_model_policy_gate_v1';
/** Legacy projects have no policy gate; corrupt metadata cannot authorize dispatch. */
const gateSchema = z.object({
  revision: z.number(),
  reason: z.string(),
  taskId: z.string().nullable(),
  featureId: z.string().nullable(),
  taskVersion: z.number().int().nullable(),
  featureUpdatedAt: z.number().nullable(),
});

/**
 * Record only a changed gate and preserve every source edit and prior attempt.
 *
 * @param context - Selected project authority.
 * @param reason - Actionable secret-free policy explanation.
 * @param intent - Blocked assignment, absent for global unknown support.
 */
export function recordPolicyBlocker(context: FactoryContext, reason: string, intent?: JobIntent): void {
  const { repository } = context;
  const task = intent?.taskId === undefined || intent.taskId === null ? null : repository.task(intent.taskId);
  const feature = repository.features().find((item) => item.id === intent?.featureId);
  const gate = {
    revision: context.settings.modelPolicy?.revision,
    reason,
    taskId: intent?.taskId ?? null,
    featureId: intent?.featureId ?? null,
    taskVersion: task?.version ?? null,
    featureUpdatedAt: task === null ? (feature?.updatedAt ?? null) : null,
  };
  const value = JSON.stringify(gate);
  repository.store.transaction(() => {
    const previous = selectOne(
      repository.store.db,
      z.object({ value: z.string() }),
      'SELECT value FROM metadata WHERE key=?',
      KEY,
    );
    if (previous?.value === value) {
      return;
    }
    run(
      repository.store.db,
      'INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      KEY,
      value,
    );
    // Policy eligibility is separate from delivery state: retain exact review/triage evidence.
    repository.store.event('FACTORY_MODEL_POLICY_BLOCKED', null, gate);
    repository.notify(reason);
  });
}

/**
 * Recover the current gate across restart, without reviving resolved scopes.
 *
 * @param repository - Project-local authoritative state.
 * @returns Current actionable reason, or null after a policy/scope change.
 */
export function policyBlocker(repository: FactoryRepository): string | null {
  const row = selectOne(
    repository.store.db,
    z.object({ value: z.string() }),
    'SELECT value FROM metadata WHERE key=?',
    KEY,
  );
  if (row === undefined) {
    return null;
  }
  const gate = gateSchema.safeParse(JSON.parse(row.value));
  if (!gate.success || gate.data.revision !== repository.config()?.modelPolicy?.revision) {
    return null;
  }
  const { reason, taskId, featureId, taskVersion, featureUpdatedAt } = gate.data;
  if (taskId !== null) {
    return repository.tasks().some((task) => {
      return (
        task.id === taskId &&
        task.version === taskVersion &&
        task.phase !== 'done' &&
        task.scopeReplacement === undefined
      );
    })
      ? reason
      : null;
  }
  if (featureId !== null) {
    return repository.features().some((feature) => {
      return (
        feature.id === featureId &&
        feature.updatedAt === featureUpdatedAt &&
        feature.phase !== 'done' &&
        feature.scopeReplacement === undefined
      );
    })
      ? reason
      : null;
  }
  return reason;
}

/**
 * Park entirely unknown policy, or worktrees owned by another environment, before GitHub,
 * quota helpers or provider startup.
 *
 * @param context - Current authoritative configuration.
 * @returns Actionable unsupported policy gate, otherwise null.
 */
export function policySetupBlocker(context: FactoryContext): string | null {
  const owner = worktreeOwnerBlocker(context.mesh, context.repository.store.now());
  if (owner !== null) {
    return owner;
  }
  const policy = context.settings.modelPolicy;
  if (policy === undefined || policy.entries.some((entry) => entry.effortSupport !== 'unknown')) {
    return null;
  }
  const reason =
    'Explicit model policy has no supported native selection. No inference launched; record model-specific interface evidence and configure a supported default while paused.';
  recordPolicyBlocker(context, reason);
  return reason;
}
