/**
 * Deterministic pre-launch routing; configured models remain account-specific.
 *
 * @file
 */
import { organizationRevision } from './organization.ts';
import { resolvePolicy } from './policy-routing.ts';

import type { FactoryContext } from './context.ts';
import type { JobIntent } from './scheduler.ts';
import type { FactoryConfig, FactoryJob, FactoryTask, Provider } from './schema.ts';

/** Maximum prose length eligible for a small implementation assignment. */
const SMALL_SCOPE_LENGTH = 600;
/** Security-sensitive scopes never receive the small-task route. */
const HIGH_RISK =
  /\b(?:3d|anatomy|animation|authentication|authorization|biomechanics|concurrency|credentials|encryption|lifelike|merge protection|migration|payment|photorealistic|rigging|sandbox|security)\b/iv;
/** Legacy scopes qualify as small only when their actual work is recognizably simple. */
const SIMPLE_SCOPE = /\b(?:copy|label|rename|spelling|typo)\b/iv;
/** Common bounded guidance shared by all roles. */
const SHARED_SKILL = 'factory-session';
/** Relevant baseline only, rather than the complete upstream library. */
const STAGE_SKILLS = {
  plan: 'factory-product',
  refine: 'factory-product',
  develop: 'factory-development',
  review: 'factory-review',
  final: 'factory-release',
  verify: 'factory-release',
  learn: 'factory-learning',
  skill: 'factory-learning',
  triage: 'factory-product',
} as const;

/**
 * Choose a capability tier before reserving or starting a model process.
 *
 * @param intent - Delivery-stage requirement.
 * @param task - Actual scope and rework history.
 * @returns Capability floor and its inspectable rationale.
 */
function taskTier(
  intent: JobIntent,
  task: FactoryTask | null,
): { tier: 'small' | 'standard' | 'advanced'; reason: string } {
  if (
    task !== null &&
    (task.feedback.length > 0 || task.attempts > 1 || HIGH_RISK.test(`${task.title} ${task.description}`))
  ) {
    return { tier: 'advanced', reason: 'Recorded rework or a high-risk scope requires deeper reasoning.' };
  }
  if (['refine', 'final', 'skill'].includes(intent.kind)) {
    return {
      tier: 'advanced',
      reason: 'Architecture, integration and independent adoption decisions require advanced review.',
    };
  }
  const assignment = task?.assignmentProfiles?.find((profile) => profile.role === intent.role);
  if (assignment !== undefined) {
    return { tier: assignment.tier, reason: `Lead-reviewed role assignment: ${assignment.reason}` };
  }
  if (task?.capabilityTier === 'advanced') {
    return { tier: 'advanced', reason: 'The independently reviewed delivery plan requires advanced capability.' };
  }
  if (canUseSmallModel(intent, task)) {
    return {
      tier: 'small',
      reason: 'One short independently verifiable scope with no dependencies or recorded rework.',
    };
  }
  return {
    tier: 'standard',
    reason: 'Normal implementation, product refinement, independent QA or evidence gathering.',
  };
}

/**
 * Recognize an explicitly simple, independently verifiable implementation scope.
 *
 * @param intent - Assigned lifecycle stage.
 * @param task - Reviewed delivery metadata.
 * @returns Whether the small profile is eligible below enforced risk floors.
 */
function canUseSmallModel(intent: JobIntent, task: FactoryTask | null): boolean {
  return (
    task !== null &&
    intent.kind === 'develop' &&
    task.dependencies.length === 0 &&
    (task.acceptanceCriteria.length === 1 || task.capabilityTier === 'small') &&
    task.description.length <= SMALL_SCOPE_LENGTH &&
    (task.capabilityTier === 'small' ||
      (task.capabilityTier === null && SIMPLE_SCOPE.test(`${task.title} ${task.description}`)))
  );
}

/**
 * Resolve configured native model names and selected skills without inference.
 *
 * @param context - Scoped intent, provider, configuration and durable task.
 * @returns Durable decision passed unchanged to both provider adapters.
 */
