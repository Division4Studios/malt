/**
 * Deterministic pre-launch routing; configured models remain account-specific.
 *
 * @file
 */
import { organizationRevision } from './organization.ts';
import { resolvePolicy } from './policy-routing.ts';
import { STAGE_SKILLS } from './seats.ts';

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
/** Capability tier of one assignment. */
type Tier = 'small' | 'standard' | 'advanced';

/**
 * Choose a capability tier before reserving or starting a model process.
 *
 * @param intent - Delivery-stage requirement.
 * @param task - Actual scope and rework history.
 * @returns Capability floor and its inspectable rationale.
 */
function taskTier(intent: JobIntent, task: FactoryTask | null): { tier: Tier; reason: string } {
  if (intent.kind === 'revalidate') {
    return {
      tier: 'small',
      reason: 'Brief revalidation is a bounded comparison of a reviewed brief with merged code.',
    };
  }
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
 * The organization type that shapes an assignment: the workflow step's profile
 * when the project defines it, otherwise the seat's own type.
 *
 * @param settings - Project organization.
 * @param seatType - Type configured for the seat.
 * @param stepProfile - Profile named by the workflow step, if any.
 * @returns Type name, or `undefined` when the seat has no member.
 */
function profileType(
  settings: FactoryConfig,
  seatType: string | undefined,
  stepProfile: string | null,
): string | undefined {
  return stepProfile !== null && settings.organization.types[stepProfile] !== undefined ? stepProfile : seatType;
}

/**
 * Resolve configured native model names and selected skills without inference.
 *
 * @param context - Scoped intent, provider, configuration, durable task and the workflow step's profile override.
 * @returns Durable decision passed unchanged to both provider adapters.
 */
export function routeAssignment(context: {
  intent: JobIntent;
  provider: Provider;
  settings: FactoryConfig;
  task: FactoryTask | null;
  profile?: string | null;
  versions?: FactoryContext['providerVersions'];
}): NonNullable<FactoryJob['routing']> {
  const decision = taskTier(context.intent, context.task);
  const member = context.settings.organization.members[context.intent.role];
  const typeName = profileType(context.settings, member?.type, context.profile ?? null);
  const profile = typeName === undefined ? undefined : context.settings.organization.types[typeName];
  const tiers = ['small', 'standard', 'advanced'] as const;
  const floor = profile?.minimumTier ?? 'small';
  const tier = tiers.indexOf(floor) > tiers.indexOf(decision.tier) ? floor : decision.tier;
  const role = roleModel(context.settings, profile, context.provider);
  const selected = selectedModel(context, tier, role);
  return {
    ...decision,
    tier,
    ...selected,
    ...reviewedIntent(context.task, context.intent.role),
    reason: `${routingReason(decision.reason, tier !== decision.tier, floor, selected.model)} ${choiceReason(selected.selection, context.task, context.intent.role, role !== null)}`,
    skillNames: assignmentSkills(context, profile?.skills ?? []),
    ...frozenOrganization(context.settings, member, typeName),
  };
}

/** What routing needs to choose a model. */
interface ModelContext {
  /** Scheduled step. */
  readonly intent: JobIntent;
  /** Admitted provider family. */
  readonly provider: Provider;
  /** Project configuration with its model policy. */
  readonly settings: FactoryConfig;
  /** Delivery, absent for taskless roles. */
  readonly task: FactoryTask | null;
  /** Verified CLI versions. */
  readonly versions?: FactoryContext['providerVersions'];
}

/** A role's preferred model as a policy choice. */
interface RoleModel {
  /** Exact policy entry at the current revision. */
  readonly modelChoice: { readonly policyRevision: number; readonly entryId: string };
  /** Effort floor the role asks for, or `null` for the stage default. */
  readonly effort: Effort | null;
}

/** Native effort levels, lowest first. */
const EFFORTS = ['low', 'medium', 'high'] as const;
/** One native effort level. */
type Effort = (typeof EFFORTS)[number];

/**
 * The role type's preferred model, when it belongs to the admitted provider.
 * A model of another provider leaves the assignment on stage defaults.
 *
 * @param settings - Project configuration with its model policy.
 * @param profile - Organization type shaping the assignment.
 * @param provider - Admitted provider family.
 * @returns Policy choice, or `null` to use stage defaults.
 */
function roleModel(
  settings: FactoryConfig,
  profile: FactoryConfig['organization']['types'][string] | undefined,
  provider: Provider,
): RoleModel | null {
  const model = profile?.model ?? null;
  const policy = settings.modelPolicy;
  const entry = policy?.entries.find((candidate) => candidate.id === model?.entryId);
  return model === null || policy === undefined || entry?.provider !== provider
    ? null
    : { modelChoice: { policyRevision: policy.revision, entryId: entry.id }, effort: model.effort };
}

/**
 * Resolve the model and effort: the lead's reviewed choice first, then the
 * role's preferred model, then stage defaults; a role effort only raises the floor.
 *
 * @param context - Scoped intent, provider, configuration and delivery.
 * @param tier - Capability after enforced floors.
 * @param role - Role preference, if any.
 * @returns Frozen model, effort and selection evidence.
 */
function selectedModel(context: ModelContext, tier: Tier, role: RoleModel | null): ReturnType<typeof resolvePolicy> {
  const legacy = resolveProfile(context.settings.providers[context.provider], context.task, context.intent.role, tier);
  const reviewed = context.task?.assignmentProfiles?.find(
    (assignment) => assignment.role === context.intent.role,
  )?.modelChoice;
  const floor = role?.effort ?? null;
  const effort = floor !== null && EFFORTS.indexOf(floor) > EFFORTS.indexOf(legacy.effort) ? floor : legacy.effort;
  return resolvePolicy({
    ...legacy,
    effort,
    settings: context.settings,
    provider: context.provider,
    tier,
    versions: context.versions,
    modelChoice: reviewed ?? role?.modelChoice,
  });
}

/**
 * Shared, stage, profile, project and delivery skills, without duplicates.
 *
 * @param context - Scoped intent, configuration and delivery.
 * @param context.intent - Scheduled step.
 * @param context.settings - Project configuration.
 * @param context.task - Delivery, absent for taskless roles.
 * @param profileSkills - Skills the organization type adds.
 * @returns Ordered skill names.
 */
function assignmentSkills(
  context: { intent: JobIntent; settings: FactoryConfig; task: FactoryTask | null },
  profileSkills: readonly string[],
): string[] {
  return [
    ...new Set([
      SHARED_SKILL,
      STAGE_SKILLS[context.intent.kind],
      ...profileSkills,
      ...(context.settings.assignmentSkills[context.intent.kind] ?? []),
      ...(context.task?.skills ?? []),
    ]),
  ];
}

/**
 * The frozen organization profile for a configured seat.
 *
 * @param settings - Project organization.
 * @param member - The seat's organization member, if configured.
 * @param typeName - Organization type shaping this assignment.
 * @returns Routing fragment, empty when the seat has no member or type.
 */
function frozenOrganization(
  settings: FactoryConfig,
  member: FactoryConfig['organization']['members'][string] | undefined,
  typeName: string | undefined,
): Pick<NonNullable<FactoryJob['routing']>, 'organization'> {
  const profile = typeName === undefined ? undefined : settings.organization.types[typeName];
  return member === undefined || typeName === undefined || profile === undefined
    ? {}
    : {
        organization: {
          revision: organizationRevision(settings.organization),
          type: typeName,
          label: profile.label,
          instructions: profile.instructions,
          reportsTo: member.reportsTo,
          tools: profile.tools,
          mcpServers: profile.mcpServers,
          permissions: profile.permissions,
        },
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
 * @param hasRoleModel - Whether the role type prefers a model of this provider.
 * @returns Bounded auditable explanation.
 */
function choiceReason(
  selection: NonNullable<FactoryJob['routing']>['selection'],
  task: FactoryTask | null,
  role: FactoryJob['role'],
  hasRoleModel: boolean,
): string {
  if (selection === undefined) {
    return 'Legacy CLI profile routing.';
  }
  const requested = task?.assignmentProfiles?.find((assignment) => assignment.role === role)?.modelChoice;
  const isReviewed = requested !== undefined && requested !== null;
  const fallback = hasRoleModel ? 'role type preferred model' : 'project default for this stage';
  const origin = isReviewed ? 'independently reviewed exact choice' : fallback;
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
  tier: Tier,
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
