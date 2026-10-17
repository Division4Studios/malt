/**
 * Local encrypted secrets granted to role types. Values are sealed with
 * AES-256-GCM under a random per-project key kept in the private `.malt`
 * directory, bound to their name so a sealed value cannot be moved to another
 * name, and are write-only: status shows names, grants, versions and a keyed
 * fingerprint, never a value. Only the supervisor opens a value, when it
 * starts a granted role's provider process, and every opened value joins that
 * attempt's redaction list. The audit trail records actions, never values.
 *
 * On Windows the key file relies on `.malt` being private to the operator's
 * account, as every other `.malt` credential does.
 *
 * @file
 */
import { Buffer } from 'node:buffer';
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { z } from 'zod/v3';

import { run, selectAll } from '../database.ts';
import { hasErrorCode } from '../errors.ts';
import { MeshError } from '../protocol.ts';

import type { Store } from '../store.ts';
import type { SecretDelete, SecretSave } from './role-schema.ts';

/** AES-256 key length. */
const KEY_BYTES = 32;
/** GCM nonce length. */
const IV_BYTES = 12;
/** Fingerprint length in hex digits; enough to tell values apart, too short to verify a guess offline. */
const FINGERPRINT_HEX = 16;
/** Audit entries kept per project. */
const AUDIT_KEPT = 200;
/** Audit entries shown in status. */
const AUDIT_SHOWN = 50;
/** Most secrets per project. */
const MAX_SECRETS = 100;
/** Associated-data prefix binding a sealed value to its name and format. */
const AAD_PREFIX = 'malt-vault:v1:';
/** Key file name under the project's private factory directory. */
const KEY_FILE = 'vault.key';

/** One sealed secret as stored. */
const sealedSchema = z.object({
  name: z.string(),
  version: z.number().int().positive(),
  iv: z.string(),
  tag: z.string(),
  ciphertext: z.string(),
  fingerprint: z.string(),
  grants: z.array(z.string()),
  createdAt: z.number(),
  updatedAt: z.number(),
});
/** Stored sealed secret. */
type Sealed = z.output<typeof sealedSchema>;
/** One audit entry. */
const auditSchema = z.object({
  at: z.number(),
  action: z.enum(['created', 'rotated', 'regranted', 'deleted']),
  name: z.string(),
  grants: z.array(z.string()),
});
/** Stored row payload. */
const rowSchema = z.object({ data: z.string() });

/** A secret as status shows it: everything but the value. */
export type SecretView = Omit<Sealed, 'iv' | 'tag' | 'ciphertext'>;
/** Secrets and their recent audit trail. */
export interface VaultStatus {
  /** Secrets by name. */
  readonly entries: readonly SecretView[];
  /** Newest audit entries first. */
  readonly audit: readonly z.output<typeof auditSchema>[];
}

/** The project's vault: its database and private key directory. */
export interface Vault {
  /** Project SQLite owner. */
  readonly store: Store;
  /** Project `.malt` directory. */
  readonly directory: string;
}

/**
 * Ensure the additive vault tables exist.
 *
 * @param store - Project SQLite owner.
 */
