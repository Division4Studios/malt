/**
 * DOM-free model of the Secrets view. The broker sends secret names, grants,
 * versions and keyed fingerprints, never values; this module reads them,
 * checks names and values before sending, and builds the version-checked
 * saves. A value typed into the view goes only into the save it is sent with.
 *
 * @file
 */
import { asData } from './console-model.js';

import type { Data } from './api.js';

/** Shortest value the broker accepts. */
export const VALUE_MIN = 8;
/** Longest value the broker accepts. */
export const VALUE_MAX = 16_384;
/** Environment variable names. */
const NAME = /^[A-Z][\dA-Z_]{0,63}$/v;
/** Names reserved for the runtime, provider CLIs, Git and GitHub. */
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
/** Reserved prefixes. */
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
] as const;

/** One secret, without its value. */
export interface SecretView {
  /** Environment variable name. */
  readonly name: string;
  /** Version a change must name. */
  readonly version: number;
  /** Keyed fingerprint that changes when the value is rotated. */
  readonly fingerprint: string;
  /** Role types that receive it. */
  readonly grants: readonly string[];
  /** Created, epoch milliseconds. */
  readonly createdAt: number;
  /** Last changed, epoch milliseconds. */
  readonly updatedAt: number;
}

/** One audit entry. */
export interface AuditView {
  /** When. */
  readonly at: number;
  /** What changed. */
  readonly action: 'created' | 'rotated' | 'regranted' | 'deleted';
  /** Secret name. */
  readonly name: string;
  /** Grants after the change. */
  readonly grants: readonly string[];
}

/** Everything the Secrets view shows. */
export interface SecretsModel {
  /** Secrets by name. */
  readonly secrets: readonly SecretView[];
  /** Newest audit entries first. */
  readonly audit: readonly AuditView[];
  /** Role types a secret can be granted to, with labels. */
  readonly types: readonly { readonly name: string; readonly label: string }[];
}

/** Audit actions. */
const ACTIONS = ['created', 'rotated', 'regranted', 'deleted'] as const;

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
 * Strings of an untrusted array.
 *
 * @param value - Untrusted value.
 * @returns String members.
 */
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/**
 * A finite number field, or zero.
 *
 * @param record - Untrusted record.
 * @param key - Field name.
 * @returns Finite value, zero when absent.
 */
function numberOf(record: Data, key: string): number {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Parse one secret's metadata.
 *
 * @param record - Untrusted record.
 * @returns Secret, or `null` when malformed.
 */
function parseSecret(record: Data): SecretView | null {
  const { name, fingerprint } = record;
  const version = numberOf(record, 'version');
  if (typeof name !== 'string' || typeof fingerprint !== 'string' || version < 1) {
    return null;
  }
  return {
    name,
    version,
    fingerprint,
    grants: strings(record['grants']),
    createdAt: numberOf(record, 'createdAt'),
    updatedAt: numberOf(record, 'updatedAt'),
  };
}

/**
 * Parse one audit entry.
 *
 * @param record - Untrusted record.
 * @returns Entry, or `null` when malformed.
 */
function parseAudit(record: Data): AuditView | null {
  const action = ACTIONS.find((candidate) => candidate === record['action']);
  const { name } = record;
  return action === undefined || typeof name !== 'string'
    ? null
    : { at: numberOf(record, 'at'), action, name, grants: strings(record['grants']) };
}

/**
 * Read the Secrets view model from a snapshot.
 *
 * @param snapshot - Validated live snapshot.
 * @returns Secrets, audit trail and grantable role types.
 */
export function readSecrets(snapshot: unknown): SecretsModel {
  const factory = asData(asData(snapshot)?.['factory']) ?? {};
  const secrets = asData(factory['secrets']);
  const organization = asData(asData(factory['settings'])?.['organization']);
  const types = Object.entries(asData(organization?.['types']) ?? {}).map(([name, value]) => {
    const label = asData(value)?.['label'];
    return { name, label: typeof label === 'string' && label !== '' ? label : name };
  });
  return {
    secrets: objects(secrets?.['entries'])
      .map((record) => parseSecret(record))
      .filter((secret) => secret !== null),
    audit: objects(secrets?.['audit'])
      .map((record) => parseAudit(record))
      .filter((entry) => entry !== null),
    types,
  };
}

/**
 * Why a name cannot be used, or `null` when it can.
 *
 * @param name - Name as typed.
 * @param existing - Names already in use.
 * @returns Problem text, or `null`.
 */
export function nameProblem(name: string, existing: readonly string[]): string | null {
  if (!NAME.test(name)) {
    return 'Use an environment variable name: capital letters, digits and underscores, starting with a letter.';
  }
  if (RESERVED_NAMES.has(name) || RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    return 'This name is reserved for the runtime, a provider CLI, Git or GitHub.';
  }
  return existing.includes(name) ? 'A secret with this name already exists; rotate it instead.' : null;
}

/**
 * Why a value cannot be saved, or `null` when it can.
 *
 * @param value - Value as typed.
 * @returns Problem text, or `null`.
 */
export function valueProblem(value: string): string | null {
  if (value.length < VALUE_MIN || value.length > VALUE_MAX) {
    return `Values are ${String(VALUE_MIN)} to ${String(VALUE_MAX)} characters; shorter ones would hide ordinary output when redacted.`;
  }
  return value.includes('\0') ? 'Values cannot contain NUL characters.' : null;
}

/**
 * The version-checked save of a new secret, a rotation or new grants.
 *
 * @param change - What to save.
 * @param change.name - Environment variable name to save under.
 * @param change.value - New value, or `null` to keep the current one.
 * @param change.grants - Role types that receive it.
 * @param change.existing - The secret as shown, or `null` when creating.
 * @returns Operator control.
 */
export function secretSaveInput(change: {
  readonly name: string;
  readonly value: string | null;
  readonly grants: readonly string[];
  readonly existing: SecretView | null;
}): { readonly operation: 'factory_secret_save'; readonly input: Data } {
  return {
    operation: 'factory_secret_save',
    input: {
      name: change.name,
      ...(change.value !== null && { value: change.value }),
      grants: [...change.grants],
      expectedVersion: change.existing?.version ?? null,
    },
  };
}

/**
 * The version-checked deletion of a secret.
 *
 * @param secret - The secret as shown.
 * @returns Operator control.
 */
export function secretDeleteInput(secret: SecretView): {
  readonly operation: 'factory_secret_delete';
  readonly input: Data;
} {
  return { operation: 'factory_secret_delete', input: { name: secret.name, expectedVersion: secret.version } };
}

/**
 * Describe who receives a secret.
 *
 * @param secret - Metadata whose grants are described.
 * @param types - Role types with labels.
 * @returns Readable grant list.
 */
export function grantText(secret: SecretView, types: SecretsModel['types']): string {
  if (secret.grants.length === 0) {
    return 'Not granted to any role type yet.';
  }
  const labels = secret.grants.map((grant) => types.find((type) => type.name === grant)?.label ?? `${grant} (removed)`);
  return `Injected into ${labels.join(', ')}.`;
}

/**
 * Describe one audit entry.
 *
 * @param entry - Recorded change to describe.
 * @returns Readable line.
 */
export function auditText(entry: AuditView): string {
  const grants = entry.grants.length === 0 ? 'no role types' : entry.grants.join(', ');
  const verbs = { created: 'Created', rotated: 'Rotated', regranted: 'Changed grants of', deleted: 'Deleted' } as const;
  return `${verbs[entry.action]} ${entry.name} (${grants})`;
}
