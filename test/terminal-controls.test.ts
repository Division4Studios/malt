/** @file Actual loopback operator boundaries reject agent and cross-project terminal control. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { startBroker } from '../src/broker.ts';
import { AgentClient, rpc } from '../src/client.ts';
import { FactoryRepository } from '../src/factory/repository.ts';
import { factoryConfigSchema } from '../src/factory/schema.ts';
import { TERMINAL_OPERATIONS } from '../src/factory/terminal-schema.ts';
import { TOOL_OPERATIONS } from '../src/protocol.ts';
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
  const operator = await startWebConsole(mesh, 0);
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
  const lead = new AgentClient(mesh, { name: 'terminal-lead', role: 'lead' });
  await lead.connect();
  defer(async () => lead.close());
  for (const operation of TERMINAL_OPERATIONS) {
    assert.ok(TOOL_OPERATIONS.every((tool: string) => tool !== operation));
    const closeInput = operation === 'terminal_close' ? { id: randomUUID() } : {};
    const input = operation === 'terminal_start' ? request : closeInput;
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
  await assert.rejects(rpc(mesh, 'terminal_start', { ...request, file: 'powershell' }), { code: 'INVALID_INPUT' });
  await assert.rejects(rpc(mesh, 'terminal_close', { id: randomUUID() }), { code: 'NOT_FOUND' });
  assert.deepEqual(repository.terminals.list(), []);
});