function ensureTables(store: Store): void {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS factory_vault (name TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS factory_vault_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL);
  `);
}

/**
 * Read the project key, creating it with owner-only permissions on first use.
 *
 * @param directory - Project `.malt` directory.
 * @returns The 256-bit key.
 * @throws {MeshError} When the key file is damaged.
 */
function projectKey(directory: string): Buffer {
  const folder = path.join(directory, 'factory');
  const file = path.join(folder, KEY_FILE);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- The key lives at a fixed name inside the selected project's private .malt directory.
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixed private key path, created exclusively so a concurrent creator never overwrites it.
    writeFileSync(file, randomBytes(KEY_BYTES), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (!hasErrorCode(error, 'EEXIST')) {
      throw error;
    }
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixed private key path inside the project's .malt directory.
  const key = readFileSync(file);
  if (key.length !== KEY_BYTES) {
    throw new MeshError(
      'FACTORY_GATED',
      `The secrets key ${file} is damaged. Restore it from a backup or delete every secret and the key file.`,
    );
  }
  return key;
}

/**
 * Associated data that binds a sealed value to its name.
 *
 * @param name - Secret name.
 * @returns Associated data bytes.
 */
function associated(name: string): Buffer {
  return Buffer.from(`${AAD_PREFIX}${name}`, 'utf8');
}

/**
 * Keyed fingerprint of a value, shown so the operator can tell rotations apart.
 *
 * @param key - Project key.
 * @param value - Secret value.
 * @returns Short hex fingerprint.
 */
function fingerprint(key: Buffer, value: string): string {
  return createHmac('sha256', key).update(`fingerprint:${value}`).digest('hex').slice(0, FINGERPRINT_HEX);
}

/**
 * Seal one value under the project key.
 *
 * @param key - Project key.
 * @param name - Secret name, bound as associated data.
 * @param value - Plaintext value.
 * @returns Nonce, tag and ciphertext, hex.
 */
function seal(key: Buffer, name: string, value: string): Pick<Sealed, 'iv' | 'tag' | 'ciphertext'> {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(associated(name));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    ciphertext: ciphertext.toString('hex'),
  };
}

/**
 * Open one sealed value.
 *
 * @param key - Project key.
 * @param sealed - Stored secret.
 * @returns Plaintext value.
 * @throws {MeshError} When the value was altered, moved or sealed under another key.
 */
function open(key: Buffer, sealed: Sealed): string {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'hex'));
    decipher.setAAD(associated(sealed.name));
    decipher.setAuthTag(Buffer.from(sealed.tag, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, 'hex')), decipher.final()]).toString('utf8');
  } catch {
    throw new MeshError(
      'FACTORY_GATED',
      `Secret ${sealed.name} failed its integrity check; it was altered or sealed under another key. Save it again.`,
    );
  }
}

/**
 * Every stored secret, by name.
 *
 * @param store - Project SQLite owner.
 * @returns Sealed secrets sorted by name.
 */
function sealedSecrets(store: Store): Sealed[] {
  ensureTables(store);
  return selectAll(store.db, rowSchema, 'SELECT data FROM factory_vault ORDER BY name')
    .map((row) => sealedSchema.parse(JSON.parse(row.data)))
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

/**
 * Append one audit entry and keep the trail bounded.
 *
 * @param store - Project SQLite owner.
 * @param entry - Action without any value.
 */
function audit(store: Store, entry: z.output<typeof auditSchema>): void {
  run(store.db, 'INSERT INTO factory_vault_audit(data) VALUES(?)', JSON.stringify(entry));
  run(
    store.db,
    'DELETE FROM factory_vault_audit WHERE id NOT IN (SELECT id FROM factory_vault_audit ORDER BY id DESC LIMIT ?)',
    AUDIT_KEPT,
  );
}

/**
 * The status view of a sealed secret.
 *
 * @param sealed - Stored secret.
 * @returns Metadata only.
 */
function view(sealed: Sealed): SecretView {
  return {
    name: sealed.name,
    version: sealed.version,
    fingerprint: sealed.fingerprint,
    grants: sealed.grants,
    createdAt: sealed.createdAt,
    updatedAt: sealed.updatedAt,
  };
}

/**
 * Create, rotate or re-grant a secret at the version the operator saw.
 *
 * @param vault - Project vault.
 * @param input - Validated save.
 * @param types - Role types the organization defines.
 * @returns The saved secret's metadata.
 * @throws {MeshError} For a stale version, a missing value, unknown role types or too many secrets.
 */
export function saveSecret(vault: Vault, input: SecretSave, types: readonly string[]): SecretView {
  const unknown = input.grants.filter((grant) => !types.includes(grant));
  if (unknown.length > 0) {
    throw new MeshError('INVALID_INPUT', `Unknown role type: ${unknown.join(', ')}.`);
  }
  const key = projectKey(vault.directory);
  return vault.store.transaction(() => {
    const secrets = sealedSecrets(vault.store);
    const existing = secrets.find((secret) => secret.name === input.name);
    if ((existing?.version ?? null) !== input.expectedVersion) {
      throw new MeshError('FACTORY_GATED', `Secret ${input.name} changed since you opened it; refresh before saving.`);
    }
    if (existing === undefined && input.value === undefined) {
      throw new MeshError('INVALID_INPUT', 'A new secret needs a value.');
    }
    if (existing === undefined && secrets.length >= MAX_SECRETS) {
      throw new MeshError('FACTORY_GATED', `A project can hold at most ${String(MAX_SECRETS)} secrets.`);
    }
    const now = vault.store.now();
    const { value } = input;
    const sealedValue =
      value === undefined ? {} : { ...seal(key, input.name, value), fingerprint: fingerprint(key, value) };
    const next = sealedSchema.parse({
      createdAt: now,
      ...existing,
      ...sealedValue,
      name: input.name,
      version: (existing?.version ?? 0) + 1,
      grants: input.grants,
      updatedAt: now,
    });
    run(
      vault.store.db,
      'INSERT INTO factory_vault(name,data) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET data=excluded.data',
      next.name,
      JSON.stringify(next),
    );
    audit(vault.store, { at: now, action: saveAction(existing, value), name: next.name, grants: next.grants });
    return view(next);
  });
}

/**
 * Name the change a save made, for the audit trail.
 *
 * @param existing - Secret before the save, if any.
 * @param value - New value, if one was supplied.
 * @returns Audit action.
 */
function saveAction(existing: Sealed | undefined, value: string | undefined): 'created' | 'rotated' | 'regranted' {
  if (existing === undefined) {
    return 'created';
  }
  return value === undefined ? 'regranted' : 'rotated';
}

/**
 * Delete a secret at the version the operator saw. Running attempts keep the value they started with.
 *
 * @param vault - Project vault.
 * @param input - Validated deletion.
 * @returns The deleted name.
 * @throws {MeshError} For a missing secret or a stale version.
 */
export function deleteSecret(vault: Vault, input: SecretDelete): { name: string } {
  return vault.store.transaction(() => {
    const existing = sealedSecrets(vault.store).find((secret) => secret.name === input.name);
    if (existing?.version !== input.expectedVersion) {
      throw new MeshError('FACTORY_GATED', `Secret ${input.name} changed or was already deleted; refresh.`);
    }
    run(vault.store.db, 'DELETE FROM factory_vault WHERE name = ?', input.name);
    audit(vault.store, { at: vault.store.now(), action: 'deleted', name: input.name, grants: existing.grants });
    return { name: input.name };
  });
}

/**
 * Secrets and audit trail for status; never a value.
 *
 * @param store - Project SQLite owner.
 * @returns Metadata and newest audit entries.
 */
export function vaultStatus(store: Store): VaultStatus {
  const entries = sealedSecrets(store).map((secret) => view(secret));
  const trail = selectAll(
    store.db,
    rowSchema,
    'SELECT data FROM factory_vault_audit ORDER BY id DESC LIMIT ?',
    AUDIT_SHOWN,
  );
  return { entries, audit: trail.map((row) => auditSchema.parse(JSON.parse(row.data))) };
}

/**
 * Names of the secrets granted to a role type.
 *
 * @param store - Project SQLite owner.
 * @param type - Organization type of the attempt's seat.
 * @returns Granted secret names, sorted.
 */
export function grantedSecrets(store: Store, type: string | undefined): string[] {
  return type === undefined
    ? []
    : sealedSecrets(store)
        .filter((secret) => secret.grants.includes(type))
        .map((secret) => secret.name);
}

/**
 * Open the named secrets for one provider launch. A secret deleted since the
 * attempt was admitted is skipped, and one whose grant was withdrawn is too.
 *
 * @param vault - Project vault.
 * @param names - Secret names frozen into the attempt.
 * @param type - Organization type of the attempt's seat.
 * @returns Environment variables to inject; empty when nothing is granted.
 */
export function grantedEnvironment(
  vault: Vault,
  names: readonly string[],
  type: string | undefined,
): Record<string, string> {
  if (type === undefined || names.length === 0) {
    return {};
  }
  const granted = sealedSecrets(vault.store).filter(
    (secret) => names.includes(secret.name) && secret.grants.includes(type),
  );
  if (granted.length === 0) {
    return {};
  }
  const key = projectKey(vault.directory);
  return Object.fromEntries(granted.map((secret) => [secret.name, open(key, secret)]));
}
