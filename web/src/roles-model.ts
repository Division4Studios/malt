/**
 * DOM-free model of the Roles view: it reads the project organization, the
 * explicit model policy and the broker's roles catalog from the snapshot,
 * keeps an editable draft of role types and seat members, checks a draft
 * against what the project offers, and builds the revision-checked save. The
 * broker stays the authority and re-validates every save.
 *
 * @file
 */
import { asData } from './console-model.js';
import { t } from './i18n.js';

import type { Data } from './api.js';

/** Capability floors, lowest first. */
export const TIERS = ['small', 'standard', 'advanced'] as const;
/** Providers a role can wait for. */
export const PROVIDERS = ['codex', 'claude'] as const;
/** Most prioritized skills per type. */
export const MAX_SKILLS = 4;
/** Most local MCP servers per type. */
export const MAX_SERVERS = 4;
/** Longest instructions. */
export const INSTRUCTIONS_MAX = 8000;
/** Longest label. */
export const LABEL_MAX = 120;
/** Type and member names. */
const NAME = /^[\da-z][\w\-]{0,63}$/v;
/** MCP server names. */
const SERVER_NAME = /^[a-z][\d\-_a-z]{0,31}$/v;
/** Longest name stem kept when a copy is named, leaving room for `-copy-NN`. */
const STEM_MAX = 55;
/** Characters that make a command shell syntax rather than one executable. */
const SHELL_CHARACTERS = ['"', '$', '&', "'", '*', ';', '<', '>', '?', '`', '|'] as const;

/** One capability floor. */
export type Tier = (typeof TIERS)[number];
/** One provider family. */
export type Provider = (typeof PROVIDERS)[number];

/** One local stdio MCP server. */
export interface ServerDraft {
  /** Server name. */
  readonly name: string;
  /** Executable. */
  readonly command: string;
  /** Literal arguments. */
  readonly args: readonly string[];
}

/** One editable role type. */
export interface TypeDraft {
  /** Type name; seats reference it. */
  readonly name: string;
  /** Display label. */
  readonly label: string;
  /** Extra instructions. */
  readonly instructions: string;
  /** Prioritized reviewed skills. */
  readonly skills: readonly string[];
  /** Capability floor. */
  readonly minimumTier: Tier;
  /** Provider the role waits for, or `null` for any. */
  readonly provider: Provider | null;
  /** Preferred model policy entry, or `null` for stage defaults. */
  readonly modelId: string | null;
  /** Effort floor for the preferred model, or `null` for the stage default. */
  readonly effort: string | null;
  /** How the tool list applies. */
  readonly toolMode: 'deny' | 'allow';
  /** Tools the mode lists. */
  readonly tools: readonly string[];
  /** Local MCP servers. */
  readonly servers: readonly ServerDraft[];
  /** Whether the role may ask the operator questions. */
  readonly canAsk: boolean;
}

/** One seat's member entry. */
export interface MemberDraft {
  /** Seat. */
  readonly role: string;
  /** Type it uses. */
  readonly type: string;
  /** Seat it reports to, or `null` for the operator. */
  readonly reportsTo: string | null;
}

/** One allowed model. */
export interface ModelChoice {
  /** Policy entry id. */
  readonly id: string;
  /** Provider family. */
  readonly provider: Provider;
  /** Native model name. */
  readonly model: string;
  /** Effort levels the model supports. */
  readonly efforts: readonly string[];
}

/** What the editor may offer. */
export interface RolesCatalog {
  /** Organization revision a save names. */
  readonly revision: string | null;
  /** Reviewed skills. */
  readonly skills: readonly string[];
  /** MALT tools with the seats that have them. */
  readonly tools: readonly { readonly name: string; readonly seats: readonly string[] }[];
  /** Native tool families. */
  readonly native: readonly string[];
}

/** Everything the Roles view shows. */
export interface RolesModel {
  /** Whether the project has factory settings. */
  readonly isConfigured: boolean;
  /** Whether saves are possible now: paused with nothing running. */
  readonly isPaused: boolean;
  /** Saved role types, by name. */
  readonly types: readonly TypeDraft[];
  /** Saved seat members. */
  readonly members: readonly MemberDraft[];
  /** Editor choices. */
  readonly catalog: RolesCatalog;
  /** Models the explicit policy allows; empty without a policy. */
  readonly models: readonly ModelChoice[];
  /** Secret names granted to each type. */
  readonly secrets: Readonly<Record<string, readonly string[]>>;
}

/**
 * Strings of an untrusted array.
 *
 * @param value - Untrusted value.
 * @returns String members.
 */
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/**
 * A string field, or a fallback.
 *
 * @param record - Untrusted record.
 * @param key - Field name.
 * @param fallback - Value when absent.
 * @returns Field text.
 */
