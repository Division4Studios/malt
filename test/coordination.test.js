import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadConfig } from '../src/config.js';
import { AgentClient, rpc } from '../src/client.js';
import { startBroker } from '../src/broker.js';

process.env.AGENTMESH_LOG_LEVEL = 'silent';

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'agentmesh-coordination-'));
  const config = loadConfig(root, { create: true });
  const f = { config, clients: [], broker: await startBroker(config, { port: 0 }) };
  config.url = `http://127.0.0.1:${f.broker.port}`;
  f.connect = async (name, role = 'generalist') => {
    const client = new AgentClient(config, { name, role });
    await client.connect();
    f.clients.push(client);
    return client;
  };
  t.after(async () => {
    await Promise.all(f.clients.map(c => c.close()));
    await f.broker.close();
    rmSync(root, { recursive: true, force: true });
  });
  return f;
}

async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for test condition');
    await delay(5);
  }
}

test('workers automatically check in; timeouts never grant idle; only the selected lead can decide', async t => {
  const f = await fixture(t);
  const lead = await f.connect('lead', 'lead');
  const worker = await f.connect('worker');
  const peer = await f.connect('peer');
  const state = await worker.call('work_status');
  assert.equal(state.phase, 'AWAITING_LEAD');
  assert.equal((await worker.call('whoami')).status, 'WAITING');
  await assert.rejects(worker.call('set_status', { status: 'IDLE' }), { code: 'IDLE_NOT_APPROVED' });
  const timeout = await worker.call('wait_for_work', { timeoutMs: 30 });
  assert.equal(timeout.reason, 'TIMEOUT');
  assert.equal(timeout.state.phase, 'AWAITING_LEAD');
  await assert.rejects(peer.call('answer_check_in', { requestId: state.request_id, decision: 'idle' }), { code: 'NOT_ORCHESTRATOR' });
  await assert.rejects(worker.call('set_lead', { agent: 'worker' }), { code: 'HUMAN_CONTROL_REQUIRED' });
  const pending = worker.call('wait_for_work', { timeoutMs: 2000, afterRevision: state.revision });
  await until(() => f.broker.waiters.pending.size === 1);
  await lead.call('answer_check_in', { requestId: state.request_id, decision: 'idle', reason: 'No work remaining right now.' });
  const decision = await pending;
  assert.equal(decision.reason, 'IDLE_APPROVED');
  assert.equal((await worker.call('whoami')).status, 'IDLE');
  // A duplicate/delayed decision cannot change a completed request.
  await assert.rejects(lead.call('answer_check_in', { requestId: state.request_id, decision: 'work', instructions: 'Late assignment' }), { code: 'STALE_CHECKIN' });
});

test('message delivery revokes idle, wakes the waiter, and requires a fresh check-in', async t => {
  const f = await fixture(t);
  const lead = await f.connect('lead', 'lead');
  const worker = await f.connect('worker');
  const request = await worker.call('work_status');
  const idle = await lead.call('answer_check_in', { requestId: request.request_id, decision: 'idle' });
  const waiting = worker.call('wait_for_work', { timeoutMs: 2000, afterRevision: idle.revision });
  await until(() => f.broker.waiters.pending.size === 1);
  const sent = await lead.call('send_message', { to: 'worker', body: 'Please inspect the latest interface.' });
  const wake = await waiting;
  assert.equal(wake.reason, 'MESSAGES');
  assert.equal(wake.state.phase, 'CHECKIN_REQUIRED');
  assert.equal(wake.messages[0].id, sent.id);
  await assert.rejects(worker.call('check_in', { summary: 'Available' }), { code: 'UNREAD_MESSAGES' });
  await worker.call('ack_message', { id: sent.id });
  const next = await worker.call('check_in', { summary: 'Message handled; available for work.' });
  assert.notEqual(next.request_id, request.request_id);
  const duplicate = await worker.call('check_in', { summary: 'Retry' });
  assert.equal(duplicate.request_id, next.request_id);
  assert.equal((await lead.call('list_check_ins')).length, 1);
  const assignment = await lead.call('answer_check_in', { requestId: next.request_id, decision: 'work', instructions: 'Implement the decoder and run its tests.' });
  assert.equal(assignment.phase, 'WORK_ASSIGNED');
  const work = await worker.call('wait_for_work', { timeoutMs: 0 });
  assert.equal(work.reason, 'WORK_ASSIGNED');
  assert.equal(work.state.instructions, 'Implement the decoder and run its tests.');
  const finished = await worker.call('check_in', { summary: 'Decoder implemented; all tests passed.' });
  assert.equal(finished.phase, 'AWAITING_LEAD');
  assert.equal(finished.instructions, null);
});

