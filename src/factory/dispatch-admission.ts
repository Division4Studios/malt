/**
 * Recompute shared capacity synchronously at the actual claim boundary.
 *
 * @file
 */
import { stepProfile } from './job-records.ts';
import { recordPolicyBlocker } from './policy-blockers.ts';
import { PolicyBlockedError } from './policy-routing.ts';
import { resourceBlocker } from './resources.ts';
import { routeAssignment } from './routing.ts';
import { chooseProvider } from './scheduler.ts';
import { PROVIDERS } from './schema.ts';

import type { AdmissionPool } from './admission.ts';
import type { FactoryContext } from './context.ts';
import type { ResourceSnapshot } from './resources.ts';
import type { JobIntent } from './scheduler.ts';
import type { Provider, FactoryJob } from './schema.ts';

/**
 * Select against current broker reservations, never a pre-await snapshot.
 *
 * @param context - Selected project's durable policy/accounting.
 * @param sample - Latest local resource measurement.
 * @param pool - Shared broker-wide owned pipelines.
 * @param intent - Exact role/scope before any claim or token reservation; its preferred provider waits rather than switching.
 * @returns Provider and frozen routing, or null while capacity/policy is unavailable.
 * @throws {Error} For unexpected routing failures; policy ineligibility is handled separately.
 */
export function admittedAssignment(
  context: FactoryContext,
  sample: ResourceSnapshot,
  pool: AdmissionPool,
  intent: JobIntent,
): { provider: Provider; routing: NonNullable<FactoryJob['routing']> } | null {
  const config = pool.policy(context.settings);
  if (resourceBlocker(config, sample, pool.size) !== null || !isCurrentScope(context, intent)) {
    return null;
  }
  const routings = eligibleRoutings(context, intent);
  for (const name of PROVIDERS) {
    config.providers[name].enabled &&= routings.has(name);
  }
  const now = context.repository.store.now();
  const provider = chooseProvider(
    {
      config,
      capacities: pool.capacities(
        PROVIDERS.map((name) => context.repository.capacity(name, context.settings)),
        now,
      ),
      jobs: pool.jobs(),
      now,
    },
    intent.preferredProvider ?? roleProvider(context, intent),
  );
  const routing = provider === null ? undefined : routings.get(provider);
  return provider === null || routing === undefined ? null : { provider, routing };
}

/**
 * The provider a role type waits for: its explicit preference, else the
 * provider of its preferred model. A workflow step's own preference wins.
 *
 * @param context - Project organization and model policy.
 * @param intent - Offered assignment.
 * @returns Preferred provider, or `null` for any.
 */
function roleProvider(context: FactoryContext, intent: JobIntent): Provider | null {
  const { organization, modelPolicy } = context.settings;
  const task = intent.taskId === null ? null : context.repository.task(intent.taskId);
  const profile = stepProfile(context, intent, task);
  const seat = organization.types[organization.members[intent.role]?.type ?? ''];
  const type = (profile === null ? undefined : organization.types[profile]) ?? seat;
  if (type === undefined) {
    return null;
  }
  const entry = modelPolicy?.entries.find((candidate) => candidate.id === type.model?.entryId);
  return type.provider ?? entry?.provider ?? null;
}

/**
 * Fence stale policy and scopes before inspecting model eligibility.
 *
 * @param context - Current project authority.
 * @param intent - Exact offered assignment.
 * @returns Whether this scope still permits policy resolution.
 */
function isCurrentScope(context: FactoryContext, intent: JobIntent): boolean {
  const current = context.repository.config();
  if (JSON.stringify(current?.modelPolicy) !== JSON.stringify(context.settings.modelPolicy)) {
    return false;
  }
  const task = intent.taskId === null ? null : context.repository.task(intent.taskId);
  const feature = context.repository.features().find((item) => item.id === intent.featureId);
  if (task === null && (feature?.phase === 'blocked' || feature?.scopeReplacement !== undefined)) {
    return false;
  }
  if (task?.scopeReplacement !== undefined || (task?.phase === 'blocked' && intent.kind !== 'triage')) {
    return false;
  }
  return true;
}

/**
 * Resolve eligible providers independently before utilization balancing.
 *
 * @param context - Authoritative project policy and readiness.
 * @param intent - Offered role and scope.
 * @returns Frozen routings; an empty result records a durable explicit-policy gate.
 * @throws {Error} For unexpected implementation failures.
 */
function eligibleRoutings(
  context: FactoryContext,
  intent: JobIntent,
): Map<Provider, NonNullable<FactoryJob['routing']>> {
  const task = intent.taskId === null ? null : context.repository.task(intent.taskId);
  const routings = new Map<Provider, NonNullable<FactoryJob['routing']>>();
  const reasons: string[] = [];
  for (const provider of PROVIDERS) {
    if (!context.settings.providers[provider].enabled) {
      continue;
    }
    try {
      routings.set(
        provider,
        routeAssignment({
          intent,
          provider,
          settings: context.settings,
          task,
          profile: stepProfile(context, intent, task),
          versions: context.providerVersions,
        }),
      );
    } catch (error) {
      if (!(error instanceof PolicyBlockedError)) {
        throw error;
      }
      reasons.push(error.message);
    }
  }
  if (routings.size === 0 && context.settings.modelPolicy !== undefined) {
    recordPolicyBlocker(
      context,
      `Model policy revision ${String(context.settings.modelPolicy.revision)} blocks ${intent.role}. ${reasons.length === 0 ? 'Enable a supported subscription provider.' : reasons.join(' ')}`,
      intent,
    );
  }
  return routings;
}
