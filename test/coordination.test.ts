/**
 * Work/idle coordination tests.
 *
 * These scenarios pin down the orchestrator-controlled loop: automatic
 * check-in, explicit idle decisions, revocation by new messages, lead
 * replacement, wait cancellation and fencing, persistence across restarts and
 * schema migration, held waits inside real MCP bridge subprocesses, and the
 * participation prompts.
 *
 * @file
 */

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { z } from 'zod';

import { startBroker } from '../src/broker.ts';
import { AgentClient, rpc } from '../src/client.ts';
import { selectOne, valueRowSchema } from '../src/database.ts';

import { brokerUrl, createCleanup, createProject, startBridge, toolErrorCode, until, updateConfig } from './helpers.ts';

import type { BridgeHandle, ConfigOverrides, Defer } from './helpers.ts';
import type { Broker } from '../src/broker.ts';
import type { MeshConfig } from '../src/config.ts';
import type { TestContext } from 'node:test';

process.env['AGENTMESH_LOG_LEVEL'] = 'silent';

/** Every diagnostic record is a JSON object naming its event. */
const diagnosticRecordSchema = z.object({ event: z.string().min(1) });

/** A project with a running broker and helpers to add agents. */
class CoordinationFixture {
  /** The running broker; replaced when a test restarts it. */
  public broker: Broker;

  /** The project configuration, including the broker's URL. */
  public readonly config: MeshConfig;

  /** The test's cleanup stack. */
  public readonly defer: Defer;

  /**
   * Wrap an already started broker.
   *
   * @param broker - The running broker.
   * @param config - The configuration, including the broker's URL.
   * @param defer - The test's cleanup stack.
   */
  public constructor(broker: Broker, config: MeshConfig, defer: Defer) {
    this.broker = broker;
    this.config = config;
    this.defer = defer;
  }

  /**
   * Register an in-process agent session, closed automatically at the end.
   *
   * @param name - The agent's name.
   * @param role - The agent's role label.
   * @returns The connected session.
   */
  public async connect(name: string, role = 'generalist'): Promise<AgentClient> {
    const client = new AgentClient(this.config, { name, role });
    await client.connect();
    this.defer(async () => client.close());
    return client;
  }

  /** Stop the broker and start a fresh one on the same port and database. */
  public async restart(): Promise<void> {
    const { port } = this.broker;
    await this.broker.close();
    this.broker = await startBroker(this.config, { port });
  }

  /**
   * Launch a real MCP bridge subprocess, closed automatically at the end.
   *
   * @param name - The agent's name.
   * @param role - The agent's role label.
   * @param isVerbose - Whether the bridge logs debug diagnostics.
   * @returns A handle for calling tools.
   */
  public async bridge(name: string, role: string, isVerbose = false): Promise<BridgeHandle> {
    const handle = await startBridge(this.config, { name, role, isVerbose });
    this.defer(async () => handle.client.close());
    return handle;
  }
}

/**
 * Create a project and start its broker on an ephemeral port.
 *
 * Timing overrides are written BEFORE the broker starts, so the broker's
 * presence rules and the bridges (which read config.json) agree.
 *
 * @param t - The running test.
 * @param overrides - Optional heartbeat/offline timing for the scenario.
 * @returns A fixture whose broker is running and whose agents can be added.
 */
async function fixture(t: TestContext, overrides: ConfigOverrides = {}): Promise<CoordinationFixture> {
  const defer = createCleanup(t);
  const project = createProject(defer, 'agentmesh-coordination-');
  const tuned = Object.keys(overrides).length > 0 ? updateConfig(project, overrides) : project;
  const broker = await startBroker(tuned, { port: 0 });
  const config = updateConfig(tuned, { url: brokerUrl(broker.port) });
  const created = new CoordinationFixture(broker, config, defer);
  // Registered after the project directory, so it runs BEFORE its removal.
  defer(async () => created.broker.close());
  return created;
}

