/** @file Project tokens cannot acquire native terminal authority, even without agent credentials. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { startBroker } from '../src/broker.ts';
import { startNativeConsole } from '../src/web/native.ts';
import { startWebConsole } from '../src/web/server.ts';

import { brokerUrl, createCleanup, createProject } from './helpers.ts';

import type { WebConsole } from '../src/web/server.ts';

/**
 * Pair a real local browser session, never disclosing its cookie to the broker.
 *
 * @param ui - Exact test-owned operator boundary.
 * @returns Paired same-origin request headers.
 */
async function pair(ui: WebConsole): Promise<Record<string, string>> {
  const response = await fetch(`${ui.url}/api/pair`, {
    method: 'POST',
    headers: { Origin: ui.url, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: ui.pairingCode }),
  });
  assert.equal(response.status, 200);
  const cookie = (response.headers.get('set-cookie') ?? '').split(';', 1)[0] ?? '';
  assert.notEqual(cookie, '');
  return { Origin: ui.url, Cookie: cookie, 'Content-Type': 'application/json' };
}

await test('a separately paired UI with a project token has no native terminal capability', async (t) => {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  const broker = await startBroker(mesh, { port: 0 });
  defer(async () => broker.close());
  const selected = { ...mesh, url: brokerUrl(broker.port) };
  const ui = await startWebConsole(selected, 0);
  defer(async () => ui.close());
  const headers = await pair(ui);
  const response = await fetch(`${ui.url}/api/terminals`, { headers });
  assert.equal(response.status, 403);
  assert.match(await response.text(), /ui --with-broker/v);
  await assert.rejects(broker.operatorTerminalControl({ ...selected, projectId: 'foreign' }, 'terminal_list', {}), {
    code: 'NOT_FOUND',
  });
});

await test('native combined startup grants only its paired console a memory-only terminal capability', async (t) => {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  const ui = await startNativeConsole({ ...mesh, url: brokerUrl(0) }, 0, true);
  defer(async () => ui.close());
  const headers = await pair(ui);
  const response = await fetch(`${ui.url}/api/terminals`, { headers });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), []);
  const start = await fetch(`${ui.url}/api/control`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ operation: 'terminal_start', input: { provider: 'codex', columns: 80, rows: 24 } }),
  });
  assert.equal(start.status, 409, 'Unconfigured delivery policy still gates an authenticated operator.');
  await Promise.all([ui.close(), ui.close()]);
});
