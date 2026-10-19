/**
 * Roles editor controls: what the editor may offer, and the revision-checked
 * organization save. A save names only reviewed skills, models the explicit
 * model policy allows for the role's provider, and tools the seats actually
 * have; the setup schema then validates seats, types and reporting, and the
 * paused setup boundary applies it. Running attempts keep the organization
 * frozen into their routing.
 *
 * @file
 */
import { z } from 'zod/v3';

import { managedTools } from '../managed-tools.ts';
import { MeshError } from '../protocol.ts';

import { NATIVE_TOOLS, ROLE_PERMISSIONS, organizationRevision } from './organization.ts';
import { FACTORY_ROLES, STAGE_SKILLS } from './seats.ts';

import type { ProjectLearning } from '../learning.ts';
import type { RolesSave } from './role-schema.ts';
import type { FactoryConfig } from './schema.ts';

/** Choices the roles editor offers; it never invents a model, skill or tool. */
export interface RoleCatalog {
  /** Current organization revision, sent back with a save. */
  readonly revision: string | null;
  /** Bundled lifecycle skills and active reviewed project skills. */
  readonly skills: readonly string[];
  /** MALT tools any seat has, as agents see them (`mesh_…`), with the seats that have each. */
  readonly tools: readonly { readonly name: string; readonly seats: readonly string[] }[];
  /** Native tool families a policy can deny. */
  readonly native: readonly string[];
  /** Permissions a role can hold. */
  readonly permissions: readonly string[];
}

/** Draft name lists; the setup schema validates everything a draft type references. */
const nameList = z.array(z.string()).optional();
/** A draft model preference. */
const draftModel = z.object({ entryId: z.string(), effort: z.string().nullable().optional() }).nullable().optional();
/** A draft tool policy. */
const draftTools = z.object({ allow: nameList, deny: nameList }).optional();
/** One draft type's references. */
const draftType = z
  .object({ skills: nameList, provider: z.string().nullable().optional(), model: draftModel, tools: draftTools })
  .passthrough();
/** Every draft type by name. */
const draftTypesSchema = z.record(draftType);
/** One draft type's references. */
type DraftType = z.output<typeof draftTypesSchema>[string];

/** What a draft is checked against. */
interface Offered {
  /** Skills the project offers. */
  readonly skills: ReadonlySet<string>;
  /** Tool names a policy can name. */
  readonly tools: ReadonlySet<string>;
  /** Current settings with the model policy. */
  readonly settings: FactoryConfig;
}

/**
 * Skills a role may prioritize: bundled lifecycle skills and active project skills.
 *
 * @param learning - Project skill library.
 * @returns Sorted skill names.
 */
export function availableSkills(learning: Pick<ProjectLearning, 'skillLibrary'>): string[] {
  const library = learning.skillLibrary();
  const archived = new Set(library.filter((entry) => entry.state === 'archived').map((entry) => entry.name));
  const names = new Set<string>(['factory-session', ...Object.values(STAGE_SKILLS)]);
  for (const entry of library) {
    if (entry.state === 'active') {
      names.add(entry.name);
    }
  }
  return [...names].filter((skill) => !archived.has(skill)).toSorted((a, b) => a.localeCompare(b));
}

/**
 * Every seat's MALT tools, keyed by the name agents see.
 *
 * @returns Tool names with the seats that have them.
 */
function seatTools(): { name: string; seats: string[] }[] {
  const seats = new Map<string, string[]>();
  for (const role of FACTORY_ROLES) {
    for (const operation of managedTools(`factory-${role}`)) {
      const tool = `mesh_${operation}`;
      seats.set(tool, [...(seats.get(tool) ?? []), role]);
    }
  }
  return Array.from(seats, ([tool, roles]) => ({ name: tool, seats: roles })).toSorted((a, b) =>
    a.name.localeCompare(b.name),
  );
}

/**
 * The roles editor's choices for the current project.
 *
 * @param settings - Current settings, or `null` before setup.
 * @param learning - Project skill library.
 * @returns Catalog with the revision a save must name.
 */