await test('workers automatically check in; timeouts never grant idle; only the selected lead can decide', async (t) => {
  const f = await fixture(t);
  const lead = await f.connect('lead', 'lead');
  const worker = await f.connect('worker');
  const peer = await f.connect('peer');
  const state = await worker.call('work_status', {});
  assert.equal(state.phase, 'AWAITING_LEAD');
  assert.equal((await worker.call('whoami', {})).status, 'WAITING');
  await assert.rejects(worker.call('set_status', { status: 'IDLE' }), { code: 'IDLE_NOT_APPROVED' });
  const timeout = await worker.call('wait_for_work', { timeoutMs: 30 });
  assert.equal(timeout.reason, 'TIMEOUT');
  assert.equal(timeout.state.phase, 'AWAITING_LEAD');
  const requestId = state.request_id ?? '';
  await assert.rejects(peer.call('answer_check_in', { requestId, decision: 'idle' }), { code: 'NOT_ORCHESTRATOR' });
  await assert.rejects(worker.call('set_lead', { agent: 'worker' }), { code: 'HUMAN_CONTROL_REQUIRED' });
  const pending = worker.call('wait_for_work', { timeoutMs: 2000, afterRevision: state.revision });
  await until(() => f.broker.waiters.pending.size === 1);
  await lead.call('answer_check_in', { requestId, decision: 'idle', reason: 'No work remaining right now.' });
  const decision = await pending;
  assert.equal(decision.reason, 'IDLE_APPROVED');
  assert.equal((await worker.call('whoami', {})).status, 'IDLE');
  // A duplicate/delayed decision cannot change a completed request.
  await assert.rejects(lead.call('answer_check_in', { requestId, decision: 'work', instructions: 'Late assignment' }), {
    code: 'STALE_CHECKIN',
  });
});

await test('message delivery revokes idle, wakes the waiter, and requires a fresh check-in', async (t) => {
  const f = await fixture(t);
  const lead = await f.connect('lead', 'lead');
  const worker = await f.connect('worker');
  const request = await worker.call('work_status', {});
  const idle = await lead.call('answer_check_in', { requestId: request.request_id ?? '', decision: 'idle' });
  const waiting = worker.call('wait_for_work', { timeoutMs: 2000, afterRevision: idle.revision });
  await until(() => f.broker.waiters.pending.size === 1);
  const sent = await lead.call('send_message', { to: 'worker', body: 'Please inspect the latest interface.' });
  const wake = await waiting;
  assert.equal(wake.reason, 'MESSAGES');
  assert.equal(wake.state.phase, 'CHECKIN_REQUIRED');
  assert.equal(wake.messages[0]?.id, sent.id);
  await assert.rejects(worker.call('check_in', { summary: 'Available' }), { code: 'UNREAD_MESSAGES' });
  await worker.call('ack_message', { id: sent.id });
  const next = await worker.call('check_in', { summary: 'Message handled; available for work.' });
  assert.notEqual(next.request_id, request.request_id);
  // Repeating a pending check-in returns the same request.
  const duplicate = await worker.call('check_in', { summary: 'Retry' });
  assert.equal(duplicate.request_id, next.request_id);
  assert.equal((await lead.call('list_check_ins', {})).length, 1);
  const assignment = await lead.call('answer_check_in', {
    requestId: next.request_id ?? '',
    decision: 'work',
    instructions: 'Implement the decoder and run its tests.',
  });
  assert.equal(assignment.phase, 'WORK_ASSIGNED');
  const work = await worker.call('wait_for_work', { timeoutMs: 0 });
  assert.equal(work.reason, 'WORK_ASSIGNED');
  assert.equal(work.state.instructions, 'Implement the decoder and run its tests.');
  const finished = await worker.call('check_in', { summary: 'Decoder implemented; all tests passed.' });
  assert.equal(finished.phase, 'AWAITING_LEAD');
  assert.equal(finished.instructions, null);
});

await test('new messages invalidate pending decisions atomically, including broadcasts', async (t) => {
  const f = await fixture(t);
  const lead = await f.connect('lead', 'lead');
  const worker = await f.connect('worker');
  const original = await worker.call('work_status', {});
  await lead.call('broadcast', { body: 'Interface changed.' });
  await assert.rejects(lead.call('answer_check_in', { requestId: original.request_id ?? '', decision: 'idle' }), {
    code: 'STALE_CHECKIN',
  });
  assert.equal((await worker.call('work_status', {})).phase, 'CHECKIN_REQUIRED');
  assert.equal((await worker.call('whoami', {})).status, 'WAITING');
});

