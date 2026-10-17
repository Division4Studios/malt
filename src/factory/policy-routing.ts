/** @file Resolve allowed native combinations before a claim or inference reservation. */
import path from 'node:path';

import { writeAtomic } from '../summary.ts';

import { providerPreflight } from './authentication.ts';
import { MODEL_TIERS, modelSelectionSchema } from './model-policy.ts';

import type { ProviderReadiness } from './authentication.ts';
import type { FactoryContext } from './context.ts';
import type { ModelPolicy } from './model-policy.ts';
import type { FactoryConfig, FactoryJob, Provider } from './schema.ts';
/** Ordered supported native efforts; risk floors can raise a configured default. */
const EFFORTS = ['low', 'medium', 'high'] as const;
/** Frozen role routing. */
type Routing = NonNullable<FactoryJob['routing']>;
/** Supported policy effort level. */
type Effort = (typeof EFFORTS)[number];
/** Only connection boundaries and persisted readiness are needed by unpaid setup. */
type PolicyConnection = Pick<FactoryContext, 'mesh' | 'repository' | 'settings' | 'providerVersions'> & {
  readonly remote: Pick<FactoryContext['remote'], 'verify'>;
  readonly workspaces: Pick<FactoryContext['workspaces'], 'origin'>;
};
/** Explicitly distinguish policy rejection from an implementation exception. */
export class PolicyBlockedError extends Error {
  /** Stable category for expected policy ineligibility. */
  public override name = 'PolicyBlockedError';
}

/**
 * Apply explicit model policy after existing risk, rework and organization floors.
 *
 * @param input - Provider, floor, legacy selection and verified startup interface.
 * @returns Frozen model/effort/evidence, or unchanged legacy behavior.
 * @throws {PolicyBlockedError} When no allowed, supported combination meets the floor.
 */
export function resolvePolicy(input: {
  settings: FactoryConfig;
  provider: Provider;
  tier: Routing['tier'];
  model: string | null;
  effort: Effort;
  versions: FactoryContext['providerVersions'];
  modelChoice?: { policyRevision: number; entryId: string } | null | undefined;
}): Pick<Routing, 'model' | 'effort' | 'selection'> {
  const policy = input.settings.modelPolicy;
  if (policy === undefined) {
    if (input.modelChoice !== undefined && input.modelChoice !== null) {
      throw new PolicyBlockedError(
        'The independently reviewed choice requires an explicit model policy. Restore it or request a lead revision.',
      );
    }
    return { model: input.model, effort: input.effort };
  }
  const choices = policyChoices(policy, input);
  for (const choice of choices) {
    const entry = policy.entries.find((candidate) => candidate.id === choice.entryId);
    if (entry === undefined || entry.effortSupport === 'unknown' || entry.evidence === null) {
      continue;
    }
    const { versions } = input;
    const isFixture = versions === 'fixture';
    const version = isFixture ? 'fixture' : versions?.[input.provider];
    if (version === undefined || (!isFixture && version !== entry.evidence.version)) {
      continue;
    }
    const effort = selectedEffort(entry.efforts, choice.effort, input.effort);
    if (effort === undefined) {
      continue;
    }
    const selection = modelSelectionSchema.parse({
      policyRevision: policy.revision,
      observedVersion: version,
      entry,
      effort,
    });
    return { model: entry.model, effort, selection };
  }
  throw new PolicyBlockedError(
    `${input.provider}: no allowed ${input.tier} model/effort combination with matching verified CLI version. Refresh subscription setup/interface evidence or edit the paused policy defaults.`,
  );
}

/**
 * Honor a still-current independent choice, otherwise explain why admission is gated.
 *
 * @param policy - Current immutable project policy revision.
 * @param input - Reviewed stage recommendation and enforced floors.
 * @returns Exact recommended entry or nearest adequate project defaults.
 * @throws {PolicyBlockedError} For stale, missing, other-provider or inadequate recommendations.
 */
