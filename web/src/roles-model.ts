/**
 * DOM-free model of the Roles view: it reads the project organization, the
 * explicit model policy and the broker's roles catalog from the snapshot,
 * keeps an editable draft of role types and seat members, checks a draft
 * against what the project offers, and builds the revision-checked save. The
 * broker stays the authority and re-validates every save.
 *
 * @file
 */

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
/** Longest name stem kept when a copy is named, leaving room for `-copy-NN`. */
const STEM_MAX = 55;

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
 * One line describing a type's model and provider.
 *
 * @param type - Draft type.
 * @param models - Allowed models.
 * @returns Summary text.
 */
export function modelSummary(type: TypeDraft, models: readonly ModelChoice[]): string {
  const model = models.find((candidate) => candidate.id === type.modelId);
  const provider = type.provider === null ? 'any provider' : `waits for ${type.provider}`;
  const chosen = model === undefined ? 'stage default model' : model.model;
  const effort = type.effort === null ? '' : `, ${type.effort} effort or higher`;
  return `${chosen}${effort} · ${provider} · at least ${type.minimumTier}`;
}

/**
 * One line describing a type's tool policy.
 *
 * @param type - Draft type.
 * @returns Summary text.
 */
export function toolSummary(type: TypeDraft): string {
  if (type.tools.length === 0) {
    return 'Every tool its seats have';
  }
  return type.toolMode === 'allow'
    ? `Only ${type.tools.join(', ')} of the kinds listed (MALT or native)`
    : `All seat tools except ${type.tools.join(', ')}`;
}