await test('workers can start before a lead; lead replacement reroutes requests and revokes prior idle grants', async (t) => {
  const f = await fixture(t);
  const worker = await f.connect('worker');
  assert.equal((await worker.call('work_status', {})).orchestrator, null);
  const lead = await f.connect('first-lead', 'lead');
  const request = (await lead.call('list_check_ins', {})).find((pending) => pending.name === 'worker');
  assert.ok(request !== undefined);
  await lead.call('answer_check_in', { requestId: request.request_id ?? '', decision: 'idle' });
  const nextLead = await f.connect('next-lead', 'lead');
  await rpc(f.config, 'set_lead', { agent: 'next-lead' });
  assert.equal((await worker.call('work_status', {})).phase, 'AWAITING_LEAD');
  const rerouted = (await nextLead.call('list_check_ins', {})).find((pending) => pending.name === 'worker');
  assert.ok(rerouted !== undefined);
  assert.notEqual(rerouted.request_id, request.request_id);
  await assert.rejects(lead.call('answer_check_in', { requestId: rerouted.request_id ?? '', decision: 'idle' }), {
    code: 'NOT_ORCHESTRATOR',
  });
});

await test('wait cancellation, duplicate waits, session replacement and broker shutdown release pending requests', async (t) => {
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

  // A replacement session fences out a wait left behind by the old one.
  const stale = worker.call('wait_for_work', { timeoutMs: 2000 });
  const fenced = assert.rejects(stale, { code: 'UNAUTHORIZED_AGENT' });
  await until(() => f.broker.waiters.pending.size === 1);
  // Expire the lease in the database without waiting a real minute.
  f.broker.store.db.prepare("UPDATE agents SET last_seen = 0, status = 'OFFLINE' WHERE name = 'worker'").run();
  const replacement = await f.connect('worker');
  await fenced;

  // Broker shutdown releases a parked wait with a retryable error.
  const shutdown = replacement.call('wait_for_work', { timeoutMs: 2000 });
  const stopped = assert.rejects(shutdown, { code: 'BROKER_STOPPING' });
  await until(() => f.broker.waiters.pending.size === 1);
  await f.restart();
  await stopped;
  assert.equal((await replacement.call('work_status', {})).phase, 'AWAITING_LEAD');
});

await test('idle approval and pending requests survive restart; offline agents stay offline during migration', async (t) => {
  const f = await fixture(t);
  const lead = await f.connect('lead', 'lead');
  const worker = await f.connect('worker');
  const pending = await f.connect('pending');
  const request = await worker.call('work_status', {});
  await lead.call('answer_check_in', { requestId: request.request_id ?? '', decision: 'idle' });
  const pendingState = await pending.call('work_status', {});
  await f.restart();
  assert.equal((await worker.call('work_status', {})).phase, 'IDLE_APPROVED');
  assert.equal((await pending.call('work_status', {})).request_id, pendingState.request_id);

  await worker.close();
  const { port } = f.broker;
  await f.broker.close();
  // Reproduce a version-1 database using the original tables, preserving real
  // messages/identities. The migration must be additive and not resurrect peers.
  const legacy = new DatabaseSync(f.config.database);
  legacy.exec(
    "DROP TABLE worker_coordination; DELETE FROM metadata WHERE key = 'lead_id'; UPDATE metadata SET value = '1' WHERE key = 'schema_version';",
  );
  legacy.close();
  f.broker = await startBroker(f.config, { port });
  const agents = await lead.call('list_agents', {});
  assert.equal(agents.find((agent) => agent.name === 'worker')?.status, 'OFFLINE');
  const version = selectOne(
    f.broker.store.db,
    valueRowSchema,
    "SELECT value FROM metadata WHERE key = 'schema_version'",
  );
  assert.equal(version?.value, '2');
});

await test(
  'long HTTP wait outlives normal socket timeout while bridge heartbeats keep the worker online',
  { timeout: 20_000 },
  async (t) => {
    const f = await fixture(t, { heartbeatMs: 250, offlineMs: 1000 });
    const worker = await f.connect('waiting-worker');
    worker.startHeartbeat();
    const response = await worker.call('wait_for_work', { timeoutMs: 16_000 });
    assert.equal(response.reason, 'TIMEOUT');
    assert.equal(response.state.phase, 'AWAITING_LEAD');
    assert.equal((await worker.call('whoami', {})).status, 'WAITING');
  },
);