function policyChoices(
  policy: ModelPolicy,
  input: Parameters<typeof resolvePolicy>[0],
): { entryId: string; effort: Effort | null }[] {
  const recommended = input.modelChoice;
  if (recommended === undefined || recommended === null) {
    return policy.defaults
      .filter(
        (choice) =>
          choice.provider === input.provider && MODEL_TIERS.indexOf(choice.tier) >= MODEL_TIERS.indexOf(input.tier),
      )
      .toSorted((a, b) => MODEL_TIERS.indexOf(a.tier) - MODEL_TIERS.indexOf(b.tier));
  }
  if (recommended.policyRevision !== policy.revision) {
    throw new PolicyBlockedError(
      'The independently reviewed model choice belongs to an older policy revision. Request a lead revision; no silent replacement was launched.',
    );
  }
  const entry = policy.entries.find((candidate) => candidate.id === recommended.entryId);
  if (entry?.provider !== input.provider || MODEL_TIERS.indexOf(entry.capability) < MODEL_TIERS.indexOf(input.tier)) {
    throw new PolicyBlockedError(
      `${input.provider}: the reviewed model is missing, belongs to another provider or cannot satisfy the current capability floor. Request a lead revision.`,
    );
  }
  return [{ entryId: entry.id, effort: entry.effortSupport === 'none' ? null : input.effort }];
}

/**
 * Raise explicit defaults to the reviewed effort floor without inventing support.
 *
 * @param allowed - Exact native effort choices.
 * @param preferred - Operator default, null for recorded lack of control.
 * @param required - Reviewed/risk-derived floor.
 * @returns Allowed effort, null without control, undefined when inadequate.
 */
function selectedEffort(
  allowed: readonly Effort[],
  preferred: Effort | null,
  required: Effort,
): Effort | null | undefined {
  if (preferred === null) {
    return null;
  }
  const minimum = Math.max(EFFORTS.indexOf(preferred), EFFORTS.indexOf(required));
  return EFFORTS.find((effort, index) => index >= minimum && allowed.includes(effort));
}

/**
 * Verify enabled native subscriptions independently so an unusable provider
 * cannot suppress another eligible provider. Missing readiness stays ineligible.
 *
 * @param settings - Selected project's configured executables and policy.
 * @param cwd - Actual target repository.
 * @param probe - Unpaid native interface, injectable only by in-process tests.
 * @returns Only successful, secret-free readiness observations.
 */
export async function policyPreflight(
  settings: FactoryConfig,
  cwd: string,
  probe = providerPreflight,
): Promise<ProviderReadiness[]> {
  const ready: ProviderReadiness[] = [];
  for (const provider of ['codex', 'claude'] as const) {
    if (!settings.providers[provider].enabled) {
      continue;
    }
    const isolated = structuredClone(settings);
    for (const name of ['codex', 'claude'] as const) {
      isolated.providers[name].enabled = name === provider;
    }
    try {
      // eslint-disable-next-line no-await-in-loop -- Bound unpaid native diagnostics to one provider at a time.
      ready.push(...(await probe(isolated, cwd)));
    } catch {
      // Absence is an explicit policy ineligibility, never permission to fall back to API billing.
    }
  }
  return ready;
}

/**
 * Replace startup evidence completely; a failed provider cannot inherit old readiness.
 *
 * @param context - Current project context, fenced by its supervisor.
 * @param providers - Only successful supported subscription observations.
 */
export function recordProviderReadiness(
  context: Pick<FactoryContext, 'mesh' | 'repository' | 'providerVersions'>,
  providers: readonly ProviderReadiness[],
): void {
  const current = context;
  current.providerVersions ??= {};
  const versions = current.providerVersions;
  if (versions !== 'fixture') {
    delete versions.codex;
    delete versions.claude;
    delete versions.copilot;
    for (const provider of providers) {
      versions[provider.provider] = provider.version;
    }
  }
  writeAtomic(
    path.join(context.mesh.directory, 'factory', 'readiness.json'),
    `${JSON.stringify({ providers, checkedAt: context.repository.store.now() }, null, 2)}\n`,
  );
}

/**
 * Complete unpaid connection checks only for the still-current supervisor context.
 *
 * @param context - Verified target and configured native executables.
 * @param isCurrent - Rechecks pause/shutdown and configuration after each await.
 * @param probe - Bounded explicit-policy readiness; injectable by in-process tests.
 * @returns Whether this exact context may proceed to reconciliation/dispatch.
 */
export async function isPolicyContextVerified(
  context: PolicyConnection,
  isCurrent: () => boolean,
  probe = policyPreflight,
): Promise<boolean> {
  await context.remote.verify(await context.workspaces.origin());
  if (!isCurrent()) {
    return false;
  }
  if (context.providerVersions !== 'fixture') {
    const providers =
      context.settings.modelPolicy === undefined
        ? await providerPreflight(context.settings, context.mesh.root)
        : await probe(context.settings, context.mesh.root);
    if (!isCurrent()) {
      return false;
    }
    recordProviderReadiness(context, providers);
  }
  return true;
}
