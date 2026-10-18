/**
 * Workspace team and session identity tests.
 *
 * These scenarios pin down per-workspace isolation (normalization, routing,
 * token separation, persistence across broker restarts), the lifecycle of
 * session identities (lead claims, clean departure, inherited inboxes), the
 * schema 3 migration, and nameless MCP bridges that join their workspace's
 * team only when the model asks.
 *
 * @file
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { ServerResponse } from 'node:http';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { z } from 'zod/v3';

import { startBroker } from '../src/broker.ts';
import { AgentClient, openTeamConfig, rpc } from '../src/client.ts';
import { selectOne, valueRowSchema } from '../src/database.ts';
import { PROJECT_OPERATION_TIMEOUT_MS } from '../src/protocol.ts';
import { Store } from '../src/store.ts';
import { normalizeWorkspace, teamSlug } from '../src/teams.ts';

import {
  brokerUrl,
  createCleanup,
  createProject,
  registration,
  startBridge,
  toolErrorCode,
  until,
  updateConfig,
} from './helpers.ts';

import type { BridgeHandle, BridgeOptions, TestRegistration } from './helpers.ts';
import type { Broker } from '../src/broker.ts';
import type { MeshConfig } from '../src/config.ts';
import type { TestContext } from 'node:test';

process.env['AGENTMESH_LOG_LEVEL'] = 'silent';

/** The first unread page of an inbox. */
const inbox = { unreadOnly: true, after: 0, limit: 50 } as const;

/** A workspace folder as Claude Code reports it through MCP roots. */
const ALPHA_URI = 'file:///E:/01%20-%20Personal%20Projects/Alpha';

/** Just enough of an agent list to count its entries. */
const agentListSchema = z.array(z.unknown());

/**
 * Make a real workspace accessible to the test's native broker.
 *
 * @param config - Test home project.
 * @param name - Workspace directory name.
 * @returns Absolute workspace path.
 */
function createWorkspace(config: MeshConfig, name: string): string {
  const root = path.join(config.root, name);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Create only a workspace under this test's disposable home project.
  mkdirSync(root);
  return root;
}

/**
 * Count the agents listed by a team.
 *
 * @param config - The team's configuration.
 * @returns The number of listed agents.
 */
async function countAgents(config: MeshConfig): Promise<number> {
  return agentListSchema.parse(await rpc(config, 'list_agents')).length;
}

/** Registration input for a session identity with a role. */
interface SessionRegistration extends TestRegistration {
  /** Always `true`: the identity lives only as long as its session. */
  readonly ephemeral: true;
}

/**
 * Build registration input for a session identity.
 *
 * @param name - The session's (normally generated) name.
 * @param role - The requested role.
 * @returns Registration input for `Store.register`.
 */
function session(name: string, role: string): SessionRegistration {
  return { ...registration(name), role, ephemeral: true };
}

/**
 * Start a broker on an ephemeral port for a fresh home project.
 *
 * @param t - The running test.
 * @returns The broker and the home configuration, including its URL.
 */
async function brokerFixture(t: TestContext): Promise<{ readonly broker: Broker; readonly config: MeshConfig }> {
  const defer = createCleanup(t);
  const initial = createProject(defer, 'agentmesh-teams-');
  const broker = await startBroker(initial, { port: 0 });
  const config = updateConfig(initial, { url: brokerUrl(broker.port) });
  return { broker, config };
}

await test('workspace folders normalize to stable, distinct team slugs', () => {
  const fromUri = normalizeWorkspace(ALPHA_URI);
  assert.equal(fromUri.display, 'E:/01 - Personal Projects/Alpha');
  assert.equal(fromUri.name, 'Alpha');
  // Windows paths are case-insensitive and may use backslashes.
  const fromPath = normalizeWorkspace(String.raw`e:\01 - personal projects\ALPHA`);
  assert.equal(teamSlug(fromPath), teamSlug(fromUri));
  assert.equal(normalizeWorkspace('E:/01 - Personal Projects/Alpha/').key, fromUri.key);
  assert.match(teamSlug(fromUri), /^alpha-[\da-f]{12}$/v);
  // POSIX paths are case-sensitive, and nested folders are separate teams.
  assert.notEqual(teamSlug(normalizeWorkspace('/srv/app')), teamSlug(normalizeWorkspace('/srv/App')));
  assert.notEqual(teamSlug(normalizeWorkspace('/srv/app')), teamSlug(normalizeWorkspace('/srv/app/web')));
  assert.equal(normalizeWorkspace('file://server/share/repo').display, '//server/share/repo');
  assert.throws(() => normalizeWorkspace('relative/folder'), { code: 'NO_WORKSPACE' });
});