test('new messages invalidate pending decisions atomically, including broadcasts', async t => {
  const f = await fixture(t);
  const lead = await f.connect('lead', 'lead');
  const worker = await f.connect('worker');
  const original = await worker.call('work_status');
  await lead.call('broadcast', { body: 'Interface changed.' });
  await assert.rejects(lead.call('answer_check_in', { requestId: original.request_id, decision: 'idle' }), { code: 'STALE_CHECKIN' });
  assert.equal((await worker.call('work_status')).phase, 'CHECKIN_REQUIRED');
  assert.equal((await worker.call('whoami')).status, 'WAITING');
});

test('workers can start before a lead; lead replacement reroutes requests and revokes prior idle grants', async t => {
  const f = await fixture(t);
  const worker = await f.connect('worker');
  assert.equal((await worker.call('work_status')).orchestrator, null);
  const lead = await f.connect('first-lead', 'lead');
  const request = (await lead.call('list_check_ins')).find(r => r.name === 'worker');
  assert.ok(request);
  await lead.call('answer_check_in', { requestId: request.request_id, decision: 'idle' });
  const nextLead = await f.connect('next-lead', 'lead');
  await rpc(f.config, 'set_lead', { agent: 'next-lead' });
  assert.equal((await worker.call('work_status')).phase, 'AWAITING_LEAD');
  const rerouted = (await nextLead.call('list_check_ins')).find(r => r.name === 'worker');
  assert.ok(rerouted);
  assert.notEqual(rerouted.request_id, request.request_id);
  await assert.rejects(lead.call('answer_check_in', { requestId: rerouted.request_id, decision: 'idle' }), { code: 'NOT_ORCHESTRATOR' });
});

test('wait cancellation, duplicate waits, session replacement and broker shutdown release pending requests', async t => {
  const f = await fixture(t);
  const worker = await f.connect('worker');
  const controller = new AbortController();
  const pending = worker.call('wait_for_work', { timeoutMs: 2000 }, { signal: controller.signal });
  const cancelled = assert.rejects(pending, { code: 'WAIT_CANCELLED' });
  await until(() => f.broker.waiters.pending.size === 1);
  await assert.rejects(worker.call('wait_for_work', { timeoutMs: 2000 }), { code: 'WAIT_ALREADY_ACTIVE' });
  controller.abort();
  await cancelled;
  await until(() => f.broker.waiters.pending.size === 0);

  const stale = worker.call('wait_for_work', { timeoutMs: 2000 });
  const fenced = assert.rejects(stale, { code: 'UNAUTHORIZED_AGENT' });
  await until(() => f.broker.waiters.pending.size === 1);
  // Expire the lease in the database without waiting a real minute.
  f.broker.store.db.prepare("UPDATE agents SET last_seen=0,status='OFFLINE' WHERE name='worker'").run();
  const replacement = await f.connect('worker');
  await fenced;
  const shutdown = replacement.call('wait_for_work', { timeoutMs: 2000 });
  const stopped = assert.rejects(shutdown, { code: 'BROKER_STOPPING' });
  await until(() => f.broker.waiters.pending.size === 1);
  const port = f.broker.port;
  await f.broker.close();
  await stopped;
  f.broker = await startBroker(f.config, { port });
  assert.equal((await replacement.call('work_status')).phase, 'AWAITING_LEAD');
});

