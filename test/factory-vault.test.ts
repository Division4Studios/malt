/** @file Local encrypted secrets: write-only values, tamper detection, per-role injection and redaction. */
import assert from 'node:assert/strict';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { z } from 'zod/v3';

import { run, selectAll } from '../src/database.ts';
import { runProcess } from '../src/factory/processes.ts';
import { roleSchemas } from '../src/factory/role-schema.ts';
import { deleteSecret, grantedEnvironment, grantedSecrets, saveSecret, vaultStatus } from '../src/factory/vault.ts';
import { Store } from '../src/store.ts';

import { createCleanup, createProject } from './helpers.ts';

import type { Vault } from '../src/factory/vault.ts';
import type { TestContext } from 'node:test';

/** Role types the fixture organization defines. */
const TYPES = ['general', 'builder'];
/** A value long enough to be redacted. */
const VALUE = 'sk-fixture-0123456789abcdef';
/** A rotated value. */
const ROTATED = 'sk-rotated-fedcba9876543210';
/** Bounded deadline for the env fixture. */
const DEADLINE_MS = 30_000;
/** Stored row payload. */
const rowSchema = z.object({ name: z.string(), data: z.string() });

/**
 * Whether the broker accepts a new secret's name and value.
 *
 * @param name - Environment variable name.
 * @param value - Secret value.
 * @returns True when the save validates.
 */
function isAccepted(name: string, value = VALUE): boolean {
  return roleSchemas.factory_secret_save.safeParse({ name, value, grants: [], expectedVersion: null }).success;
}

/**
 * A project vault on a fresh store.
 *
 * @param t - Owns cleanup.
 * @returns Vault and its project directory.
 */
function vaultFor(t: TestContext): Vault {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  const store = new Store(mesh);
  defer(() => {
    store.close();
  });
  return { store, directory: mesh.directory };
}

/**
 * Parse a save the way the broker does.
 *
 * @param input - Wire input.
 * @returns Validated save.
 */
function save(input: Record<string, unknown>): ReturnType<typeof roleSchemas.factory_secret_save.parse> {
  return roleSchemas.factory_secret_save.parse(input);
}

await test('secret names avoid runtime, provider and Git variables, and short values are refused', () => {
  assert.ok(isAccepted('STRIPE_TEST_KEY'));
  for (const name of [
    'PATH',
    'NODE_OPTIONS',
    'GITHUB_TOKEN',
    'GH_TOKEN',
    'ANTHROPIC_API_KEY',
    'MALT_X',
    'lower_case',
  ]) {
    assert.equal(isAccepted(name), false, name);
  }
  assert.equal(isAccepted('SHORT_VALUE', 'abc'), false);
});

await test('values are sealed, write-only, versioned and fingerprinted', (t) => {
  const vault = vaultFor(t);
  const created = saveSecret(
    vault,
    save({ name: 'DOCS_TOKEN', value: VALUE, grants: ['builder'], expectedVersion: null }),
    TYPES,
  );
  assert.equal(created.version, 1);
  const status = JSON.stringify(vaultStatus(vault.store));
  assert.ok(!status.includes(VALUE), 'Status never carries the value.');
  const [row] = selectAll(vault.store.db, rowSchema, 'SELECT name, data FROM factory_vault');
  assert.ok(row !== undefined && !row.data.includes(VALUE), 'The database holds only ciphertext.');
  if (process.platform !== 'win32') {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Only this fixture's own key file is inspected.
    const { mode } = statSync(path.join(vault.directory, 'factory', 'vault.key'));
    assert.equal(mode.toString(8).slice(-3), '600');
  }
  assert.throws(
    () => saveSecret(vault, save({ name: 'DOCS_TOKEN', value: VALUE, grants: [], expectedVersion: null }), TYPES),
    /changed since you opened it/v,
  );
  assert.throws(
    () => saveSecret(vault, save({ name: 'NEW_TOKEN', grants: [], expectedVersion: null }), TYPES),
    /needs a value/v,
  );
  assert.throws(
    () => saveSecret(vault, save({ name: 'NEW_TOKEN', value: VALUE, grants: ['ghost'], expectedVersion: null }), TYPES),
    /Unknown role type: ghost/v,
  );
  const regranted = saveSecret(vault, save({ name: 'DOCS_TOKEN', grants: ['general'], expectedVersion: 1 }), TYPES);
  assert.equal(regranted.fingerprint, created.fingerprint, 'Re-granting keeps the value.');
  const rotated = saveSecret(
    vault,
    save({ name: 'DOCS_TOKEN', value: ROTATED, grants: ['builder'], expectedVersion: 2 }),
    TYPES,
  );
  assert.notEqual(rotated.fingerprint, created.fingerprint);
  assert.deepEqual(grantedEnvironment(vault, ['DOCS_TOKEN'], 'builder'), { DOCS_TOKEN: ROTATED });
  assert.deepEqual(
    vaultStatus(vault.store).audit.map((entry) => entry.action),
    ['rotated', 'regranted', 'created'],
  );
  assert.ok(!JSON.stringify(vaultStatus(vault.store).audit).includes(ROTATED));
  deleteSecret(vault, roleSchemas.factory_secret_delete.parse({ name: 'DOCS_TOKEN', expectedVersion: 3 }));
  assert.deepEqual(vaultStatus(vault.store).entries, []);
  assert.deepEqual(grantedEnvironment(vault, ['DOCS_TOKEN'], 'builder'), {}, 'A deleted secret is skipped at launch.');
});

