import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { startBroker } from '../src/broker.js';
import { AgentClient, rpc } from '../src/client.js';

process.env.AGENTMESH_LOG_LEVEL = 'silent';

const cleanups = new WeakMap();
const defer = (t, callback) => cleanups.get(t).push(callback);
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'agentmesh-test-'));
  cleanups.set(t, [() => rmSync(root, { recursive: true, force: true })]);
  t.after(async () => {
    const failures = [];
    for (const callback of cleanups.get(t).toReversed()) {
      try { await callback(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Test cleanup failed');
  });
  return loadConfig(root, { create: true });
}
const registration = name => ({ name, secret: randomUUID(), sessionId: randomUUID(), provider: 'test', runtime: 'test', role: 'generalist' });
const inbox = { unreadOnly: true, after: 0, limit: 50 };

test('durable inbox, independent acknowledgements, replies, broadcast and structured handoff', t => {
  const config = fixture(t);
  let store = new Store(config);
  defer(t, () => store.close());
  const aliceInput = registration('claude-lead');
  const alice = store.register(aliceInput);
  const bob = store.register(registration('codex-1'));
  const carol = store.register(registration('claude-1'));
  const handoff = { task: 'schema', result: 'Interface ready', filesChanged: ['api.ts'], commits: ['abc123'], tests: ['passed'], knownIssues: [] };
  const sent = store.execute('send_message', { to: bob.name, body: 'Schema ready', type: 'handoff', handoff }, alice.id);
  assert.equal(store.execute('get_messages', inbox, bob.id).messages.length, 1);
  // Reading must never implicitly acknowledge.
  assert.equal(store.execute('get_messages', inbox, bob.id).messages.length, 1);
  assert.throws(() => store.execute('ack_message', { id: sent.id }, carol.id), { code: 'NOT_FOUND' });
  store.execute('reply', { id: sent.id, body: 'Received' }, bob.id);
  assert.equal(store.execute('get_messages', inbox, alice.id).messages[0].reply_to, sent.id);
  const broadcast = store.execute('broadcast', { body: 'Shared convention' }, alice.id);
  assert.equal(broadcast.messages.length, 2);
  store.execute('ack_message', { id: sent.id }, bob.id);
  store.execute('ack_message', { id: sent.id }, bob.id);
  assert.equal(store.execute('events', { after: 0, limit: 100 }, null).events.filter(e => e.type === 'MESSAGE_READ').length, 1);
  store.close();
  store = new Store(config);
  assert.equal(store.register(aliceInput).id, alice.id);
  assert.equal(store.execute('get_messages', inbox, bob.id).messages.length, 1);
  assert.equal(store.execute('get_messages', inbox, carol.id).messages.length, 1);
  const history = store.execute('get_messages', { ...inbox, unreadOnly: false }, bob.id);
  assert.deepEqual(history.messages[0].handoff, handoff);
  assert.notEqual(history.messages[0].acknowledged_at, null);
  const serialized = JSON.stringify(store.execute('list_agents', {}, null)) + JSON.stringify(store.execute('events', { after: 0, limit: 100 }, null));
  assert.ok(!serialized.includes(aliceInput.secret));
  assert.ok(!serialized.includes('secret_hash'));
});

test('presence expires, identity survives, duplicate sessions are fenced', t => {
  const config = fixture(t);
  let clock = 100000;
  const store = new Store(config, { now: () => clock });
  defer(t, () => store.close());
  const input = registration('worker');
  const agent = store.register(input);
  assert.throws(() => store.register({ ...input, sessionId: randomUUID() }), { code: 'AGENT_ACTIVE' });
  assert.throws(() => store.register({ ...input, secret: randomUUID() }), { code: 'IDENTITY_CONFLICT' });
  clock += config.offlineMs;
  assert.equal(store.expire(), 1);
  assert.equal(store.agent(agent.id).status, 'OFFLINE');
  const resumed = { ...input, sessionId: randomUUID() };
  assert.equal(store.register(resumed).id, agent.id);
  assert.equal(store.agent(agent.id).status, 'WAITING');
  assert.throws(() => store.authenticate({ agentId: agent.id, secret: input.secret, sessionId: input.sessionId }), { code: 'UNAUTHORIZED_AGENT' });
  assert.equal(store.authenticate({ agentId: agent.id, secret: input.secret, sessionId: resumed.sessionId }), agent.id);
});

test('pagination is stable; no duplicates or missing messages at boundaries', t => {
  const store = new Store(fixture(t));
  defer(t, () => store.close());
  const a = store.register(registration('a'));
  const b = store.register(registration('b'));
  for (let index = 0; index < 7; index++) store.execute('send_message', { to: b.id, body: `message-${index}` }, a.id);
  let after = 0;
  const received = [];
  for (;;) {
    const page = store.execute('get_messages', { ...inbox, after, limit: 3 }, b.id);
    received.push(...page.messages.map(m => m.body));
    after = page.nextCursor;
    if (!page.hasMore) break;
  }
  assert.deepEqual(received, Array.from({ length: 7 }, (_, i) => `message-${i}`));
});

test('HTTP enforces project and agent credentials, input limits, origins and transactional failure', async t => {
  const config = fixture(t);
  const broker = await startBroker(config, { port: 0 });
  defer(t, () => broker.close());
  config.url = `http://127.0.0.1:${broker.port}`;
  await assert.rejects(rpc({ ...config, token: 'bad' }, 'team_status'), { code: 'UNAUTHORIZED' });
  await assert.rejects(rpc({ ...config, projectId: randomUUID() }, 'team_status'), { code: 'WRONG_PROJECT' });
  await assert.rejects(rpc(config, 'set_status', { status: 'WORKING' }), { code: 'UNAUTHORIZED_AGENT' });
  await assert.rejects(rpc(config, 'list_agents', { unexpected: true }), { code: 'INVALID_INPUT' });
  await assert.rejects(rpc(config, 'constructor'), { code: 'UNKNOWN_OPERATION' });
  const client = new AgentClient(config, { name: 'alice' });
  await client.connect();
  defer(t, () => client.close());
  await assert.rejects(client.call('send_message', { to: 'missing', body: 'test' }), { code: 'NOT_FOUND' });
  assert.equal((await rpc(config, 'events')).events.filter(e => e.type === 'MESSAGE_SENT').length, 0);
  await assert.rejects(client.call('send_message', { to: 'alice', body: 'x'.repeat(32001) }), { code: 'INVALID_INPUT' });
  const response = await fetch(`${config.url}/rpc`, { method: 'POST', headers: { origin: 'https://untrusted.example' }, body: '{}' });
  assert.equal(response.status, 403);
  assert.equal((await fetch(`${config.url}/health`)).status, 200);
});

test('concurrent registrations allow one owner and 20 independent clients can exchange messages', async t => {
  const config = fixture(t);
  const broker = await startBroker(config, { port: 0 });
  defer(t, () => broker.close());
  config.url = `http://127.0.0.1:${broker.port}`;
  const competitors = Array.from({ length: 8 }, () => new AgentClient(config, { name: 'exclusive' }));
  const results = await Promise.allSettled(competitors.map(c => c.connect()));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.ok(results.filter(r => r.status === 'rejected').every(r => r.reason.code === 'AGENT_ACTIVE'));
  const clients = Array.from({ length: 20 }, (_, i) => new AgentClient(config, { name: `worker-${i}` }));
  await Promise.all(clients.map(c => c.connect()));
  defer(t, () => Promise.all([...competitors, ...clients].map(c => c.close())));
  await Promise.all(clients.map((c, i) => c.call('send_message', { to: `worker-${(i + 1) % 20}`, body: `hello-${i}` })));
  const inboxes = await Promise.all(clients.map(c => c.call('get_messages')));
  assert.ok(inboxes.every(i => i.messages.length === 1));
});

test('a database cannot be opened as another project', t => {
  const config = fixture(t);
  const store = new Store(config);
  store.close();
  assert.throws(() => new Store({ ...config, projectId: randomUUID() }), /different project/);
});

test('independent stdio MCP processes discover, converse, restart and recover after broker restart', { timeout: 30000 }, async t => {
  const config = fixture(t);
  let broker = await startBroker(config, { port: 0 });
  const port = broker.port;
  config.url = `http://127.0.0.1:${port}`;
  config.heartbeatMs = 200;
  // Save only the public config fields used by child processes (token remains local).
  writeFileSync(join(config.directory, 'config.json'), JSON.stringify(config));
  const opened = [];
  defer(t, async () => { for (const client of opened) await client.close(); await broker.close(); });
  const connect = async (name, provider) => {
    const client = new Client({ name: 'mesh-test-host', version: '1.0' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('src/cli.js'), 'mcp', '--project', config.root, '--name', name, '--provider', provider], stderr: 'pipe' });
    let errors = '';
    transport.stderr.on('data', chunk => { errors += chunk; });
    await client.connect(transport);
    opened.push(client);
    const call = async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args });
      assert.ok(!result.isError, JSON.stringify(result) + errors);
      return JSON.parse(result.content[0].text);
    };
    return { client, call };
  };
  const alice = await connect('claude-lead', 'anthropic');
  let bob = await connect('codex-1', 'openai');
  const tools = (await alice.client.listTools()).tools.map(tool => tool.name);
  assert.ok(tools.includes('mesh_ack_message'));
  const bobId = (await bob.call('mesh_whoami')).id;
  assert.equal((await alice.call('mesh_list_agents')).length, 2);
  const sent = await alice.call('mesh_send_message', { to: 'codex-1', body: 'Review the interface' });
  assert.equal((await bob.call('mesh_get_unread_messages')).messages[0].id, sent.id);
  await bob.call('mesh_reply', { id: sent.id, body: 'Looks good' });
  assert.equal((await alice.call('mesh_get_messages')).messages[0].body, 'Looks good');
  await bob.client.close();
  // SDK close waits for the child to exit, including its disconnect request.
  bob = await connect('codex-1', 'openai');
  assert.equal((await bob.call('mesh_whoami')).id, bobId);
  assert.equal((await bob.call('mesh_get_messages')).messages[0].id, sent.id);
  await broker.close();
  broker = await startBroker(config, { port });
  assert.equal((await bob.call('mesh_get_messages')).messages[0].id, sent.id);
  await bob.call('mesh_ack_message', { id: sent.id });
  assert.equal((await bob.call('mesh_get_messages')).messages.length, 0);
});