await test('session identities claim a vacant lead, leave cleanly and hand back unfinished work', (t) => {
  const defer = createCleanup(t);
  const store = new Store(createProject(defer));
  defer(() => {
    store.close();
  });
  const lead = store.register(session('lead-1', 'lead'));
  assert.equal(lead.lifetime, 'session');
  assert.equal(store.coordination.leadId(), lead.id);
  // A live lead is never displaced, and the refused claim leaves no trace.
  assert.throws(() => store.register(session('lead-2', 'lead')), { code: 'LEAD_ACTIVE' });
  assert.deepEqual(
    store.execute('list_agents', {}, null).map((agent) => agent.name),
    ['lead-1'],
  );

  const workerInput = session('worker-1', 'worker');
  const worker = store.register(workerInput);
  const request = store.execute('work_status', {}, worker.id);
  assert.equal(request.phase, 'AWAITING_LEAD');
  store.execute(
    'answer_check_in',
    { requestId: request.request_id ?? '', decision: 'work', instructions: 'Write the parser.' },
    lead.id,
  );
  // The worker's session ends before it reports back.
  store.execute('disconnect', {}, worker.id);
  const notice = store
    .execute('get_messages', inbox, lead.id)
    .messages.find((message) => message.type === 'worker_left');
  assert.ok(notice !== undefined);
  assert.match(notice.body, /Write the parser\./v);
  assert.deepEqual(
    store.execute('list_agents', {}, null).map((agent) => agent.name),
    ['lead-1'],
  );
  assert.throws(() => store.execute('send_message', { to: 'worker-1', body: 'Still there?' }, lead.id), {
    code: 'AGENT_LEFT',
  });
  assert.throws(
    () => store.authenticate({ agentId: worker.id, secret: workerInput.secret, sessionId: workerInput.sessionId }),
    { code: 'UNAUTHORIZED_AGENT' },
  );
  assert.throws(() => store.register(workerInput), { code: 'AGENT_LEFT' });

  // When the lead's session ends, a pending request waits for the next lead,
  // which also inherits the unread inbox nobody else could ever read.
  const waiting = store.register(session('worker-2', 'worker'));
  store.execute('disconnect', {}, lead.id);
  assert.equal(store.execute('work_status', {}, waiting.id).orchestrator, null);
  const next = store.register(session('lead-3', 'lead'));
  const inherited = store.execute('get_messages', inbox, next.id).messages;
  assert.ok(inherited.some((message) => message.type === 'worker_left'));
  assert.deepEqual(
    store.execute('list_check_ins', {}, next.id).map((pending) => pending.name),
    ['worker-2'],
  );
  assert.equal(store.execute('work_status', {}, waiting.id).orchestrator?.name, 'lead-3');
});

await test('a session takes over from an offline lead, which returns as a worker', (t) => {
  const defer = createCleanup(t);
  const config = createProject(defer);
  let clock = 100_000;
  const store = new Store(config, { now: () => clock });
  defer(() => {
    store.close();
  });
  const durableInput = { ...registration('claude-lead'), role: 'lead' };
  const durable = store.register(durableInput);
  assert.throws(() => store.register(session('claude-code-1', 'lead')), { code: 'LEAD_ACTIVE' });
  clock += config.offlineMs;
  store.expire();
  const claimant = store.register(session('claude-code-2', 'lead'));
  assert.equal(store.coordination.leadId(), claimant.id);
  // The durable identity keeps its inbox; it simply rejoins as a worker.
  store.register({ ...durableInput, sessionId: randomUUID() });
  const returned = store.execute('work_status', {}, durable.id);
  assert.equal(returned.participant, 'worker');
  assert.equal(returned.orchestrator?.name, 'claude-code-2');
  // An ended session is no candidate for the human lead control either.
  store.execute('disconnect', {}, claimant.id);
  assert.throws(() => store.execute('set_lead', { agent: 'claude-code-2' }, null), { code: 'AGENT_LEFT' });
});

