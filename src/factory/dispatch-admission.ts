/**
 * Recompute shared capacity synchronously at the actual claim boundary.
 *
 * @file
 */
import { resourceBlocker } from './resources.ts';
import { chooseProvider } from './scheduler.ts';
import { PROVIDERS } from './schema.ts';

import type { AdmissionPool } from './admission.ts';
import type { FactoryContext } from './context.ts';
import type { ResourceSnapshot } from './resources.ts';
import type { Provider } from './schema.ts';

/**
 * Select against current broker reservations, never a pre-await snapshot.
 *
 * @param context - Selected project's durable policy/accounting.
 * @param sample - Latest local resource measurement.
 * @param pool - Shared broker-wide owned pipelines.
 * @param preferred - Provider family the step prefers, if any.
 * @returns Currently admissible provider, or null while capacity is unavailable.
 */
export function admittedProvider(
  context: FactoryContext,
  sample: ResourceSnapshot,
  pool: AdmissionPool,
  preferred: Provider | null = null,
): Provider | null {
  const config = pool.policy(context.settings);
  if (resourceBlocker(config, sample, pool.size) !== null) {
    return null;
  }
  const now = context.repository.store.now();
  return chooseProvider(
    {
      config,
      capacities: pool.capacities(
        PROVIDERS.map((name) => context.repository.capacity(name, context.settings)),
        now,
      ),
      jobs: pool.jobs(),
      now,
    },
    preferred,
  );
}