function textOf(record: Data | null, key: string, fallback = ''): string {
  const value = record?.[key];
  return typeof value === 'string' ? value : fallback;
}

/**
 * Plain-object members of an untrusted array.
 *
 * @param value - Untrusted value.
 * @returns Object members.
 */
function objects(value: unknown): Data[] {
  return Array.isArray(value) ? value.map((item) => asData(item)).filter((item) => item !== null) : [];
}

/**
 * Whether a value is a provider family.
 *
 * @param value - Untrusted value.
 * @returns True for codex or claude.
 */
function isProvider(value: unknown): value is Provider {
  return value === 'codex' || value === 'claude';
}

/**
 * A non-empty string field, or `null`.
 *
 * @param record - Untrusted record, if any.
 * @param key - Field name.
 * @returns Field text, or `null` when absent or empty.
 */
function optionalText(record: Data | null, key: string): string | null {
  const value = textOf(record, key);
  return value === '' ? null : value;
}

/**
 * Read one saved type into an editable draft.
 *
 * @param name - Key the type is saved under.
 * @param record - Saved type.
 * @returns Editable copy.
 */
function typeDraft(name: string, record: Data): TypeDraft {
  const model = asData(record['model']);
  const tools = asData(record['tools']);
  const allow = strings(tools?.['allow']);
  const tier = textOf(record, 'minimumTier', 'small');
  return {
    name,
    label: textOf(record, 'label', name),
    instructions: textOf(record, 'instructions'),
    skills: strings(record['skills']),
    minimumTier: TIERS.find((candidate) => candidate === tier) ?? 'small',
    provider: isProvider(record['provider']) ? record['provider'] : null,
    modelId: optionalText(model, 'entryId'),
    effort: optionalText(model, 'effort'),
    toolMode: allow.length > 0 ? 'allow' : 'deny',
    tools: allow.length > 0 ? allow : strings(tools?.['deny']),
    servers: objects(record['mcpServers']).map((server) => {
      return {
        name: textOf(server, 'name'),
        command: textOf(server, 'command'),
        args: strings(server['args']),
      };
    }),
    canAsk: strings(record['permissions']).includes('inbox.ask'),
  };
}

/**
 * Read the allowed models from the explicit policy.
 *
 * @param policy - Saved model policy, if any.
 * @returns Allowed models.
 */
function policyModels(policy: Data | null): ModelChoice[] {
  const choices: ModelChoice[] = [];
  const entries = objects(policy?.['entries']);
  for (const entry of entries) {
    const { provider } = entry;
    const id = textOf(entry, 'id');
    if (id !== '' && isProvider(provider)) {
      choices.push({ id, provider, model: textOf(entry, 'model', id), efforts: strings(entry['efforts']) });
    }
  }
  return choices;
}

/**
 * Secret names granted to each type.
 *
 * @param secrets - Snapshot secrets block.
 * @returns Names keyed by type.
 */
function grantsByType(secrets: Data | null): Record<string, string[]> {
  const byType: Record<string, string[]> = {};
  const entries = objects(secrets?.['entries']);
  for (const entry of entries) {
    const grants = strings(entry['grants']);
    for (const type of grants) {
      byType[type] = [...(byType[type] ?? []), textOf(entry, 'name')];
    }
  }
  return byType;
}

/**
 * Read the saved types and seat members.
 *
 * @param organization - Saved organization, if any.
 * @returns Editable types and members.
 */
function readOrganization(organization: Data | null): Pick<RolesModel, 'types' | 'members'> {
  const types: TypeDraft[] = [];
  const members: MemberDraft[] = [];
  if (organization === null) {
    return { types, members };
  }
  const saved = Object.entries(asData(organization['types']) ?? {});
  for (const [name, value] of saved) {
    const record = asData(value);
    if (record !== null) {
      types.push(typeDraft(name, record));
    }
  }
  const seats = Object.entries(asData(organization['members']) ?? {});
  for (const [role, value] of seats) {
    const record = asData(value);
    if (record !== null) {
      members.push({ role, type: textOf(record, 'type'), reportsTo: optionalText(record, 'reportsTo') });
    }
  }
  return { types, members };
}

/**
 * Read the broker's editor choices.
 *
 * @param catalog - Snapshot roles block, if any.
 * @returns Revision, skills and tools the editor may offer.
 */
function readCatalog(catalog: Data | null): RolesCatalog {
  return {
    revision: optionalText(catalog, 'revision'),
    skills: strings(catalog?.['skills']),
    tools: objects(catalog?.['tools']).map((tool) => ({ name: textOf(tool, 'name'), seats: strings(tool['seats']) })),
    native: strings(catalog?.['native']),
  };
}

/**
 * Read the Roles view model from a snapshot.
 *
 * @param snapshot - Validated live snapshot.
 * @returns Saved organization, catalog and allowed models.
 */