await test('schema 2 databases migrate to schema 3 with durable identities', (t) => {
  const defer = createCleanup(t);
  const config = createProject(defer);
  let store = new Store(config);
  const agent = store.register(registration('codex-1'));
  store.close();
  const legacy = new DatabaseSync(config.database);
  legacy.exec("ALTER TABLE agents DROP COLUMN lifetime; UPDATE metadata SET value = '2' WHERE key = 'schema_version';");
  legacy.close();
  store = new Store(config);
  defer(() => {
    store.close();
  });
  assert.equal(store.agent(agent.id).lifetime, 'durable');
  const version = selectOne(store.db, valueRowSchema, "SELECT value FROM metadata WHERE key = 'schema_version'");
  assert.equal(version?.value, '4');
});

await test('workspace creation uses the project deadline while ordinary RPC remains short', async (t) => {
  const config = createProject(createCleanup(t));
  const deadlines: number[] = [];
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
    deadlines.push(milliseconds);
    return timeout(milliseconds);
  });
  t.mock.method(globalThis, 'fetch', async () => {
    await Promise.resolve();
    return Response.json({ result: true });
  });
  await rpc(config, 'open_team', { workspace: config.root });
  await rpc(config, 'list_teams', {});
  assert.deepEqual(deadlines, [PROJECT_OPERATION_TIMEOUT_MS, 5000]);
});

await test('each workspace has its own team; tokens never cross teams; teams survive restart', async (t) => {
  const defer = createCleanup(t);
  const fixture = await brokerFixture(t);
  const { config } = fixture;
  let { broker } = fixture;
  defer(async () => broker.close());

  const alphaRoot = createWorkspace(config, 'Alpha');
  const betaRoot = createWorkspace(config, 'beta');
  const serverDeadlines = t.mock.method(ServerResponse.prototype, 'setTimeout');
  const alpha = await openTeamConfig(config, pathToFileURL(alphaRoot).href);
  assert.ok(serverDeadlines.mock.calls.some((call) => call.arguments[0] === PROJECT_OPERATION_TIMEOUT_MS));
  const alphaAgain = await openTeamConfig(config, `${alphaRoot}/`);
  assert.equal(alphaAgain.team, alpha.team);
  assert.equal(alphaAgain.projectId, alpha.projectId);
  assert.equal(alpha.name, 'Alpha');
  const beta = await openTeamConfig(config, betaRoot);
  assert.notEqual(beta.team, alpha.team);

  const lead = new AgentClient(alpha, { runtime: 'claude-code' });
  await lead.connect('lead');
  assert.match(lead.name, /^claude-code-[\da-f]{8}$/v);
  assert.equal(await countAgents(alpha), 1);
  assert.equal(await countAgents(beta), 0);
  assert.equal(await countAgents(config), 0);

  await assert.rejects(rpc({ ...beta, token: alpha.token }, 'team_status'), { code: 'UNAUTHORIZED' });
  await assert.rejects(rpc({ ...alpha, team: 'missing-000000000000' }, 'team_status'), { code: 'UNKNOWN_TEAM' });
  await assert.rejects(rpc({ ...alpha, team: '../escape' }, 'team_status'), { code: 'UNKNOWN_TEAM' });
  await assert.rejects(rpc(alpha, 'list_teams'), { code: 'UNKNOWN_OPERATION' });
  await assert.rejects(rpc(config, 'open_team', { workspace: 'relative' }), { code: 'NO_WORKSPACE' });
  assert.deepEqual(await rpc(config, 'list_teams'), [
    { team: alpha.team, name: 'Alpha', workspace: normalizeWorkspace(alphaRoot).display },
    { team: beta.team, name: 'beta', workspace: normalizeWorkspace(betaRoot).display },
  ]);

  // A restarted broker reopens a team's state lazily on its next request.
  const { port } = broker;
  await broker.close();
  // eslint-disable-next-line require-atomic-updates -- Sequential restart: nothing else reads `broker` between closing it and assigning its replacement.
  broker = await startBroker(config, { port });
  assert.equal(broker.teams.size, 0);
  assert.equal((await lead.call('work_status', {})).participant, 'orchestrator');
  await lead.close();
  assert.equal(await countAgents(alpha), 0);
});

