/**
 * Paused-only project policy controls. The revision-checked model/effort policy is
 * stored apart from other factory settings so neither control overwrites the other.
 * Projects without a saved policy keep the legacy implicit CLI routing unchanged.
 *
 * @file
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { run, selectOne } from '../database.ts';
import { MeshError } from '../protocol.ts';
import { writeAtomic } from '../summary.ts';

import { factoryConfigSchema, factorySchemas, modelPolicySchema } from './schema.ts';
import { installFactorySkills } from './skills.ts';

import type { MeshConfig } from '../config.ts';
import type { FactoryRepository } from './repository.ts';
import type { FactoryOperation } from './schema.ts';
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
/** Current project policy and its project-unique optimistic-concurrency revision. */
type ModelPolicyState = Pick<ModelPolicyView, 'mode' | 'revision' | 'policy' | 'updatedAt'>;
/** Paused-only controls replacing project settings or model policy. */
export type PolicyControl = Extract<FactoryOperation, 'factory_setup' | 'factory_model_policy'>;

/** Legacy behavior, stated explicitly instead of inferred from model names. */
const LEGACY_ROUTING =
  'Legacy implicit routing: capability tiers map to provider model settings, or the authenticated CLI default; effort is the CLI default and its support is unknown.';

/**
 * Read the current policy, creating legacy storage for new and pre-policy projects
 * without altering other settings or history. The initial random revision keeps
 * stale writes from one project from matching another.
 *
 * @param store - Project store.
 * @returns Legacy or explicit policy with its revision.
 */
function modelPolicyState(store: Store): ModelPolicyState {
  store.db.exec(
    'CREATE TABLE IF NOT EXISTS factory_model_policy (id INTEGER PRIMARY KEY CHECK(id = 1), revision TEXT NOT NULL, data TEXT, updated_at INTEGER)',
  );
  run(store.db, 'INSERT OR IGNORE INTO factory_model_policy(id,revision,data) VALUES(1,?,NULL)', randomUUID());
  const sql = 'SELECT revision, data, updated_at FROM factory_model_policy WHERE id = 1';
  const row = rowSchema.parse(selectOne(store.db, rowSchema, sql));
  const policy = row.data === null ? null : modelPolicySchema.parse(JSON.parse(row.data));
  return { mode: policy === null ? 'legacy' : 'explicit', revision: row.revision, policy, updatedAt: row.updated_at };
}

/**
 * Atomically replace the policy of a configured project with no unsettled claims
 * when the caller observed the current revision.
 *
 * @param repository - Selected project's ledger.
 * @param input - Untrusted control input.
 * @throws {MeshError} FACTORY_GATED for unconfigured or unsettled projects; STALE_REVISION for a stale or foreign revision.
 */
function updateModelPolicy(repository: FactoryRepository, input: unknown): void {
  if (repository.config() === null) {
    throw new MeshError('FACTORY_GATED', 'Configure this target project and its validation commands first.');
  }
  if (repository.jobs().some((job) => job.state === 'running')) {
    throw new MeshError('FACTORY_GATED', 'Let managed work settle before changing model policy.');
  }
  const { expectedRevision, policy } = factorySchemas.factory_model_policy.parse(input);
  const { store } = repository;
  store.transaction(() => {
    const current = modelPolicyState(store);
    if (current.revision !== expectedRevision) {
      throw new MeshError(
        'STALE_REVISION',
        'Model policy changed since it was read, or belongs to another project; reload and reapply your edits.',
      );
    }
    const revision = randomUUID();
    const data = policy === null ? null : JSON.stringify(policy);
    run(
      store.db,
      'UPDATE factory_model_policy SET revision=?, data=?, updated_at=? WHERE id=1',
      revision,
      data,
      store.now(),
    );
    const mode = policy === null ? 'legacy' : 'explicit';
    store.event('FACTORY_MODEL_POLICY', null, { previousRevision: current.revision, revision, mode });
  });
}

/**
 * Recognize paused-only policy controls.
 *
 * @param operation - Validated factory operation.
 * @returns Whether it replaces settings or model policy.
 */
export function isPolicyControl(operation: FactoryOperation): operation is PolicyControl {
  return operation === 'factory_setup' || operation === 'factory_model_policy';
}

/**
 * Replace factory settings or model policy after the caller verified paused work;
 * each control preserves the other's state.
 *
 * @param project - Selected project configuration and ledger.
 * @param project.mesh - Project configuration.
 * @param project.repository - Project ledger.
 * @param operation - Settings or model policy replacement.
 * @param input - Validated control input.
 */
export function applyPolicyControl(
  project: { mesh: MeshConfig; repository: FactoryRepository },
  operation: PolicyControl,
  input: unknown,
): void {
  if (operation === 'factory_model_policy') {
    updateModelPolicy(project.repository, input);
    return;
  }
  const settings = factoryConfigSchema.parse(input);
  project.repository.configure(settings);
  installFactorySkills(project.mesh);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Factory policy and execution artifacts are stored in this project's managed directory.
  mkdirSync(path.join(project.mesh.directory, 'factory'), { recursive: true, mode: 0o700 });
  writeAtomic(path.join(project.mesh.directory, 'factory', 'config.json'), `${JSON.stringify(settings, null, 2)}\n`);
}

/**
 * Keep explicit policy out of the legacy launch route until policy-enforced launch exists.
 *
 * @param state - Current project policy.
 * @returns Actionable no-launch reason, or null when legacy admission applies.
 */
function modelPolicyBlocker(state: ModelPolicyState): string | null {
  return state.mode === 'legacy'
    ? null
    : `Explicit model policy revision ${state.revision} is saved, but this MALT version cannot yet enforce it at launch. Admission is parked without inference; pause and restore legacy routing (policy null), or upgrade to a version with policy-enforced launch.`;
}

/**
 * Park admission before any claim, reservation or inference while explicit policy is saved.
 *
 * @param store - Project store.
 * @throws {MeshError} FACTORY_GATED with the actionable unsupported-policy reason.
 */
export function assertLegacyAdmission(store: Store): void {
  const blocker = modelPolicyBlocker(modelPolicyState(store));
  if (blocker !== null) {
    throw new MeshError('FACTORY_GATED', blocker);
  }
}

/**
 * Secret-free operator view. No installed-interface evidence is recorded yet, so effort support is never verified.
 *
 * @param store - Project store.
 * @returns Policy, admission state and explicit effort-support labels.
 */
export function modelPolicyView(store: Store): ModelPolicyView {
  const state = modelPolicyState(store);
  const blocker = modelPolicyBlocker(state);
  return {
    ...state,
    legacyRouting: state.mode === 'legacy' ? LEGACY_ROUTING : null,
    effortSupport: Object.fromEntries((state.policy?.models ?? []).map((entry) => [entry.id, 'unknown' as const])),
    admission: blocker === null ? { state: 'legacy', reason: LEGACY_ROUTING } : { state: 'parked', reason: blocker },
  };
}
