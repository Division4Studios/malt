/** @file Atomic model policy persistence and project-scoped update validation. */
import { run } from '../database.ts';
import { MeshError } from '../protocol.ts';

import { modelPolicyUpdateSchema } from './model-policy.ts';

import type { ModelPolicy } from './model-policy.ts';
import type { FactoryRepository } from './repository.ts';
import type { FactoryConfig } from './schema.ts';
/** Durable sessions remain live until their owning runtime settles or recovers them. */
const ACTIVE_TERMINALS: ReadonlySet<string> = new Set(['requested', 'starting', 'running', 'closing']);

/**
 * Preserve unrelated settings while checking the caller's observed revision.
 *
 * @param settings - Current authoritative project settings.
 * @param input - Untrusted policy-only update.
 * @returns Complete configuration for the existing paused control boundary.
 * @throws {MeshError} When the observed revision is stale.
 */
export function updatedModelPolicy(settings: FactoryConfig, input: unknown): FactoryConfig {
  const update = modelPolicyUpdateSchema.parse(input);
  if ((settings.modelPolicy?.revision ?? null) !== update.expectedRevision) {
    throw new MeshError('FACTORY_GATED', 'Stale model policy revision; refresh before editing.');
  }
  return { ...settings, modelPolicy: update.policy };
}

/**
 * Archive a changed revision inside the configuration owner's transaction.
 * No legacy setup route can remove or overwrite a newer explicit policy.
 *
 * @param repository - Owns the transaction and project-local database.
 * @param next - Validated incoming policy or legacy implicit mode.
 * @throws {MeshError} For active work or a nonconsecutive policy revision.
 */
export function persistModelPolicy(repository: FactoryRepository, next: ModelPolicy | undefined): void {
  const previous = repository.config()?.modelPolicy;
  if (JSON.stringify(previous) === JSON.stringify(next)) {
    return;
  }
  if (repository.active() || repository.jobs().some((job) => job.state === 'running')) {
    throw new MeshError('FACTORY_GATED', 'Pause and settle managed work before changing model policy.');
  }
  if (next?.revision !== (previous?.revision ?? 0) + 1) {
    throw new MeshError(
      'FACTORY_GATED',
      'Stale model policy: submit the next consecutive revision; implicit removal is forbidden.',
    );
  }
  run(
    repository.store.db,
    'INSERT INTO metadata(key,value) VALUES(?,?)',
    `factory_model_policy_v1:${String(next.revision)}`,
    JSON.stringify(next),
  );
}

/**
 * Commit current settings and their immutable policy archive together.
 *
 * @param repository - Owns project-local state and notification identity.
 * @param settings - Validated complete factory settings.
 */
export function saveFactorySettings(repository: FactoryRepository, settings: FactoryConfig): void {
  repository.store.transaction(() => {
    if (repository.terminals.list().some((session) => ACTIVE_TERMINALS.has(session.state))) {
      throw new MeshError(
        'FACTORY_GATED',
        'Pause and settle durable terminal sessions before changing project policies.',
      );
    }
    persistModelPolicy(repository, settings.modelPolicy);
    run(
      repository.store.db,
      'INSERT INTO factory_settings(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
      JSON.stringify(settings),
    );
  });
  repository.prepareSender();
}