await test('nameless MCP sessions join their workspace team only when asked', { timeout: 30_000 }, async (t) => {
  const defer = createCleanup(t);
  const { broker, config } = await brokerFixture(t);
  defer(async () => broker.close());
  const alphaRoot = createWorkspace(config, 'Alpha');
  const betaRoot = createWorkspace(config, 'beta');
  const alphaUri = pathToFileURL(alphaRoot).href;
  const open = async (options: BridgeOptions): Promise<BridgeHandle> => {
    const handle = await startBridge(config, options);
    defer(async () => handle.client.close());
    return handle;
  };

  const lead = await open({ roots: [alphaUri], runtime: 'claude-code' });
  assert.equal(toolErrorCode((await lead.callRaw('mesh_whoami')).payload), 'NOT_JOINED');
  // Seeing the team does not join it.
  assert.equal((await lead.call('mesh_list_agents')).length, 0);
  const joined = await lead.call('mesh_join', { role: 'lead' });
  assert.equal(joined.joined, true);
  assert.equal(joined.state.participant, 'orchestrator');
  assert.match(joined.agent.name, /^claude-code-[\da-f]{8}$/v);
  assert.deepEqual(joined.team, { name: 'Alpha', workspace: normalizeWorkspace(alphaRoot).display });
  assert.equal((await lead.call('mesh_join', { role: 'lead' })).joined, false);
  assert.equal(toolErrorCode((await lead.callRaw('mesh_join', { role: 'worker' })).payload), 'ALREADY_JOINED');

  // A second lead in the same folder is refused, and can join as a worker.
  const worker = await open({ roots: [alphaUri] });
  assert.equal(toolErrorCode((await worker.callRaw('mesh_join', { role: 'lead' })).payload), 'LEAD_ACTIVE');
  const team = broker.teams.get(teamSlug(normalizeWorkspace(alphaUri)));
  assert.ok(team !== undefined);
  const leadWake = lead.call('mesh_wait_for_work', { afterRevision: joined.state.revision });
  await until(() => team.waiters.pending.size === 1);
  const workerJoined = await worker.call('mesh_join', {});
  assert.equal(workerJoined.state.phase, 'AWAITING_LEAD');
  assert.equal(workerJoined.state.orchestrator?.id, joined.agent.id);
  assert.equal((await leadWake).reason, 'MESSAGES');
  const [request] = await lead.call('mesh_list_check_ins');
  assert.ok(request !== undefined);
  await lead.call('mesh_answer_check_in', {
    requestId: request.request_id,
    decision: 'work',
    instructions: 'Ship the parser.',
  });

  // Another folder is a separate team with its own vacant lead role.
  const other = await open({ workspace: betaRoot });
  assert.equal((await other.call('mesh_list_agents')).length, 0);
  assert.equal((await other.call('mesh_join', { role: 'lead' })).state.participant, 'orchestrator');
  // Without any workspace, a session cannot join.
  const lost = await open({});
  assert.equal(toolErrorCode((await lost.callRaw('mesh_join', {})).payload), 'NO_WORKSPACE');

  // Ending the worker's session hands its unfinished work back to the lead.
  await worker.client.close();
  const unread = await lead.call('mesh_get_unread_messages');
  assert.ok(unread.messages.some((message) => message.type === 'worker_left'));
  assert.deepEqual(
    (await lead.call('mesh_list_agents')).map((agent) => agent.id),
    [joined.agent.id],
  );
});