export function readRoles(snapshot: unknown): RolesModel {
  const factory = asData(asData(snapshot)?.['factory']) ?? {};
  const settings = asData(factory['settings']);
  const jobs = objects(factory['jobs']);
  return {
    isConfigured: settings !== null,
    isPaused: factory['active'] !== true && jobs.every((job) => job['state'] !== 'running'),
    ...readOrganization(asData(settings?.['organization'])),
    catalog: readCatalog(asData(factory['roles'])),
    models: policyModels(asData(settings?.['modelPolicy'])),
    secrets: grantsByType(asData(factory['secrets'])),
  };
}

/**
 * Seats that use a type.
 *
 * @param members - Seat members.
 * @param type - Type name.
 * @returns Seat names.
 */
export function seatsUsing(members: readonly MemberDraft[], type: string): string[] {
  return members.filter((member) => member.type === type).map((member) => member.role);
}

/**
 * Tools a type's seats have: MALT tools of those seats, then native families.
 * A type no seat uses yet is offered every tool.
 *
 * @param catalog - Editor choices.
 * @param seats - Seats using the type.
 * @returns Tool names in display order.
 */
export function toolsFor(catalog: RolesCatalog, seats: readonly string[]): string[] {
  const malt = catalog.tools
    .filter((tool) => seats.length === 0 || tool.seats.some((seat) => seats.includes(seat)))
    .map((tool) => tool.name);
  return [...malt, ...catalog.native];
}

/**
 * A fresh type with nothing narrowed.
 *
 * @param name - Name for the new type.
 * @returns Type with default fields.
 */
export function blankType(name: string): TypeDraft {
  return {
    name,
    label: name,
    instructions: '',
    skills: [],
    minimumTier: 'small',
    provider: null,
    modelId: null,
    effort: null,
    toolMode: 'deny',
    tools: [],
    servers: [],
    canAsk: false,
  };
}

/**
 * Copy a type under the first free `-copy` name.
 *
 * @param types - Existing types.
 * @param source - Type to copy.
 * @returns Copy with a unique name.
 */
export function duplicateType(types: readonly TypeDraft[], source: TypeDraft): TypeDraft {
  const taken = new Set(types.map((type) => type.name));
  const stem = source.name.slice(0, STEM_MAX);
  let name = `${stem}-copy`;
  let index = 2;
  while (taken.has(name)) {
    name = `${stem}-copy-${String(index)}`;
    index += 1;
  }
  return { ...source, name, label: `${source.label} (copy)` };
}

/**
 * Split argument text, one literal argument per line.
 *
 * @param text - Arguments as typed.
 * @returns Arguments without the trailing empty line.
 */
export function argumentLines(text: string): string[] {
  const lines = text.split(/\r?\n/v);
  return lines.at(-1) === '' ? lines.slice(0, -1) : lines;
}

/**
 * Problems with one server.
 *
 * @param server - Draft server.
 * @returns Problems, empty when valid.
 */
function serverProblems(server: ServerDraft): string[] {
  const problems: string[] = [];
  if (!SERVER_NAME.test(server.name) || server.name === 'agentmesh') {
    problems.push(
      t('MCP server name "{name}" must be lower case letters, digits, - or _, and not agentmesh.', {
        name: server.name,
      }),
    );
  }
  const isLiteral =
    server.command !== '' &&
    server.command.trim() === server.command &&
    SHELL_CHARACTERS.every((character) => !server.command.includes(character));
  if (!isLiteral) {
    const label = server.name === '' ? '(unnamed)' : server.name;
    problems.push(t('MCP server {label}: give one executable, not a shell command.', { label }));
  }
  return problems;
}

/**
 * Problems with one type's model choice.
 *
 * @param type - Draft type.
 * @param models - Allowed models.
 * @returns Problems, empty when consistent.
 */
function modelProblems(type: TypeDraft, models: readonly ModelChoice[]): string[] {
  if (type.modelId === null) {
    return [];
  }
  const model = models.find((candidate) => candidate.id === type.modelId);
  if (model === undefined) {
    return [t('{name}: the chosen model is no longer allowed by the model policy.', { name: type.name })];
  }
  if (type.provider !== null && type.provider !== model.provider) {
    return [
      t('{name}: {model} is a {provider} model, but the role waits for {provider2}.', {
        name: type.name,
        model: model.model,
        provider: model.provider,
        provider2: type.provider,
      }),
    ];
  }
  return type.effort === null || model.efforts.includes(type.effort)
    ? []
    : [
        t('{name}: {model} does not offer {effort} effort.', {
          name: type.name,
          model: model.model,
          effort: type.effort,
        }),
      ];
}

/**
 * Problems with one type, before the broker checks it.
 *
 * @param type - Draft type.
 * @param model - Current view model.
 * @returns Problems, empty when the type can be saved.
 */