await test('real MCP subprocess waits resume on lead decisions and inbox delivery', { timeout: 15_000 }, async (t) => {
  const f = await fixture(t, { heartbeatMs: 100, offlineMs: 2000 });
  const lead = await f.bridge('lead', 'lead', true);
  const worker = await f.bridge('worker', 'generalist', true);
  const request = await worker.call('mesh_work_status');
  const before = await worker.call('mesh_whoami');
  let hasReturned = false;
  const pending = (async () => {
    const value = await worker.call('mesh_wait_for_work', { timeoutMs: 25, afterRevision: request.revision });
    hasReturned = true;
    return value;
  })();
  await until(() => f.broker.waiters.pending.size === 1);
  // Several empty HTTP waits must elapse without returning control to a model.
  await delay(250);
  assert.equal(hasReturned, false);
  assert.ok(
    (await worker.call('mesh_whoami')).last_seen > before.last_seen,
    'Heartbeats continue during the same held MCP call',
  );
  await lead.call('mesh_answer_check_in', {
    requestId: request.request_id,
    decision: 'work',
    instructions: 'Check the decoder tests.',
  });
  assert.equal((await pending).reason, 'WORK_ASSIGNED');
  const next = await worker.call('mesh_check_in', { summary: 'Tests checked.' });
  const idle = await lead.call('mesh_answer_check_in', { requestId: next.request_id, decision: 'idle' });
  const sleeping = worker.call('mesh_wait_for_work', { timeoutMs: 2000, afterRevision: idle.revision });
  await until(() => f.broker.waiters.pending.size === 1);
  await lead.call('mesh_send_message', { to: 'worker', body: 'Please check in again.' });
  assert.equal((await sleeping).reason, 'MESSAGES');

  // Close the bridges so their diagnostics are complete.
  await lead.client.close();
  await worker.client.close();
  const diagnostics = lead.diagnostics() + worker.diagnostics();
  assert.ok(diagnostics.includes('wait_renewed'));
  assert.ok(!diagnostics.includes(f.config.token), 'Project token must not be logged');
  assert.ok(!diagnostics.includes('Check the decoder tests.'), 'Work instructions must not be logged');
  assert.ok(!diagnostics.includes('Please check in again.'), 'Message bodies must not be logged');
  // Verbose diagnostics stayed on stderr: all MCP stdout responses above were
  // successfully decoded by the SDK, and every diagnostic record is JSON.
  for (const line of diagnostics.trim().split('\n')) {
    diagnosticRecordSchema.parse(JSON.parse(line));
  }
});

await test(
  'a new MCP wait supersedes one the host abandoned without notifications/cancelled',
  { timeout: 15_000 },
  async (t) => {
    const f = await fixture(t);
    const lead = await f.bridge('lead', 'lead');
    const worker = await f.bridge('worker', 'generalist');
    const request = await worker.call('mesh_work_status');
    const idle = await lead.call('mesh_answer_check_in', { requestId: request.request_id, decision: 'idle' });
    // Never cancelled: the host has silently given up on this call.
    const abandoned = worker.callRaw('mesh_wait_for_work', { timeoutMs: 25, afterRevision: idle.revision });
    await until(() => f.broker.waiters.pending.size === 1);
    await delay(100);
    const replacement = worker.callRaw('mesh_wait_for_work', { timeoutMs: 25, afterRevision: idle.revision });
    const superseded = await abandoned;
    assert.ok(superseded.isError);
    assert.equal(toolErrorCode(superseded.payload), 'WAIT_SUPERSEDED');
    await until(() => f.broker.waiters.pending.size === 1);
    await lead.call('mesh_send_message', { to: 'worker', body: 'Still listening?' });
    const wake = await replacement;
    assert.ok(!wake.isError, JSON.stringify(wake.payload));
    assert.match(JSON.stringify(wake.payload), /"reason":"MESSAGES"/v);
  },
);

await test('the bridge offers lead and worker participation prompts', { timeout: 15_000 }, async (t) => {
  const f = await fixture(t);
  const { client } = await f.bridge('observer-1', 'observer');
  const prompts = (await client.listPrompts()).prompts.map((prompt) => prompt.name);
  assert.deepEqual(
    prompts.toSorted((left, right) => left.localeCompare(right)),
    ['lead', 'worker'],
  );
  const lead = await client.getPrompt({ name: 'lead', arguments: { objective: 'Ship the parser' } });
  const leadContent = lead.messages[0]?.content;
  assert.ok(leadContent?.type === 'text');
  assert.match(leadContent.text, /mesh_answer_check_in[\s\S]*Objective: Ship the parser$/v);
  const worker = await client.getPrompt({ name: 'worker', arguments: {} });
  const workerContent = worker.messages[0]?.content;
  assert.ok(workerContent?.type === 'text');
  assert.match(workerContent.text, /mesh_check_in/v);
});