export function routeAssignment(context: {
  intent: JobIntent;
  provider: Provider;
  settings: FactoryConfig;
  task: FactoryTask | null;
  versions?: FactoryContext['providerVersions'];
}): NonNullable<FactoryJob['routing']> {
  const decision = taskTier(context.intent, context.task);
  const member = context.settings.organization.members[context.intent.role];
  const profile = member === undefined ? undefined : context.settings.organization.types[member.type];
  const tiers = ['small', 'standard', 'advanced'] as const;
  const floor = profile?.minimumTier ?? 'small';
  const tier = tiers.indexOf(floor) > tiers.indexOf(decision.tier) ? floor : decision.tier;
  const provider = context.settings.providers[context.provider];
  const legacy = resolveProfile(provider, context.task, context.intent.role, tier);
  const selected = resolvePolicy({
    ...legacy,
    settings: context.settings,
    provider: context.provider,
    tier,
    versions: context.versions,
    modelChoice: context.task?.assignmentProfiles?.find((assignment) => assignment.role === context.intent.role)
      ?.modelChoice,
  });
  return {
    ...decision,
    tier,
    ...selected,
    ...reviewedIntent(context.task, context.intent.role),
    reason: `${routingReason(decision.reason, tier !== decision.tier, floor, selected.model)} ${choiceReason(selected.selection, context.task, context.intent.role)}`,
    skillNames: [
      ...new Set([
        SHARED_SKILL,
        STAGE_SKILLS[context.intent.kind],
        ...(profile?.skills ?? []),
        ...(context.settings.assignmentSkills[context.intent.kind] ?? []),
        ...(context.task?.skills ?? []),
      ]),
    ],
    ...(member !== undefined &&
      profile !== undefined && {
        organization: {
          revision: organizationRevision(context.settings.organization),
          type: member.type,
          label: profile.label,
          instructions: profile.instructions,
          reportsTo: member.reportsTo,
        },
      }),
  };
}

/**
 * Freeze only this role's approved intent, independently of mutable task history.
 *
 * @param task - Independently reviewed delivery, absent for taskless roles.
 * @param role - Exact managed seat receiving this assignment.
 * @returns Optional immutable recommendation metadata.
 */
function reviewedIntent(
  task: FactoryTask | null,
  role: FactoryJob['role'],
): Pick<NonNullable<FactoryJob['routing']>, 'reviewed'> {
  const reviewed = task?.assignmentProfiles?.find((assignment) => assignment.role === role);
  return reviewed === undefined
    ? {}
    : {
        reviewed: {
          tier: reviewed.tier,
          effort: reviewed.effort,
          reason: reviewed.reason,
          modelChoice: reviewed.modelChoice ?? null,
        },
      };
}

/**
 * Distinguish a lead's exact choice from deterministic stage defaults.
 *
 * @param selection - Frozen native request, absent for legacy profiles.
 * @param task - Persisted independently reviewed delivery.
 * @param role - Exact scheduled role.
 * @returns Bounded auditable explanation.
 */
function choiceReason(
  selection: NonNullable<FactoryJob['routing']>['selection'],
  task: FactoryTask | null,
  role: FactoryJob['role'],
): string {
  if (selection === undefined) {
    return 'Legacy CLI profile routing.';
  }
  const requested = task?.assignmentProfiles?.find((assignment) => assignment.role === role)?.modelChoice;
  const origin =
    requested === undefined || requested === null
      ? 'project default for this stage'
      : 'independently reviewed exact choice';
  return `Policy revision ${String(selection.policyRevision)}, entry ${selection.entry.id}; ${origin}.`;
}

/**
 * Resolve account-configured models and reviewed effort independently of skills.
 *
 * @param provider - Selected provider's validated model profiles.
 * @param task - Reviewed delivery, if any.
 * @param role - Current independently scheduled role.
 * @param tier - Capability after enforced risk and organization floors.
 * @returns Frozen native model and supported effort.
 */
function resolveProfile(
  provider: FactoryConfig['providers']['codex'],
  task: FactoryTask | null,
  role: FactoryJob['role'],
  tier: 'small' | 'standard' | 'advanced',
): { model: string | null; effort: 'low' | 'medium' | 'high' } {
  const requested = task?.assignmentProfiles?.find((candidate) => candidate.role === role);
  const efforts = { small: 'low', standard: 'medium', advanced: 'high' } as const;
  return {
    model: provider.models[tier] ?? provider.model ?? null,
    effort: requested?.tier === tier ? requested.effort : efforts[tier],
  };
}

/**
 * Explain model policy overrides and unknown CLI defaults without inference.
 *
 * @param reason - Scope-based capability rationale.
 * @param wasRaised - Whether organization policy raised the tier.
 * @param floor - Profile's minimum capability.
 * @param model - Configured native model, if known.
 * @returns Complete auditable routing explanation.
 */
function routingReason(reason: string, wasRaised: boolean, floor: string, model: string | null): string {
  const rationale = wasRaised ? `${reason} Organization profile requires at least ${floor}.` : reason;
  return model === null
    ? `${rationale} No model profile is configured; the authenticated CLI default is used and its capability is unverified.`
    : rationale;
}
