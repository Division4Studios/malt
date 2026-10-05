/**
 * Core messaging, identity, presence and transport tests.
 *
 * These scenarios exercise the store directly (durable inboxes, pagination,
 * identity fencing), the HTTP boundary (authentication, validation, origin
 * rejection), concurrency (competing registrations, many clients) and real
 * MCP bridge subprocesses across bridge and broker restarts.
 *
 * @file
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { z } from 'zod';

import { startBroker } from '../src/broker.ts';
import { AgentClient, rpc } from '../src/client.ts';
import { MeshError } from '../src/protocol.ts';
import { Store } from '../src/store.ts';

import { brokerUrl, createCleanup, createProject, registration, startBridge, updateConfig } from './helpers.ts';

import type { BridgeHandle } from './helpers.ts';

process.env['AGENTMESH_LOG_LEVEL'] = 'silent';

/** The first unread page of an inbox. */
const inbox = { unreadOnly: true, after: 0, limit: 50 } as const;

/** Just enough of an event to read its type. */
const eventTypeSchema = z.object({ type: z.string() });

/** Just enough of an event page to count event types. */
const eventTypesSchema = z.object({ events: z.array(eventTypeSchema) });

await test('durable inbox, independent acknowledgements, replies, broadcast and structured handoff', (t) => {
  const defer = createCleanup(t);
  const config = createProject(defer);
  let store = new Store(config);
  defer(() => {
    store.close();
  });
  const aliceInput = registration('claude-lead');
  const alice = store.register(aliceInput);
  const bob = store.register(registration('codex-1'));
  const carol = store.register(registration('claude-1'));
  const handoff = {
    task: 'schema',
    result: 'Interface ready',
    filesChanged: ['api.ts'],
    commits: ['abc123'],
    tests: ['passed'],
    knownIssues: [],
  };
  const sent = store.execute(
    'send_message',
    { to: bob.name, body: 'Schema ready', type: 'handoff', handoff },
    alice.id,
  );
  assert.equal(store.execute('get_messages', inbox, bob.id).messages.length, 1);
  // Reading must never implicitly acknowledge.
  assert.equal(store.execute('get_messages', inbox, bob.id).messages.length, 1);
  assert.throws(() => store.execute('ack_message', { id: sent.id }, carol.id), { code: 'NOT_FOUND' });
  store.execute('reply', { id: sent.id, body: 'Received' }, bob.id);
  assert.equal(store.execute('get_messages', inbox, alice.id).messages[0]?.reply_to, sent.id);
  const broadcast = store.execute('broadcast', { body: 'Shared convention' }, alice.id);
  assert.equal(broadcast.messages.length, 2);
  // Acknowledging twice is safe and records exactly one event.
  store.execute('ack_message', { id: sent.id }, bob.id);
  store.execute('ack_message', { id: sent.id }, bob.id);
  const reads = store
    .execute('events', { after: 0, limit: 100 }, null)
    .events.filter((event) => event.type === 'MESSAGE_READ');
  assert.equal(reads.length, 1);

  // Everything survives reopening the database.
  store.close();
  store = new Store(config);
  assert.equal(store.register(aliceInput).id, alice.id);
  assert.equal(store.execute('get_messages', inbox, bob.id).messages.length, 1);
  assert.equal(store.execute('get_messages', inbox, carol.id).messages.length, 1);
  const [first] = store.execute('get_messages', { ...inbox, unreadOnly: false }, bob.id).messages;
  assert.ok(first !== undefined);
  assert.deepEqual(first.handoff, handoff);
  assert.notEqual(first.acknowledged_at, null);

  // Secrets never leak through any read model.
  const serialized =
    JSON.stringify(store.execute('list_agents', {}, null)) +
    JSON.stringify(store.execute('events', { after: 0, limit: 100 }, null));
  assert.ok(!serialized.includes(aliceInput.secret));
  assert.ok(!serialized.includes('secret_hash'));
});

await test('presence expires, identity survives, duplicate sessions are fenced', (t) => {
  const defer = createCleanup(t);
  const config = createProject(defer);
  let clock = 100_000;
  const store = new Store(config, { now: () => clock });
  defer(() => {
    store.close();
  });
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
  // The old session is fenced out; the new one authenticates.
  assert.throws(() => store.authenticate({ agentId: agent.id, secret: input.secret, sessionId: input.sessionId }), {
    code: 'UNAUTHORIZED_AGENT',
  });
  assert.equal(store.authenticate({ agentId: agent.id, secret: input.secret, sessionId: resumed.sessionId }), agent.id);
});

await test('pagination is stable; no duplicates or missing messages at boundaries', (t) => {
  const defer = createCleanup(t);
  const store = new Store(createProject(defer));
  defer(() => {
    store.close();
  });
  const sender = store.register(registration('a'));
  const recipient = store.register(registration('b'));
  for (let index = 0; index < 7; index += 1) {
    store.execute('send_message', { to: recipient.id, body: `message-${String(index)}` }, sender.id);
  }
  let after = 0;
  const received: string[] = [];
  for (;;) {
    const page = store.execute('get_messages', { ...inbox, after, limit: 3 }, recipient.id);
    received.push(...page.messages.map((message) => message.body));
    after = page.nextCursor;
    if (!page.hasMore) {
      break;
    }
  }
  assert.deepEqual(
    received,
    Array.from({ length: 7 }, (_, index) => `message-${String(index)}`),
  );
});

