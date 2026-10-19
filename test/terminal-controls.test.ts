/** @file Actual loopback operator boundaries reject agent and cross-project terminal control. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { startBroker } from '../src/broker.ts';
import { AgentClient, rpc } from '../src/client.ts';
import { FactoryRepository } from '../src/factory/repository.ts';
import { factoryConfigSchema } from '../src/factory/schema.ts';
import { TERMINAL_OPERATIONS } from '../src/factory/terminal-schema.ts';
import { MeshError, TOOL_OPERATIONS } from '../src/protocol.ts';
import { startWebConsole } from '../src/web/server.ts';

import { brokerUrl, createCleanup, createProject } from './helpers.ts';

await test('terminal controls are operator-only, project-fenced and absent from MCP', async (t) => {
  const defer = createCleanup(t);
  const config = createProject(defer);
  const broker = await startBroker(config, { port: 0 });
  defer(async () => broker.close());
  const mesh = { ...config, url: brokerUrl(broker.port) };
  const repository = new FactoryRepository(broker.store);
  repository.configure(
    factoryConfigSchema.parse({
      terminals: { max: 0 },
      testCommands: [{ file: 'node' }],
      endToEndCommands: [{ file: 'node' }],
    }),
  );
  const operator = await startWebConsole(mesh, 0, undefined, broker.operatorTerminalControl);
  defer(async () => operator.close());
  const pair = await fetch(`${operator.url}/api/pair`, {
    method: 'POST',
    headers: { Origin: operator.url, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: operator.pairingCode }),
  });
  assert.equal(pair.status, 200);
  const headers = {
    Origin: operator.url,
    Cookie: (pair.headers.get('set-cookie') ?? '').split(';', 1)[0] ?? '',
    'Content-Type': 'application/json',
  };
  const request = { provider: 'codex', columns: 80, rows: 24 };
  const inputs = {
    terminal_start: request,
    terminal_close: { id: randomUUID() },
    terminal_list: {},
    terminal_read: { id: randomUUID() },
    terminal_input: { id: randomUUID(), text: 'not sent' },
    terminal_resize: { id: randomUUID(), columns: 80, rows: 24 },
  };
  const lead = new AgentClient(mesh, { name: 'terminal-lead', role: 'lead' });
  await lead.connect();
  defer(async () => lead.close());
  for (const operation of TERMINAL_OPERATIONS) {
    assert.ok(TOOL_OPERATIONS.every((tool: string) => tool !== operation));
    const input = inputs[operation];
    const response = await fetch(new URL('/rpc', mesh.url), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${mesh.token}`,
        'x-agentmesh-project': mesh.projectId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ operation, input, credentials: { role: 'lead' } }),
    });
    assert.equal(response.status, 403);
    assert.match(await response.text(), /HUMAN_CONTROL_REQUIRED/v);
    await assert.rejects(rpc(mesh, operation, input), { code: 'HUMAN_CONTROL_REQUIRED' });
  }
  const list = await fetch(`${operator.url}/api/terminals?project=home`, { headers });
  assert.equal(list.status, 200);
  assert.deepEqual(await list.json(), []);
  const unpaired = await fetch(`${operator.url}/api/terminals`, { headers: { Origin: operator.url } });
  assert.equal(unpaired.status, 401);
  const foreign = await fetch(`${operator.url}/api/terminals?project=unknown`, { headers });
  assert.equal(foreign.status, 403);
  const start = await fetch(`${operator.url}/api/control`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ operation: 'terminal_start', input: request }),
  });
  assert.equal(start.status, 409, 'Disabled policy must refuse before invoking a CLI.');
  await assert.rejects(broker.operatorTerminalControl(mesh, 'terminal_start', { ...request, file: 'powershell' }), {
    code: 'INVALID_INPUT',
  });
  await assert.rejects(broker.operatorTerminalControl(mesh, 'terminal_close', { id: randomUUID() }), {
    code: 'NOT_FOUND',
  });
  assert.deepEqual(repository.terminals.list(), []);
  const id = randomUUID();
  repository.terminals.create({
    id,
    provider: 'codex',
    worktree: mesh.root,
    branch: 'malt/terminal/metadata',
    base: 'a'.repeat(40),
    baseBranch: 'main',
    columns: 80,
    rows: 24,
  });
  repository.terminals.change(id, 'requested', 'failed', { reason: 'broker restarted' });
  const streamUrl = `${operator.url}/api/terminal-stream?project=home&id=${id}`;
  const stream = await fetch(streamUrl, { headers });
  assert.equal(stream.status, 200);
  assert.equal(stream.headers.get('cache-control'), 'no-store');
  const content = await stream.text();
  assert.match(content, /event: terminal/v);
  assert.match(content, /"unavailable":true/v);
  assert.match(content, /: heartbeat/v);
  assert.ok(!content.includes(mesh.token));
  assert.equal((await fetch(streamUrl, { headers: { ...headers, Origin: 'https://hostile.invalid' } })).status, 403);
  assert.equal((await fetch(`${streamUrl}&after=1&after=2`, { headers })).status, 400);
  assert.equal((await fetch(streamUrl, { headers: { ...headers, 'Last-Event-ID': '-1' } })).status, 400);
  await assert.rejects(broker.operatorTerminalControl(mesh, 'terminal_read', { id, waitMs: 25_001 }), {
    code: 'INVALID_INPUT',
  });
});

await test('terminals refuse to touch worktrees another environment owns', async (t) => {
  const defer = createCleanup(t);
  const config = createProject(defer);
  const broker = await startBroker(config, { port: 0 });
  defer(async () => broker.close());
  const mesh = { ...config, url: brokerUrl(broker.port) };
  const repository = new FactoryRepository(broker.store);
  repository.configure(
    factoryConfigSchema.parse({ testCommands: [{ file: 'node' }], endToEndCommands: [{ file: 'node' }] }),
  );
  const owner = path.join(mesh.directory, 'worktrees', 'owner.json');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- The fixture's own temporary project.
  mkdirSync(path.dirname(owner), { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- The fixture's own temporary project.
  writeFileSync(
    owner,
    JSON.stringify({ root: '/data', platform: 'linux', isContainer: true, recordedAt: 1, handovers: [] }),
  );
  const request = { provider: 'codex', columns: 80, rows: 24 };
  await assert.rejects(
    broker.operatorTerminalControl(mesh, 'terminal_start', request),
    (error: unknown) =>
      error instanceof MeshError && error.code === 'FACTORY_GATED' && error.message.includes('belongs to'),
  );
});
