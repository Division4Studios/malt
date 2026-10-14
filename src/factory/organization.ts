/**
 * Project-owned agent type profiles and validated reporting relationships.
 * Profiles specialize execution seats without granting additional permissions.
 *
 * @file
 */
import { createHash } from 'node:crypto';

import { z } from 'zod';

/** Bound reusable types independently of live process admission. */
const MAX_TYPES = 32;
/** Focused specialized instructions rather than an entire context library. */
const INSTRUCTION_MAX = 8000;
/** Preserve a short prioritized skill selection. */
const MAX_SKILLS = 4;
/** Short public type label. */
const LABEL_MAX = 120;
/** Project-defined names are data, never executable paths. */
const name = z.string().regex(/^[\da-z][\w\-]{0,63}$/v);
/** Safe profile customization cannot override tool or merge authority. */
const profile = z
  .object({
    label: z.string().min(1).max(LABEL_MAX),
    instructions: z.string().max(INSTRUCTION_MAX).default(''),
    skills: z.array(name).max(MAX_SKILLS).default([]),
    minimumTier: z.enum(['small', 'standard', 'advanced']).default('small'),
  })
  .strict();
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
});

/**
 * Construct a bounded organization against the runtime's actual execution seats.
 *
 * @param roles - Supported independent seats, including the mandatory gates.
 * @returns Schema with reference and acyclic reporting validation.
 */
export function organizationSchema(roles: readonly [string, ...string[]]): z.ZodDefault<z.ZodEffects<typeof base>> {
  const defaults = {
    types: { general: { label: 'Project role', instructions: '', skills: [], minimumTier: 'small' as const } },
    members: Object.fromEntries(roles.map((role) => [role, { type: 'general', reportsTo: defaultManager(role) }])),
  };
  return base
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
