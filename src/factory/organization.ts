/**
 * Project-owned agent type profiles and validated reporting relationships.
 * Profiles specialize execution seats: they may narrow a seat's tools, pin a
 * provider and an allowed model, and add operator-defined local MCP servers,
 * but they never widen MALT tool authority or bypass mandatory gates.
 *
 * @file
 */
import { createHash } from 'node:crypto';

import { z } from 'zod/v3';

/** Bound reusable types independently of live process admission. */
const MAX_TYPES = 32;
/** Focused specialized instructions rather than an entire context library. */
const INSTRUCTION_MAX = 8000;
/** Preserve a short prioritized skill selection. */
const MAX_SKILLS = 4;
/** Short public type label. */
const LABEL_MAX = 120;
/** Bounded tool policy lists. */
const MAX_TOOL_RULES = 64;
/** A few focused local servers per role. */
const MAX_MCP_SERVERS = 4;
/** Literal server arguments, never a shell string. */
const MAX_MCP_ARGS = 32;
/** Longest executable path or argument. */
const MCP_TEXT_MAX = 1024;
/** Project-defined names are data, never executable paths. */
const name = z.string().regex(/^[\da-z][\w\-]{0,63}$/v);

/**
 * A tool a policy can name: a MALT MCP tool as agents see it (`mesh_…`) or a
 * native tool family (`read`, `edit`, `shell`).
 */
export const toolNameSchema = z.string().regex(/^(?:edit|mesh_[a-z][_a-z]{0,62}|read|shell)$/v);
/** Native tool families a policy can deny. */
export const NATIVE_TOOLS = ['read', 'edit', 'shell'] as const;
/** Permissions a role holds beyond its seat's tools; the Inbox question tool checks `inbox.ask`. */
export const ROLE_PERMISSIONS = ['inbox.ask'] as const;

/**
 * Narrowing-only tool policy: a non-empty allow list keeps only those of the
 * seat's tools, and the deny list removes tools. Neither can add a tool.
 */
const toolPolicySchema = z
  .object({
    allow: z.array(toolNameSchema).max(MAX_TOOL_RULES).default([]),
    deny: z.array(toolNameSchema).max(MAX_TOOL_RULES).default([]),
  })
  .strict();
/** Shell metacharacters never appear in a literal executable. */
const SHELL_CHARACTERS = ['"', '$', '&', "'", '*', ';', '<', '>', '?', '`', '|'] as const;
/** Control characters never appear in a literal executable either. */
const CONTROL = /\p{Cc}/v;

/**
 * Whether a command names one executable rather than shell syntax.
 *
 * @param value - Configured command.
 * @returns True for a literal path or program name.
 */
function isLiteralExecutable(value: string): boolean {
  return (
    value.trim() === value && !CONTROL.test(value) && SHELL_CHARACTERS.every((character) => !value.includes(character))
  );
}
/** One operator-defined local stdio MCP server, started by the provider CLI. */
export const mcpServerSchema = z
  .object({
    name: z
      .string()
      .regex(/^[a-z][\d\-_a-z]{0,31}$/v)
      .refine((value) => value !== 'agentmesh', 'agentmesh is reserved for the MALT bridge.'),
    command: z
      .string()
      .min(1)
      .max(MCP_TEXT_MAX)
      .refine(isLiteralExecutable, 'Use one executable, not a shell command.'),
    args: z
      .array(
        z
          .string()
          .max(MCP_TEXT_MAX)
          .refine((value) => !value.includes('\0'), 'Arguments cannot contain NUL.'),
      )
      .max(MAX_MCP_ARGS)
      .default([]),
  })
  .strict();
/** One configured local MCP server. */
export type McpServer = z.output<typeof mcpServerSchema>;
/** A model the role prefers, as an entry of the project's explicit model policy. */
const roleModelSchema = z
  .object({
    entryId: z.string().regex(/^[a-z][\-0-9a-z]{0,63}$/v),
    effort: z.enum(['low', 'medium', 'high']).nullable().default(null),
  })
  .strict();
