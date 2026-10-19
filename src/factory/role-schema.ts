/**
 * Operator controls for the roles editor and the local secrets store. Role
 * saves carry the organization revision the operator edited; secret saves
 * carry the secret's version, so concurrent edits are refused, never merged.
 * Secret values are accepted here and never returned by any operation.
 *
 * @file
 */
import { z } from 'zod/v3';

/** Longest accepted secret value. */
export const SECRET_VALUE_MAX = 16_384;
/** Shortest accepted secret value; shorter values would make redaction erase ordinary output. */
export const SECRET_VALUE_MIN = 8;
/** Most role types one secret can be granted to. */
const MAX_GRANTS = 32;
/** Environment names that would let a granted secret replace runtime, provider or Git authority. */
const RESERVED_NAMES: ReadonlySet<string> = new Set([
  'APPDATA',
  'COMSPEC',
  'HOME',
  'LOCALAPPDATA',
  'NODE_OPTIONS',
  'NODE_PATH',
  'PATH',
  'PATHEXT',
  'SHELL',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USERPROFILE',
]);
/** Prefixes owned by MALT, the provider CLIs, Git and GitHub. */
const RESERVED_PREFIXES = [
  'AGENTMESH_',
  'ANTHROPIC_',
  'CLAUDE_',
  'CODEX_',
  'GH_',
  'GIT_',
  'GITHUB_',
  'MALT_',
  'NPM_CONFIG_',
  'OPENAI_',
];

/** A secret name, used as the environment variable it is injected as. */
export const secretNameSchema = z
  .string()
  .regex(/^[A-Z][\dA-Z_]{0,63}$/v, 'Use an environment variable name: capital letters, digits and underscores.')
  .refine(
    (name) => !RESERVED_NAMES.has(name) && RESERVED_PREFIXES.every((prefix) => !name.startsWith(prefix)),
    'This name is reserved for the runtime, a provider CLI, Git or GitHub.',
  );
/** A role type name, as organizations spell it. */
const typeNameSchema = z.string().regex(/^[\da-z][\w\-]{0,63}$/v);

/** Role and secret operations, all human-operator only. */
export const ROLE_OPERATIONS = ['factory_roles_save', 'factory_secret_save', 'factory_secret_delete'] as const;

/** Every role and secret operation's input schema. */
export const roleSchemas = {
  factory_roles_save: z
    .object({
      /** Organization revision the operator edited (`organizationRevision`). */
      expectedRevision: z.string().regex(/^[\da-f]{64}$/v),
      /** Complete organization; the setup schema validates seats, types and reporting. */
      organization: z.record(z.unknown()),
    })
    .strict(),
  factory_secret_save: z
    .object({
      name: secretNameSchema,
      /** New value; required to create, omitted to change only the grants. */
      value: z
        .string()
        .min(SECRET_VALUE_MIN)
        .max(SECRET_VALUE_MAX)
        .refine((value) => !value.includes('\0'), 'Secret values cannot contain NUL.')
        .optional(),
      /** Role types whose attempts receive the secret. */
      grants: z
        .array(typeNameSchema)
        .max(MAX_GRANTS)
        .transform((grants) => [...new Set(grants)].toSorted((a, b) => a.localeCompare(b))),
      /** Version the operator saw, or `null` to create a new secret. */
      expectedVersion: z.number().int().positive().nullable(),
    })
    .strict(),
  factory_secret_delete: z.object({ name: secretNameSchema, expectedVersion: z.number().int().positive() }).strict(),
};
/** Validated secret save. */
export type SecretSave = z.output<(typeof roleSchemas)['factory_secret_save']>;
/** Validated secret deletion. */
export type SecretDelete = z.output<(typeof roleSchemas)['factory_secret_delete']>;
/** Validated role save. */
export type RolesSave = z.output<(typeof roleSchemas)['factory_roles_save']>;