test('idle approval and pending requests survive restart; offline agents stay offline during migration', async t => {
  const f = await fixture(t);
  const lead = await f.connect('lead', 'lead');
  const worker = await f.connect('worker');
  const pending = await f.connect('pending');
  const request = await worker.call('work_status');
  await lead.call('answer_check_in', { requestId: request.request_id, decision: 'idle' });
  const pendingState = await pending.call('work_status');
  const port = f.broker.port;
  await f.broker.close();
  f.broker = await startBroker(f.config, { port });
  assert.equal((await worker.call('work_status')).phase, 'IDLE_APPROVED');
  assert.equal((await pending.call('work_status')).request_id, pendingState.request_id);

  await worker.close();
  await f.broker.close();
  // Reproduce a version-1 database using the original tables, preserving real
  // messages/identities. The migration must be additive and not resurrect peers.
  const db = new DatabaseSync(f.config.database);
  db.exec("DROP TABLE worker_coordination; DELETE FROM metadata WHERE key='lead_id'; UPDATE metadata SET value='1' WHERE key='schema_version';");
  db.close();
  f.broker = await startBroker(f.config, { port });
  const agents = await lead.call('list_agents');
  assert.equal(agents.find(a => a.name === 'worker').status, 'OFFLINE');
  assert.equal(f.broker.store.db.prepare("SELECT value FROM metadata WHERE key='schema_version'").get().value, '2');
});

test('long HTTP wait outlives normal socket timeout while bridge heartbeats keep the worker online', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  f.config.heartbeatMs = 250;
  f.config.offlineMs = 1000;
  const worker = await f.connect('waiting-worker');
  worker.startHeartbeat();
  const response = await worker.call('wait_for_work', { timeoutMs: 16000 });
  assert.equal(response.reason, 'TIMEOUT');
  assert.equal(response.state.phase, 'AWAITING_LEAD');
  assert.equal((await worker.call('whoami')).status, 'WAITING');
});

test('real MCP subprocess waits resume on lead decisions and inbox delivery', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  f.config.heartbeatMs = 100;
  f.config.offlineMs = 2000;
  writeFileSync(join(f.config.directory, 'config.json'), JSON.stringify(f.config));
  const peers = [];
  let diagnostics = '';
  t.after(async () => { for (const peer of peers) await peer.close(); });
  const connect = async (name, role) => {
    const client = new Client({ name: 'wait-test', version: '1.0' });
    peers.push(client);
    const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('src/cli.js'), 'mcp', '--project', f.config.root, '--name', name, '--role', role, '--verbose'], stderr: 'pipe' });
    transport.stderr.on('data', chunk => { diagnostics += chunk; });
    await client.connect(transport);
    return async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args });
      assert.ok(!result.isError, JSON.stringify(result));
      return JSON.parse(result.content[0].text);
    };
  };
  const lead = await connect('lead', 'lead');
  const worker = await connect('worker', 'generalist');
  const request = await worker('mesh_work_status');
  const before = await worker('mesh_whoami');
  let returned = false;
  const pending = worker('mesh_wait_for_work', { timeoutMs: 25, afterRevision: request.revision }).then(value => { returned = true; return value; });
  await until(() => f.broker.waiters.pending.size === 1);
  // Several empty HTTP waits must elapse without returning control to a model.
  await delay(250);
  assert.equal(returned, false);
  assert.ok((await worker('mesh_whoami')).last_seen > before.last_seen, 'Heartbeats continue during the same held MCP call');
  await lead('mesh_answer_check_in', { requestId: request.request_id, decision: 'work', instructions: 'Check the decoder tests.' });
  assert.equal((await pending).reason, 'WORK_ASSIGNED');
  const next = await worker('mesh_check_in', { summary: 'Tests checked.' });
  const idle = await lead('mesh_answer_check_in', { requestId: next.request_id, decision: 'idle' });
  const sleeping = worker('mesh_wait_for_work', { timeoutMs: 2000, afterRevision: idle.revision });
  await until(() => f.broker.waiters.pending.size === 1);
  await lead('mesh_send_message', { to: 'worker', body: 'Please check in again.' });
  assert.equal((await sleeping).reason, 'MESSAGES');
  // Close before the fixture stops its broker (after hooks run in registration order).
  for (const peer of peers) await peer.close();
  assert.ok(diagnostics.includes('wait_renewed'));
  assert.ok(!diagnostics.includes(f.config.token), 'Project token must not be logged');
  assert.ok(!diagnostics.includes('Check the decoder tests.'), 'Work instructions must not be logged');
  assert.ok(!diagnostics.includes('Please check in again.'), 'Message bodies must not be logged');
  // Verbose diagnostics stayed on stderr: all MCP stdout responses above were
  // successfully decoded by the SDK, and diagnostic records are valid JSON.
  for (const line of diagnostics.trim().split('\n')) assert.ok(JSON.parse(line).event);
});