await test('grants decide which role types receive a secret, at admission and again at launch', (t) => {
  const vault = vaultFor(t);
  saveSecret(vault, save({ name: 'DOCS_TOKEN', value: VALUE, grants: ['builder'], expectedVersion: null }), TYPES);
  saveSecret(vault, save({ name: 'OTHER_TOKEN', value: ROTATED, grants: ['general'], expectedVersion: null }), TYPES);
  assert.deepEqual(grantedSecrets(vault.store, 'builder'), ['DOCS_TOKEN']);
  assert.deepEqual(grantedSecrets(vault.store, undefined), []);
  assert.deepEqual(grantedEnvironment(vault, ['DOCS_TOKEN', 'OTHER_TOKEN'], 'builder'), { DOCS_TOKEN: VALUE });
  // A grant withdrawn after admission is honoured when the provider starts.
  saveSecret(vault, save({ name: 'DOCS_TOKEN', grants: [], expectedVersion: 1 }), TYPES);
  assert.deepEqual(grantedEnvironment(vault, ['DOCS_TOKEN'], 'builder'), {});
});

await test('an altered, moved or foreign-key ciphertext fails its integrity check', (t) => {
  const vault = vaultFor(t);
  saveSecret(vault, save({ name: 'DOCS_TOKEN', value: VALUE, grants: ['builder'], expectedVersion: null }), TYPES);
  const [row] = selectAll(vault.store.db, rowSchema, 'SELECT name, data FROM factory_vault');
  assert.ok(row !== undefined);
  const sealed = z.record(z.unknown()).parse(JSON.parse(row.data));
  const ciphertext = String(sealed['ciphertext']);
  const flipped = `${ciphertext.slice(0, -1)}${ciphertext.endsWith('0') ? '1' : '0'}`;
  run(
    vault.store.db,
    'UPDATE factory_vault SET data=? WHERE name=?',
    JSON.stringify({ ...sealed, ciphertext: flipped }),
    'DOCS_TOKEN',
  );
  assert.throws(() => grantedEnvironment(vault, ['DOCS_TOKEN'], 'builder'), /failed its integrity check/v);

  // The same sealed value copied under another name is refused too.
  run(
    vault.store.db,
    'INSERT INTO factory_vault(name,data) VALUES(?,?)',
    'MOVED_TOKEN',
    JSON.stringify({ ...sealed, name: 'MOVED_TOKEN' }),
  );
  assert.throws(() => grantedEnvironment(vault, ['MOVED_TOKEN'], 'builder'), /failed its integrity check/v);

  run(vault.store.db, 'UPDATE factory_vault SET data=? WHERE name=?', row.data, 'DOCS_TOKEN');
  assert.deepEqual(grantedEnvironment(vault, ['DOCS_TOKEN'], 'builder'), { DOCS_TOKEN: VALUE });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- The fixture replaces only its own project key.
  writeFileSync(
    path.join(vault.directory, 'factory', 'vault.key'),
    Uint8Array.from({ length: 32 }, () => 7),
  );
  assert.throws(() => grantedEnvironment(vault, ['DOCS_TOKEN'], 'builder'), /failed its integrity check/v);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- The fixture damages only its own project key.
  writeFileSync(path.join(vault.directory, 'factory', 'vault.key'), 'short');
  assert.throws(() => grantedEnvironment(vault, ['DOCS_TOKEN'], 'builder'), /is damaged/v);
});

await test('granted secrets reach the native process environment, never its descriptor or output', async (t) => {
  const vault = vaultFor(t);
  const script = path.join(vault.directory, 'print-env.mjs');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- The fixed fixture prints only its own environment variable.
  writeFileSync(
    script,
    'process.stdout.write("token=" + process.env.DOCS_TOKEN); process.stderr.write(process.env.DOCS_TOKEN ?? "");',
  );
  const artifact = path.join(vault.directory, 'factory', 'jobs', 'env-fixture');
  const controller = new AbortController();
  const result = await runProcess({
    file: process.execPath,
    args: [script],
    cwd: vault.directory,
    input: '',
    artifact,
    timeoutMs: DEADLINE_MS,
    memoryMb: 512,
    cpuPercent: 50,
    signal: controller.signal,
    secretEnv: { DOCS_TOKEN: VALUE },
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdout, 'token=[REDACTED]');
  assert.ok(!result.stderr.includes(VALUE));
  for (const file of ['launch.json', 'stdout.log', 'stderr.log']) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Only this fixture's own attempt artifacts are read.
    assert.ok(!readFileSync(path.join(artifact, file), 'utf8').includes(VALUE), file);
  }
});