export function typeProblems(type: TypeDraft, model: RolesModel): string[] {
  const problems: string[] = [];
  if (!NAME.test(type.name)) {
    problems.push(t('Type names use lower case letters, digits, - or _ and start with a letter or digit.'));
  }
  if (type.label.trim() === '' || type.label.length > LABEL_MAX) {
    problems.push(
      t('{name}: give a label of at most {labelMax} characters.', { name: type.name, labelMax: LABEL_MAX }),
    );
  }
  if (type.skills.length > MAX_SKILLS) {
    problems.push(t('{name}: prioritize at most {maxSkills} skills.', { name: type.name, maxSkills: MAX_SKILLS }));
  }
  const unknown = type.skills.filter((skill) => !model.catalog.skills.includes(skill));
  if (unknown.length > 0) {
    problems.push(t('{name}: {value} is not a reviewed skill.', { name: type.name, value: unknown.join(', ') }));
  }
  if (type.servers.length > MAX_SERVERS) {
    problems.push(t('{name}: at most {maxServers} MCP servers.', { name: type.name, maxServers: MAX_SERVERS }));
  }
  const serverNames = new Set(type.servers.map((server) => server.name));
  if (serverNames.size !== type.servers.length) {
    problems.push(t('{name}: MCP server names must be unique.', { name: type.name }));
  }
  return [
    ...problems,
    ...type.servers.flatMap((server) => serverProblems(server)),
    ...modelProblems(type, model.models),
  ];
}

/**
 * Problems with the whole organization draft.
 *
 * @param types - Draft types.
 * @param members - Draft members.
 * @param model - Current view model.
 * @returns Problems, empty when the draft can be saved.
 */
export function organizationProblems(
  types: readonly TypeDraft[],
  members: readonly MemberDraft[],
  model: RolesModel,
): string[] {
  const names = new Set(types.map((type) => type.name));
  const problems = types.flatMap((type) => typeProblems(type, model));
  if (names.size !== types.length) {
    problems.push(t('Type names must be unique.'));
  }
  for (const member of members) {
    if (!names.has(member.type)) {
      problems.push(t('{role} uses a type that no longer exists.', { role: member.role }));
    }
  }
  return problems;
}

/**
 * The saved form of one type.
 *
 * @param type - Draft type.
 * @returns Organization type record.
 */
function savedType(type: TypeDraft): Data {
  return {
    label: type.label.trim(),
    instructions: type.instructions,
    skills: type.skills,
    minimumTier: type.minimumTier,
    provider: type.provider,
    model: type.modelId === null ? null : { entryId: type.modelId, effort: type.effort },
    tools: type.toolMode === 'allow' ? { allow: type.tools, deny: [] } : { allow: [], deny: type.tools },
    mcpServers: type.servers.map((server) => ({ name: server.name, command: server.command, args: server.args })),
    permissions: type.canAsk ? ['inbox.ask'] : [],
  };
}

/**
 * The revision-checked organization save.
 *
 * @param revision - Revision the draft was edited from.
 * @param types - Draft types.
 * @param members - Draft members.
 * @returns Operator control.
 */
export function rolesSaveInput(
  revision: string,
  types: readonly TypeDraft[],
  members: readonly MemberDraft[],
): { readonly operation: 'factory_roles_save'; readonly input: Data } {
  return {
    operation: 'factory_roles_save',
    input: {
      expectedRevision: revision,
      organization: {
        types: Object.fromEntries(types.map((type) => [type.name, savedType(type)])),
        members: Object.fromEntries(
          members.map((member) => [member.role, { type: member.type, reportsTo: member.reportsTo }]),
        ),
      },
    },
  };
}

/**
 * One line describing a type's model and provider.
 *
 * @param type - Draft type.
 * @param models - Allowed models.
 * @returns Summary text.
 */
export function modelSummary(type: TypeDraft, models: readonly ModelChoice[]): string {
  const model = models.find((candidate) => candidate.id === type.modelId);
  const provider = type.provider === null ? t('any provider') : t('waits for {provider}', { provider: type.provider });
  const chosen = model === undefined ? t('stage default model') : model.model;
  const effort = type.effort === null ? '' : t(', {effort} effort or higher', { effort: type.effort });
  return t('{chosen}{effort} · {provider} · at least {minimumTier}', {
    chosen,
    effort,
    provider,
    minimumTier: type.minimumTier,
  });
}

/**
 * One line describing a type's tool policy.
 *
 * @param type - Draft type.
 * @returns Summary text.
 */
export function toolSummary(type: TypeDraft): string {
  if (type.tools.length === 0) {
    return t('Every tool its seats have');
  }
  return t(
    type.toolMode === 'allow' ? 'Only {value} of the kinds listed (MALT or native)' : 'All seat tools except {value}',
    { value: type.tools.join(', ') },
  );
}
