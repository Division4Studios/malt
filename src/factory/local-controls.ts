/**
 * Delivery boundary selection for GitHub-free delivery. A project that sets
 * `"delivery": "local"` uses the protected local hub and ledger; every other
 * project keeps the GitHub adapter. Setup creates and protects the hub before
 * the policy is saved.
 *
 * @file
 */

import { LocalDelivery } from './local-delivery.ts';
import { GitHubDelivery } from './remote.ts';
import { factoryConfigSchema } from './schema.ts';

import type { MeshConfig } from '../config.ts';
import type { ProjectGitHub } from '../github.ts';
import type { DeliveryRemote } from './remote.ts';
import type { FactoryConfig } from './schema.ts';

/**
 * Select the configured delivery boundary for a project.
 *
 * @param mesh - Target project.
 * @param settings - Factory policy.
 * @param github - Existing project GitHub integration, used only in GitHub mode.
 * @returns The local hub adapter or the GitHub adapter.
 */
export function deliveryFor(mesh: MeshConfig, settings: FactoryConfig, github: ProjectGitHub): DeliveryRemote {
  return settings.delivery === 'local' ? new LocalDelivery(mesh, settings) : new GitHubDelivery(mesh, github);
}

/**
 * Create and protect the local hub before policy is saved.
 *
 * @param mesh - Target project.
 * @param input - Policy being applied.
 * @param isInjected - Tests supplied their own delivery boundary.
 */
export async function prepareDelivery(mesh: MeshConfig, input: unknown, isInjected: boolean): Promise<void> {
  const settings = factoryConfigSchema.parse(input);
  if (isInjected || settings.delivery !== 'local') {
    return;
  }
  const delivery = new LocalDelivery(mesh, settings);
  await delivery.hub.initialize(mesh.root, settings.remote);
}