/** Safe profile customization cannot widen tool or merge authority. */
const profile = z
  .object({
    label: z.string().min(1).max(LABEL_MAX),
    instructions: z.string().max(INSTRUCTION_MAX).default(''),
    skills: z.array(name).max(MAX_SKILLS).default([]),
    minimumTier: z.enum(['small', 'standard', 'advanced']).default('small'),
    /** Provider the role waits for rather than switching, or `null` for any. */
    provider: z.enum(['codex', 'claude']).nullable().default(null),
    /** Preferred model policy entry and effort floor, or `null` for stage defaults. */
    model: roleModelSchema.nullable().default(null),
    tools: toolPolicySchema.default({}),
    mcpServers: z
      .array(mcpServerSchema)
      .max(MAX_MCP_SERVERS)
      .default([])
      .refine(
        (servers) => {
          const names = new Set(servers.map((server) => server.name));
          return names.size === servers.length;
        },
        { message: 'MCP server names must be unique.' },
      ),
    permissions: z
      .array(z.enum(ROLE_PERMISSIONS))
      .max(ROLE_PERMISSIONS.length)
      .default([])
      .transform((values) => [...new Set(values)]),
  })
  .strict();
/** One validated agent type. */
export type RoleProfile = z.output<typeof profile>;
/** Every member references an existing runtime seat and reusable type. */
const memberSchema = z.object({ type: name, reportsTo: name.nullable() }).strict();
/** Raw bounded organization shape before graph validation. */
const base = z.object({ types: z.record(name, profile), members: z.record(name, memberSchema) }).strict();
/** Exact profile evidence copied into a job before process launch. */
export const frozenOrganizationSchema = z.object({
  revision: z.string(),
  type: name,
  label: z.string(),
  instructions: z.string(),
  reportsTo: name.nullable(),
  /** Tool policy in force for this attempt; absent on attempts recorded before roles could narrow tools. */
  tools: toolPolicySchema.optional(),
  mcpServers: z.array(mcpServerSchema).optional(),
  permissions: z.array(z.enum(ROLE_PERMISSIONS)).optional(),
  /** Names of the local secrets granted to this attempt's role; values are never recorded. */
  secrets: z.array(z.string()).optional(),
});

/**
 * Construct a bounded organization against the runtime's actual execution seats.
 *
 * @param roles - Supported independent seats, including the mandatory gates.
 * @param lateRoles - Seats added after organizations were first saved; absent members default.
 * @returns Schema with reference and acyclic reporting validation.
 */
export function organizationSchema(
  roles: readonly [string, ...string[]],
  lateRoles: readonly string[] = [],
): z.ZodDefault<z.ZodEffects<z.ZodEffects<typeof base>>> {
  const defaults = {
    types: { general: { label: 'Project role' } },
    members: Object.fromEntries(roles.map((role) => [role, { type: 'general', reportsTo: defaultManager(role) }])),
  };
  return base
    .transform((value) => {
      // Only seats introduced later are filled; a missing original seat still fails below.
      const type = value.types['general'] === undefined ? Object.keys(value.types)[0] : 'general';
      const members = { ...value.members };
      for (const role of lateRoles) {
        if (type !== undefined && members[role] === undefined) {
          members[role] = { type, reportsTo: defaultManager(role) };
        }
      }
      return { ...value, members };
    })
    .superRefine((value, context) => {
      if (Object.keys(value.types).length === 0 || Object.keys(value.types).length > MAX_TYPES) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'Configure between one and 32 agent types.' });
      }
      for (const [role, member] of Object.entries(value.members)) {
        if (!roles.includes(role) || (member.reportsTo !== null && !roles.includes(member.reportsTo))) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Organization references an unsupported execution seat.',
          });
        }
      }
      for (const role of roles) {
        const member = value.members[role];
        if (member === undefined || value.types[member.type] === undefined) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Missing member or unknown agent type for ${role}.`,
          });
          continue;
        }
        if (hasCycle(value, role)) {
          context.addIssue({ code: z.ZodIssueCode.custom, message: `Reporting cycle involving ${role}.` });
        }
      }
    })
    .default(defaults);
}

/**
 * Resolve the starter organization without nested conditional expressions.
 *
 * @param role - Managed seat.
 * @returns Initial manager, with the product owner as root.
 */
function defaultManager(role: string): string | null {
  if (role === 'product-owner') {
    return null;
  }
  return role === 'team-lead' || role === 'final-tester' ? 'product-owner' : 'team-lead';
}

/**
 * Detect an actual reporting cycle while permitting an explicit root.
 *
 * @param value - Parsed organization.
 * @param role - Starting execution seat.
 * @returns Whether following its parents returns to an already visited member.
 */
function hasCycle(value: z.output<typeof base>, role: string): boolean {
  const visited = new Set<string>();
  let current: string | null = role;
  while (current !== null) {
    if (visited.has(current)) {
      return true;
    }
    visited.add(current);
    current = value.members[current]?.reportsTo ?? null;
  }
  return false;
}

/**
 * Hash an approved project organization so assignments retain an exact revision.
 *
 * @param value - Validated configuration, with deterministic insertion order.
 * @returns Inspectable content identity.
 */
export function organizationRevision(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
