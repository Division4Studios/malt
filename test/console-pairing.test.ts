/** @file Persisted console pairing code: reuse across restarts, explicit rotation, live pickup and one log record. */
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { ensurePairingCode, pairingFile, readPairingCode, rotatePairingCode } from '../src/web/pairing.ts';
import { startWebConsole } from '../src/web/server.ts';

import { createCleanup, createProject, CLI_PATH } from './helpers.ts';

/** Owner-only permission bits. */
const OWNER_ONLY = 0o600;
/** Permission bits of a file mode. */
const PERMISSION_BITS = 0o777;

/**
 * Attempt to pair a browser with a code.
 *
 * @param url - Console origin.
 * @param code - Presented code.
 * @returns HTTP status and the session cookie, if any.
 */
async function pair(url: string, code: string): Promise<{ status: number; cookie: string }> {
  const response = await fetch(`${url}/api/pair`, {
    method: 'POST',
    headers: { Origin: url, 'Content-Type': 'application/json', Connection: 'close' },
    body: JSON.stringify({ code }),
  });
  return { status: response.status, cookie: (response.headers.get('set-cookie') ?? '').split(';', 1)[0] ?? '' };
}

await test('the code is created once, reused, replaced only by rotation, and owner-only', (t) => {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  const first = ensurePairingCode(mesh.directory);
  assert.match(first, /^[\da-f]{16}$/v);
  assert.equal(ensurePairingCode(mesh.directory), first);
  assert.equal(readPairingCode(mesh.directory), first);
  if (process.platform !== 'win32') {
    // eslint-disable-next-line no-bitwise, security/detect-non-literal-fs-filename -- Permission bits of the test project's own private file.
    assert.equal(statSync(pairingFile(mesh.directory)).mode & PERMISSION_BITS, OWNER_ONLY);
  }
  const rotated = rotatePairingCode(mesh.directory);
  assert.notEqual(rotated, first);
  assert.equal(ensurePairingCode(mesh.directory), rotated);
});

await test('an invalid pairing file fails clearly and is never silently replaced', (t) => {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- The test project's own private file.
  writeFileSync(pairingFile(mesh.directory), '{"version":1,"code":"short"}\n');
  assert.throws(() => ensurePairingCode(mesh.directory), /invalid\. Run pairing-code --rotate/v);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- The test project's own private file.
  assert.equal(readFileSync(pairingFile(mesh.directory), 'utf8'), '{"version":1,"code":"short"}\n');
  assert.throws(
    () => readPairingCode(mesh.directory),
    (error: unknown) => Error.isError(error) && !error.message.includes('short'),
  );
});

await test('a restarted console keeps its code and a running one accepts only the rotated code', async (t) => {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  const before = await startWebConsole(mesh, 0);
  const { pairingCode } = before;
  await before.close();
  const web = await startWebConsole(mesh, 0);
  defer(async () => web.close());
  assert.equal(web.pairingCode, pairingCode, 'A restart keeps the code the operator last saw.');

  const paired = await pair(web.url, pairingCode);
  assert.equal(paired.status, 200);
  const rotated = rotatePairingCode(mesh.directory);
  assert.equal((await pair(web.url, pairingCode)).status, 403, 'The old code stops working without a restart.');
  assert.equal((await pair(web.url, rotated)).status, 200);
  const snapshot = await fetch(`${web.url}/api/projects`, {
    headers: { Origin: web.url, Cookie: paired.cookie, Connection: 'close' },
  });
  // No broker runs here, so the read itself may fail; what matters is that the session is still accepted.
  assert.notEqual(snapshot.status, 401, 'A browser paired before rotation keeps its session.');
  assert.ok(!(await snapshot.text()).includes(rotated), 'The code never appears in an API response.');
});

await test('pairing-code shows the persisted code and --rotate re-issues it', async (t) => {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  const run = async (...extra: string[]): Promise<{ pairingCode: string; rotated: boolean }> => {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [CLI_PATH, 'pairing-code', '--project', mesh.root, ...extra],
      { timeout: 10_000 },
    );
    const parsed: unknown = JSON.parse(stdout);
    assert.ok(typeof parsed === 'object' && parsed !== null && 'pairingCode' in parsed && 'rotated' in parsed);
    return { pairingCode: String(parsed.pairingCode), rotated: parsed.rotated === true };
  };
  const shown = await run();
  assert.equal(shown.rotated, false);
  assert.equal(shown.pairingCode, readPairingCode(mesh.directory));
  const reissued = await run('--rotate');
  assert.equal(reissued.rotated, true);
  assert.notEqual(reissued.pairingCode, shown.pairingCode);
  assert.equal(readPairingCode(mesh.directory), reissued.pairingCode);
});

await test('ui startup prints the code and writes exactly one log record containing it', async (t) => {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  const child = spawn(process.execPath, [CLI_PATH, 'ui', '--project', mesh.root, '--port', '0'], {
    env: { ...process.env, AGENTMESH_LOG_LEVEL: 'info' },
    windowsHide: true,
  });
  defer(() => child.kill());
  let stdout = '';
  let stderr = '';
  const started = new Promise<void>((resolve) => {
    const settle = (): void => {
      if (stdout.includes('pairingCode') && stderr.includes('pairing_code')) {
        resolve();
      }
    };
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
      settle();
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
      settle();
    });
  });
  await Promise.race([started, once(child, 'exit')]);
  const code = readPairingCode(mesh.directory);
  assert.ok(stdout.includes(code), 'The terminal shows the code.');
  const records = stderr.split('\n').filter((line) => line.includes(code));
  assert.equal(records.length, 1, 'Exactly one log line contains the code.');
  assert.match(records[0] ?? '', /"event":"pairing_code"/v);
  child.kill();
  await once(child, 'exit');
});
