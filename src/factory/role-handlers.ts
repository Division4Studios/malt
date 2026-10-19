/**
 * Supervisor handlers for the roles editor and the local secrets store, and
 * the live-attempt lookup behind the broker's role tool policy check.
 *
 * @file
 */
import { isToolDenied } from '../managed-tools.ts';

import { updatedOrganization } from './role-controls.ts';
import { roleSchemas } from './role-schema.ts';
import { deleteSecret, saveSecret } from './vault.ts';

import type { ProjectLearning } from '../learning.ts';
import type { FactoryContext } from './context.ts';
import type { FactoryRepository } from './repository.ts';
import type { ROLE_OPERATIONS } from './role-schema.ts';

/** What the role and secret handlers need from the supervisor. */
interface RoleHandlerContext {
  /** Current verified project context. */
  readonly configured: () => FactoryContext;
  /** Project ledger. */
  readonly repository: FactoryRepository;
  /** Project `.malt` directory, which holds the vault key. */
  readonly directory: string;
  /** Project skill library. */
  readonly learning: Pick<ProjectLearning, 'skillLibrary'>;
  /** The paused setup boundary that applies complete settings. */
  readonly setup: (settings: unknown) => unknown;
  /** Untrusted wire input. */
  readonly input: unknown;
}

/**
 * Handlers for the human-only role and secret operations.
 *
 * @param context - Supervisor services and the request input.
 * @returns One handler per operation.
 */
export function roleHandlers(context: RoleHandlerContext): Record<(typeof ROLE_OPERATIONS)[number], () => unknown> {
  const vault = { store: context.repository.store, directory: context.directory };
  return {
    factory_roles_save: () => {
      const input = roleSchemas.factory_roles_save.parse(context.input);
      return context.setup(updatedOrganization(context.configured().settings, input, context.learning));
    },
    factory_secret_save: () => {
      const types = Object.keys(context.configured().settings.organization.types);
      return saveSecret(vault, roleSchemas.factory_secret_save.parse(context.input), types);
    },
    factory_secret_delete: () => deleteSecret(vault, roleSchemas.factory_secret_delete.parse(context.input)),
  };
}

/**
 * Whether a managed seat's live attempt has a role policy that removed this tool.
 *
 * @param repository - Project ledger.
 * @param actor - Authenticated managed identity (`factory-<seat>`).
 * @param operation - Requested operation.
 * @returns True when the call must be refused.
 */
export function isManagedToolDenied(repository: FactoryRepository, actor: string, operation: string): boolean {
  const job = repository
    .jobs()
    .find((candidate) => candidate.state === 'running' && `factory-${candidate.role}` === actor);
  return job !== undefined && isToolDenied(actor, job.routing?.organization?.tools, operation);
}
