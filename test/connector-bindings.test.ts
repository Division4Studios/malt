/** @file Connector MCP bindings (#90): exact-hash human approval, invalidation on change, role scoping and no code fetch. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { z } from 'zod/v3';

import { startBroker } from '../src/broker.ts';
import { rpc } from '../src/client.ts';
import { approvedBindings, bindingHash, bindingSchema } from '../src/connector-bindings.ts';

import { brokerUrl, createCleanup, createProject, registration, updateConfig } from './helpers.ts';

import type { MeshConfig } from '../src/config.ts';
import type { TestContext } from 'node:test';

/** One binding as the status view reports it. */
const entrySchema = z.object({ binding: bindingSchema, hash: z.string(), state: z.string() }).passthrough();
/** The binding view. */
const viewSchema = z.object({ bindings: z.array(entrySchema) }).strict();

/** A binding to a server that does not exist, so starting it would fail loudly. */
const binding = {
  name: 'tracker',
  command: 'nonexistent-mcp-server',
  args: ['--stdio'],
  tools: ['search_issues', 'read_issue'],
  credential: { kind: 'env', name: 'TRACKER_HANDLE' },
  roles: ['developer-1'],
};

/**
 * Start a broker whose operator has enabled binding configuration.
 *
 * @param t - Owns the broker.
 * @returns The home configuration addressing the broker.
 */
async function brokerFixture(t: TestContext): Promise<MeshConfig> {
  const defer = createCleanup(t);
  const initial = createProject(defer, 'malt-bindings-');
  const broker = await startBroker(initial, { port: 0 });
  defer(async () => broker.close());
  const config = updateConfig(initial, { url: brokerUrl(broker.port) });
  await rpc(config, 'capability_policy_set', {
    capability: 'mcp-binding-configure',
    policy: { mode: 'human-only', roles: [] },
  });
  return config;
}

/**
 * Save a binding and return its view entry.
 *
 * @param config - Home configuration.
 * @param proposal - Binding to save.
 * @returns Its saved entry.
 */
async function propose(config: MeshConfig, proposal: unknown): Promise<z.output<typeof entrySchema>> {
  const view = viewSchema.parse(await rpc(config, 'mcp_binding_propose', { binding: proposal }));
  const found = view.bindings.find((entry) => entry.binding.name === 'tracker');
  assert.ok(found !== undefined);
  return found;
}

await test('a binding grants no tool until the operator approves its exact hash, and only to its roles, without fetching tool code', async (t) => {
  const config = await brokerFixture(t);
  const fetched: string[] = [];
  const brokerFetch = fetch;
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    const target = url instanceof Request ? url.url : String(url);
    if (target.startsWith(config.url)) {
      return brokerFetch(url, init);
    }
    fetched.push(target);
    throw new Error('No network access is expected.');
  });
  const saved = await propose(config, binding);
  assert.equal(saved.state, 'pending');
  assert.equal(saved.hash, bindingHash(bindingSchema.parse(binding)));
  assert.deepEqual(approvedBindings(config.directory, 'developer-1'), []);

  await assert.rejects(rpc(config, 'mcp_binding_approve', { name: 'tracker', hash: '0'.repeat(64) }), {
    code: 'INVALID_REVISION',
  });
  await assert.rejects(rpc(config, 'mcp_binding_approve', { name: 'other', hash: saved.hash }), { code: 'NOT_FOUND' });
  await rpc(config, 'mcp_binding_approve', { name: 'tracker', hash: saved.hash });
  assert.deepEqual(
    approvedBindings(config.directory, 'developer-1').map((entry) => entry.tools),
    [['search_issues', 'read_issue']],
  );
  assert.deepEqual(approvedBindings(config.directory, 'qa-1'), [], 'an unbound role gets nothing');
  assert.deepEqual(fetched, [], 'recording and approving never fetch or install tool code');
});

await test('any change to the tools, server or roles invalidates the approval', async (t) => {
  const config = await brokerFixture(t);
  const { hash } = await propose(config, binding);
  await rpc(config, 'mcp_binding_approve', { name: 'tracker', hash });
  const reordered = await propose(config, { ...binding, tools: ['read_issue', 'search_issues'] });
  assert.equal(reordered.state, 'approved', 'order alone is not a change');
  for (const changed of [
    { ...binding, tools: [...binding.tools, 'delete_issue'] },
    { ...binding, command: 'other-mcp-server' },
    { ...binding, roles: ['developer-1', 'qa-1'] },
  ]) {
    await propose(config, binding);
    await rpc(config, 'mcp_binding_approve', { name: 'tracker', hash });
    assert.equal((await propose(config, changed)).state, 'invalidated');
    assert.deepEqual(approvedBindings(config.directory, 'developer-1'), []);
  }
});

await test('agents may read bindings but never propose or approve one', async (t) => {
  const config = await brokerFixture(t);
  const { hash } = await propose(config, binding);
  const agent = registration('binding-lead');
  const row = z.object({ id: z.string() }).parse(await rpc(config, 'register', agent));
  const credentials = { agentId: row.id, secret: agent.secret, sessionId: agent.sessionId };
  await rpc(config, 'set_lead', { agent: agent.name });
  await assert.rejects(rpc(config, 'mcp_binding_approve', { name: 'tracker', hash }, { credentials }), {
    code: 'HUMAN_CONTROL_REQUIRED',
  });
  await assert.rejects(rpc(config, 'mcp_binding_propose', { binding }, { credentials }), {
    code: 'HUMAN_CONTROL_REQUIRED',
  });
  const seen = viewSchema.parse(await rpc(config, 'mcp_binding_status', {}, { credentials }));
  assert.deepEqual(
    seen.bindings.map((entry) => entry.state),
    ['pending'],
  );
});

await test('changes are refused while mcp-binding-configure is disabled, and malformed bindings are rejected', async (t) => {
  const config = await brokerFixture(t);
  await assert.rejects(rpc(config, 'mcp_binding_propose', { binding: { ...binding, name: 'agentmesh' } }), {
    code: 'INVALID_INPUT',
  });
  await assert.rejects(rpc(config, 'mcp_binding_propose', { binding: { ...binding, tools: ['a', 'a'] } }), {
    code: 'INVALID_INPUT',
  });
  await rpc(config, 'capability_policy_set', {
    capability: 'mcp-binding-configure',
    policy: { mode: 'disabled', roles: [] },
  });
  await assert.rejects(rpc(config, 'mcp_binding_propose', { binding }), { code: 'CAPABILITY_DENIED' });
  assert.deepEqual(viewSchema.parse(await rpc(config, 'mcp_binding_status', {})).bindings, []);
});