await test('HTTP enforces project and agent credentials, input limits, origins and transactional failure', async (t) => {
  const defer = createCleanup(t);
  const initial = createProject(defer);
  const broker = await startBroker(initial, { port: 0 });
  defer(broker.close);
  const config = updateConfig(initial, { url: brokerUrl(broker.port) });

  await assert.rejects(rpc({ ...config, token: 'bad' }, 'team_status'), { code: 'UNAUTHORIZED' });
  await assert.rejects(rpc({ ...config, projectId: randomUUID() }, 'team_status'), { code: 'WRONG_PROJECT' });
  await assert.rejects(rpc(config, 'set_status', { status: 'WORKING' }), { code: 'UNAUTHORIZED_AGENT' });
  await assert.rejects(rpc(config, 'list_agents', { unexpected: true }), { code: 'INVALID_INPUT' });
  // @ts-expect-error -- Deliberately not an operation: proves the broker rejects inherited object keys at runtime.
  await assert.rejects(rpc(config, 'constructor'), { code: 'UNKNOWN_OPERATION' });

  const client = new AgentClient(config, { name: 'alice' });
  await client.connect();
  defer(async () => client.close());
  await assert.rejects(client.call('send_message', { to: 'missing', body: 'test' }), { code: 'NOT_FOUND' });
  // The failed send left no trace: its transaction rolled back.
  const events = eventTypesSchema.parse(await rpc(config, 'events'));
  assert.equal(events.events.filter((event) => event.type === 'MESSAGE_SENT').length, 0);
  await assert.rejects(client.call('send_message', { to: 'alice', body: 'x'.repeat(32_001) }), {
    code: 'INVALID_INPUT',
  });

  const browser = await fetch(`${config.url}/rpc`, {
    method: 'POST',
    headers: { origin: 'https://untrusted.example' },
    body: '{}',
  });
  assert.equal(browser.status, 403);
  assert.equal((await fetch(`${config.url}/health`)).status, 200);
});

await test('concurrent registrations allow one owner and 20 independent clients can exchange messages', async (t) => {
  const defer = createCleanup(t);
  const initial = createProject(defer);
  const broker = await startBroker(initial, { port: 0 });
  defer(broker.close);
  const config = updateConfig(initial, { url: brokerUrl(broker.port) });

  const competitors = Array.from({ length: 8 }, () => new AgentClient(config, { name: 'exclusive' }));
  const results = await Promise.allSettled(competitors.map(async (competitor) => competitor.connect()));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.ok(
    results
      .filter((result) => result.status === 'rejected')
      .every((result) => result.reason instanceof MeshError && result.reason.code === 'AGENT_ACTIVE'),
  );

  const clients = Array.from(
    { length: 20 },
    (_, index) => new AgentClient(config, { name: `worker-${String(index)}` }),
  );
  await Promise.all(clients.map(async (client) => client.connect()));
  defer(async () => Promise.all([...competitors, ...clients].map(async (client) => client.close())));
  await Promise.all(
    clients.map(async (client, index) =>
      client.call('send_message', { to: `worker-${String((index + 1) % 20)}`, body: `hello-${String(index)}` }),
    ),
  );
  const inboxes = await Promise.all(clients.map(async (client) => client.call('get_messages', {})));
  assert.ok(inboxes.every((page) => page.messages.length === 1));
});

await test('a database cannot be opened as another project', (t) => {
  const config = createProject(createCleanup(t));
  const store = new Store(config);
  store.close();
  assert.throws(() => new Store({ ...config, projectId: randomUUID() }), /different project/v);
});

await test(
  'independent stdio MCP processes discover, converse, restart and recover after broker restart',
  { timeout: 30_000 },
  async (t) => {
    const defer = createCleanup(t);
    const initial = createProject(defer);
    let broker = await startBroker(initial, { port: 0 });
    const { port } = broker;
    // Bridge subprocesses read the broker port and heartbeat from disk.
    const config = updateConfig(initial, { url: brokerUrl(port), heartbeatMs: 200 });
    const bridges: BridgeHandle[] = [];
    defer(async () => {
      for (const bridge of bridges) {
        await bridge.client.close();
      }
      await broker.close();
    });

    const alice = await startBridge(config, { name: 'claude-lead', provider: 'anthropic' });
    bridges.push(alice);
    let bob = await startBridge(config, { name: 'codex-1', provider: 'openai' });
    bridges.push(bob);

    const tools = (await alice.client.listTools()).tools.map((tool) => tool.name);
    assert.ok(tools.includes('mesh_ack_message'));
    const bobId = (await bob.call('mesh_whoami')).id;
    assert.equal((await alice.call('mesh_list_agents')).length, 2);
    const sent = await alice.call('mesh_send_message', { to: 'codex-1', body: 'Review the interface' });
    assert.equal((await bob.call('mesh_get_unread_messages')).messages[0]?.id, sent.id);
    await bob.call('mesh_reply', { id: sent.id, body: 'Looks good' });
    assert.equal((await alice.call('mesh_get_messages')).messages[0]?.body, 'Looks good');

    // SDK close waits for the child to exit, including its disconnect request.
    await bob.client.close();
    bob = await startBridge(config, { name: 'codex-1', provider: 'openai' });
    bridges.push(bob);
    assert.equal((await bob.call('mesh_whoami')).id, bobId);
    assert.equal((await bob.call('mesh_get_messages')).messages[0]?.id, sent.id);

    // A broker restart preserves everything; the bridge simply carries on.
    await broker.close();
    // eslint-disable-next-line require-atomic-updates -- Sequential restart: nothing else reads `broker` between closing it and assigning its replacement.
    broker = await startBroker(config, { port });
    assert.equal((await bob.call('mesh_get_messages')).messages[0]?.id, sent.id);
    await bob.call('mesh_ack_message', { id: sent.id });
    assert.equal((await bob.call('mesh_get_messages')).messages.length, 0);
  },
);