export function roleCatalog(
  settings: FactoryConfig | null,
  learning: Pick<ProjectLearning, 'skillLibrary'>,
): RoleCatalog {
  return {
    revision: settings === null ? null : organizationRevision(settings.organization),
    skills: availableSkills(learning),
    tools: seatTools(),
    native: NATIVE_TOOLS,
    permissions: ROLE_PERMISSIONS,
  };
}

/**
 * Check a type's preferred model against the explicit model policy.
 *
 * @param type - Name the type is saved under.
 * @param draft - Its references as drafted.
 * @param settings - Current settings with the model policy.
 * @returns Problems, empty when the model is allowed or none is chosen.
 */
function modelProblems(type: string, draft: DraftType, settings: FactoryConfig): string[] {
  const { model, provider } = draft;
  if (model === undefined || model === null) {
    return [];
  }
  const policy = settings.modelPolicy;
  if (policy === undefined) {
    return [`${type}: choosing a model needs an explicit model policy; set one in Project setup first.`];
  }
  const entry = policy.entries.find((candidate) => candidate.id === model.entryId);
  if (entry === undefined) {
    return [`${type}: model ${model.entryId} is not in policy revision ${String(policy.revision)}.`];
  }
  const { effort } = model;
  const efforts: readonly string[] = entry.efforts;
  if (typeof effort === 'string' && !efforts.includes(effort)) {
    return [`${type}: ${entry.model} does not offer ${effort} effort.`];
  }
  return typeof provider === 'string' && provider !== entry.provider
    ? [`${type}: ${entry.model} is a ${entry.provider} model, but the role prefers ${provider}.`]
    : [];
}

/**
 * Check one type's references against what the project actually offers.
 *
 * @param type - Name the type is saved under.
 * @param draft - Its references as drafted.
 * @param offered - Available skills, tool names and model policy.
 * @returns Problems, empty when the type is consistent.
 */
function typeProblems(type: string, draft: DraftType, offered: Offered): string[] {
  const unknownSkills = (draft.skills ?? []).filter((skill) => !offered.skills.has(skill));
  const named = [...(draft.tools?.allow ?? []), ...(draft.tools?.deny ?? [])];
  const unknownTools = named.filter((tool) => !offered.tools.has(tool));
  return [
    ...unknownSkills.map((skill) => `${type}: skill ${skill} is not a reviewed skill of this project.`),
    ...unknownTools.map((tool) => `${type}: no seat has the tool ${tool}.`),
    ...modelProblems(type, draft, offered.settings),
  ];
}

/**
 * Apply an organization edit made against the current revision.
 *
 * @param settings - Current authoritative settings.
 * @param input - Validated save.
 * @param learning - Project skill library.
 * @returns Complete settings for the paused setup boundary, which validates them in full.
 * @throws {MeshError} For a stale revision or references the project does not offer.
 */
export function updatedOrganization(
  settings: FactoryConfig,
  input: RolesSave,
  learning: Pick<ProjectLearning, 'skillLibrary'>,
): Record<string, unknown> {
  if (organizationRevision(settings.organization) !== input.expectedRevision) {
    throw new MeshError('FACTORY_GATED', 'The organization changed since you opened it; refresh before saving.');
  }
  const catalog = roleCatalog(settings, learning);
  const tools = new Set<string>(catalog.native);
  for (const tool of catalog.tools) {
    tools.add(tool.name);
  }
  const offered: Offered = { skills: new Set(catalog.skills), tools, settings };
  // Malformed types are left for the setup schema, which reports them precisely.
  const types = draftTypesSchema.safeParse(input.organization['types']);
  const problems = types.success
    ? Object.entries(types.data).flatMap(([type, draft]) => typeProblems(type, draft, offered))
    : [];
  if (problems.length > 0) {
    throw new MeshError('INVALID_INPUT', problems.join(' '));
  }
  return { ...settings, organization: input.organization };
}
