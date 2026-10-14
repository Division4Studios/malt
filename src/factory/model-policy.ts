/**
 * Revision-checked project model/effort policy, stored apart from other factory
 * settings so neither control overwrites the other. Projects without a saved
 * policy keep the legacy implicit CLI routing unchanged.
 *
 * @file
 */

import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { run, selectOne } from '../database.ts';
import { MeshError } from '../protocol.ts';

import { factorySchemas, modelPolicySchema } from './schema.ts';

import type { FactoryRepository } from './repository.ts';
import type { ModelPolicy } from './schema.ts';
import type { Store } from '../store.ts';

/** Persisted single-row policy; a null document means legacy implicit routing. */
const rowSchema = z.object({ revision: z.string(), data: z.string().nullable(), updated_at: z.number().nullable() });

/** Operator view of the current policy, its admission effect and effort-support evidence. */
export const modelPolicyViewSchema = z.object({
  mode: z.enum(['legacy', 'explicit']),
  revision: z.string().uuid(),
  policy: modelPolicySchema.nullable(),
  updatedAt: z.number().nullable(),
  legacyRouting: z.string().nullable(),
  effortSupport: z.record(z.literal('unknown')),
  admission: z.object({ state: z.enum(['legacy', 'parked']), reason: z.string() }),
});
/** Current project policy view. */
export type ModelPolicyView = z.output<typeof modelPolicyViewSchema>;

/** Current project policy and its optimistic-concurrency revision. */
export interface ModelPolicyState {
  /** Legacy implicit CLI routing, or an operator-saved explicit policy. */
  readonly mode: 'legacy' | 'explicit';
  /** Project-unique revision; every successful update replaces it. */
  readonly revision: string;
  /** Explicit policy, absent in legacy mode. */
  readonly policy: ModelPolicy | null;
  /** Last explicit update, absent before any update. */
  readonly updatedAt: number | null;
}

/** Legacy behavior, stated explicitly instead of inferred from model names. */
const LEGACY_ROUTING =
  'Legacy implicit routing: capability tiers map to provider model settings, or the authenticated CLI default; effort is the CLI default and its support is unknown.';

/**
 * Create the policy row for new and existing projects without altering other settings or history.
 * The initial random revision keeps stale writes from one project from matching another.
 *
 * @param store - Project store.
 */
export function prepareModelPolicy(store: Store): void {
  store.db.exec(
    'CREATE TABLE IF NOT EXISTS factory_model_policy (id INTEGER PRIMARY KEY CHECK(id = 1), revision TEXT NOT NULL, data TEXT, updated_at INTEGER)',
  );
  run(store.db, 'INSERT OR IGNORE INTO factory_model_policy(id,revision,data) VALUES(1,?,NULL)', randomUUID());
}

/**
 * Read the current project policy.
 *
 * @param store - Project store.
 * @returns Legacy or explicit policy with its revision.
 * @throws {MeshError} When the policy row was never prepared.
 */
export function modelPolicyState(store: Store): ModelPolicyState {
  const row = selectOne(
    store.db,
    rowSchema,
    'SELECT revision, data, updated_at FROM factory_model_policy WHERE id = 1',
  );
  if (row === undefined) {
    throw new MeshError('INTERNAL', 'Project model policy storage is not prepared.');
  }
  const policy = row.data === null ? null : modelPolicySchema.parse(JSON.parse(row.data));
  return { mode: policy === null ? 'legacy' : 'explicit', revision: row.revision, policy, updatedAt: row.updated_at };
}

/**
 * Atomically replace the policy when the caller observed the current revision.
 *
 * @param store - Project store.
 * @param expectedRevision - Revision the operator edited.
 * @param policy - Validated explicit policy, or null to return to legacy routing.
 * @returns Newly committed state.
 * @throws {MeshError} STALE_REVISION when another update, or another project's revision, was supplied.
 */
export function saveModelPolicy(store: Store, expectedRevision: string, policy: ModelPolicy | null): ModelPolicyState {
  return store.transaction(() => {
    const current = modelPolicyState(store);
    if (current.revision !== expectedRevision) {
      throw new MeshError(
        'STALE_REVISION',
        'Model policy changed since it was read, or belongs to another project; reload and reapply your edits.',
      );
    }
    const revision = randomUUID();
    const now = store.now();
    run(
      store.db,
      'UPDATE factory_model_policy SET revision=?, data=?, updated_at=? WHERE id=1',
      revision,
      policy === null ? null : JSON.stringify(policy),
      now,
    );
    store.event('FACTORY_MODEL_POLICY', null, {
      previousRevision: current.revision,
      revision,
      mode: policy === null ? 'legacy' : 'explicit',
    });
    return { mode: policy === null ? 'legacy' : 'explicit', revision, policy, updatedAt: now };
  });
}

/**
 * Apply an operator policy update only to a configured, paused project whose managed work has settled.
 *
 * @param repository - Selected project's ledger.
 * @param input - Untrusted control input.
 * @param isSettling - Whether this supervisor still owns settling pipelines.
 * @throws {MeshError} FACTORY_GATED for unconfigured, active or unsettled projects; STALE_REVISION for stale input.
 */
export function updateModelPolicy(repository: FactoryRepository, input: unknown, isSettling: boolean): void {
  if (repository.config() === null) {
    throw new MeshError('FACTORY_GATED', 'Configure this target project and its validation commands first.');
  }
  const isClaimed = repository.jobs().some((job) => job.state === 'running');
  if (isSettling || isClaimed || repository.active()) {
    throw new MeshError('FACTORY_GATED', 'Pause the factory and let managed work settle before changing model policy.');
  }
  const value = factorySchemas.factory_model_policy.parse(input);
  saveModelPolicy(repository.store, value.expectedRevision, value.policy);
}

/**
 * Keep explicit policy out of the legacy launch route until policy-enforced launch exists.
 *
 * @param state - Current project policy.
 * @returns Actionable no-launch reason, or null when legacy admission applies.
 */
export function modelPolicyBlocker(state: ModelPolicyState): string | null {
  return state.mode === 'legacy'
    ? null
    : `Explicit model policy revision ${state.revision} is saved, but this MALT version cannot yet enforce it at launch. Admission is parked without inference; pause and restore legacy routing (policy null), or upgrade to a version with policy-enforced launch.`;
}

/**
 * Secret-free operator view. No installed-interface evidence is recorded yet, so effort support is never verified.
 *
 * @param state - Current project policy.
 * @returns Policy, admission state and explicit effort-support labels.
 */
export function modelPolicyView(state: ModelPolicyState): ModelPolicyView {
  const blocker = modelPolicyBlocker(state);
  return {
    ...state,
    legacyRouting: state.mode === 'legacy' ? LEGACY_ROUTING : null,
    effortSupport: Object.fromEntries((state.policy?.models ?? []).map((entry) => [entry.id, 'unknown' as const])),
    admission:
      blocker === null
        ? { state: 'legacy' as const, reason: LEGACY_ROUTING }
        : { state: 'parked' as const, reason: blocker },
  };
}
