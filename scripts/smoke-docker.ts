/**
 * End-to-end smoke test of the Docker Compose deployment.
 *
 * The test owns a randomly named, disposable Compose project, so it never
 * touches a real team's containers or volume. It verifies, through real MCP
 * bridges launched with `docker compose exec`:
 *
 * - Explicit idle approval and wake-up on a new message.
 * - Messaging and replies between two bridge processes.
 * - Stable identity and durable state across `docker compose down` / `up`
 *   (the named volume is retained).
 * - Nameless sessions started through the host-side launcher join the team
 *   of their working directory, and different folders stay separate.
 *
 * Finally it removes only its own containers and volume (`down --volumes`).
 * Run with `npm run test:docker`; Docker with Compose v2 must be running.
 *
 * @file
 */

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod/v3';

const exec = promisify(execFile);

/** A unique Compose project name, so the test never touches a real team. */
const project = `agentmesh-smoke-${randomUUID().slice(0, 8)}`;
/** The official Node image's default nonroot UID and GID. */
const NODE_ID = 1000;

/** The Compose arguments selecting this repository's file and the test project. */
const compose = ['compose', '-f', path.resolve('compose.yaml'), '-p', project];

/** Environment for Compose: an ephemeral host port and a recognisable name. */
const dataRoot = await mkdtemp(path.join(tmpdir(), 'agentmesh-docker-'));

/**
 * Reserve an unused loopback port long enough to select the disposable console mapping.
 *
 * @returns Candidate host port; Compose still fails safely if another process races the bind.
 */
async function consolePort(): Promise<number> {
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const address = listener.address();
  assert.ok(address !== null && typeof address !== 'string');
  const closed = once(listener, 'close');
  listener.close();
  await closed;
  return address.port;
}

/** Bind only disposable test directories, never the real checkout. */
const environment = {
  ...process.env,
  MALT_DOCKER_UID: String(process.getuid?.() ?? NODE_ID),
  MALT_DOCKER_GID: String(process.getgid?.() ?? NODE_ID),
  AGENTMESH_PORT: '0',
  AGENTMESH_UI_PORT: String(await consolePort()),
  AGENTMESH_PROJECT_NAME: project,
  AGENTMESH_HOME_ROOT: dataRoot,
  AGENTMESH_WORKSPACE_ROOT: dataRoot,
};

/** Deadline for any single Compose command (image builds can be slow). */
const COMMAND_TIMEOUT_MS = 180_000;

/** Output buffer limit for Compose commands. */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/** Deadline for an MCP bridge to complete its handshake. */
const CONNECT_TIMEOUT_MS = 15_000;

/** Every SDK client opened by this test, closed before teardown. */
const clients = new Set<Client>();

/** One text content block of a tool response. */
const textContentSchema = z.object({ type: z.literal('text'), text: z.string() });

/** The shape of every tool response. */
const toolResponseSchema = z.object({ isError: z.boolean().optional(), content: z.array(textContentSchema).min(1) });

/** The fields of a wait result's state that this test reads. */
const stateSchema = z.object({ phase: z.string(), revision: z.number() });

/** The fields of an inbox message that this test reads. */
const messageSchema = z.object({ id: z.string(), body: z.string() });

/** The fields of tool results that this test reads. */
const resultSchema = z
  .object({
    id: z.string(),
    reason: z.string(),
    revision: z.number(),
    request_id: z.string().nullable(),
    phase: z.string(),
    state: stateSchema,
    messages: z.array(messageSchema),
  })
  .partial()
  .passthrough();

/** A decoded tool result. */
type ToolResult = z.output<typeof resultSchema>;

/**
 * Run one `docker compose` command for the test project.
 *
 * @param args - Arguments after `docker compose -f ... -p ...`.
 * @throws {Error} With Compose's stderr when the command fails.
 */
async function command(...args: string[]): Promise<void> {
  try {
    await exec('docker', [...compose, ...args], {
      env: environment,
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
    });
  } catch (error) {
    // execFile errors carry the child's stderr, which explains the failure.
    const stderr = String(Error.isError(error) && 'stderr' in error ? error.stderr : error);
    throw new Error(`docker compose ${args.join(' ')} failed\n${stderr}`, { cause: error });
  }
}

/** A connected bridge: call a tool and decode its JSON result. */
type CallTool = (name: string, args?: Record<string, unknown>) => Promise<ToolResult>;

/**
 * Launch an MCP bridge inside the broker container and connect to it.
 *
 * @param name - The agent's name; `claude-lead` registers as the lead.
 * @param provider - The provider label.
 * @returns A function that calls a tool and returns its decoded result.
 */
async function connect(name: string, provider: string): Promise<CallTool> {
  const client = new Client({ name: 'docker-smoke', version: '1.0' });
  const role = name === 'claude-lead' ? 'lead' : 'generalist';
  const transport = new StdioClientTransport({
    command: 'docker',
    args: [
      ...compose,
      'exec',
      '-T',
      'broker',
      'node',
      'src/cli.ts',
      'mcp',
      '--project',
      '/data',
      '--name',
      name,
      '--provider',
      provider,
      '--role',
      role,
    ],
    env: environment,
    stderr: 'pipe',
  });
  let diagnostics = '';
  transport.stderr?.on('data', (chunk: Uint8Array) => {
    diagnostics += Buffer.from(chunk).toString('utf8');
  });
  clients.add(client);
  await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
  return async (tool, args = {}) => {
    const response = toolResponseSchema.parse(await client.callTool({ name: tool, arguments: args }));
    assert.ok(response.isError !== true, JSON.stringify(response) + diagnostics);
    const [first] = response.content;
    assert.ok(first !== undefined);
    return resultSchema.parse(JSON.parse(first.text));
  };
}

/** An agent record, reduced to its name. */
const namedSchema = z.object({ name: z.string() });

/** The fields of a `mesh_join` result that this test reads. */
const joinSchema = z.object({
  agent: namedSchema,
  state: z.object({ participant: z.string(), phase: z.string(), orchestrator: namedSchema.nullable() }),
});

/** The roster returned by `mesh_list_agents`. */
const rosterSchema = z.array(namedSchema);

/**
 * Launch a nameless session through the host-side launcher, as a host
 * without MCP roots (Codex) would, from a given working directory.
 *
 * @param cwd - The session's folder, which selects its team.
 * @returns A function that calls a tool and returns its decoded JSON payload.
 */
async function connectSession(
  cwd: string,
): Promise<(tool: string, args?: Record<string, unknown>) => Promise<unknown>> {
  const client = new Client({ name: 'docker-smoke-session', version: '1.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve('src/docker-mcp.ts'), '--provider', 'openai', '--runtime', 'codex-cli'],
    // The launcher targets this test's Compose project, not a real team.
    env: { ...environment, COMPOSE_PROJECT_NAME: project },
    cwd,
    stderr: 'pipe',
  });
  clients.add(client);
  await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
  return async (tool, args = {}) => {
    const response = toolResponseSchema.parse(await client.callTool({ name: tool, arguments: args }));
    assert.ok(response.isError !== true, JSON.stringify(response));
    const [first] = response.content;
    assert.ok(first !== undefined);
    const payload: unknown = JSON.parse(first.text);
    return payload;
  };
}

/** Close every open SDK client (and therefore every bridge process). */
async function closeClients(): Promise<void> {
  for (const client of clients) {
    await client.close();
  }
  clients.clear();
}

/**
 * Exercise the container PWA against its actual broker without starting inference.
 *
 * @param shouldQueue - Queue once, then verify persistence after recreation.
 */
async function verifyConsole(shouldQueue: boolean): Promise<void> {
  await command(
    'exec',
    '-T',
    'broker',
    'node',
    '--input-type=module',
    '-e',
    "import {writeFileSync,unlinkSync} from 'node:fs'; import {join} from 'node:path'; const file=join(process.env.HOME,'.malt-smoke-write'); writeFileSync(file,'fixture',{flag:'wx',mode:0o600}); unlinkSync(file);",
  );
  const logs = await exec('docker', [...compose, 'logs', '--no-log-prefix', 'broker'], {
    env: environment,
    timeout: COMMAND_TIMEOUT_MS,
    windowsHide: true,
  });
  const record = logs.stdout.split('\n').find((line) => line.includes('"category":"console"'));
  assert.ok(record !== undefined, 'Container printed its owning console pairing information.');
  const console = z.object({ url: z.string().url(), pairingCode: z.string() }).parse(JSON.parse(record));
  const shell = await fetch(console.url);
  assert.equal(shell.status, 200);
  assert.match(shell.headers.get('content-security-policy') ?? '', /default-src 'self'/v);
  assert.equal((await fetch(`${console.url}/api/snapshot`)).status, 401);
  const pair = await fetch(`${console.url}/api/pair`, {
    method: 'POST',
    headers: { Origin: console.url, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: console.pairingCode }),
  });
  assert.equal(pair.status, 200);
  const cookie = (pair.headers.get('set-cookie') ?? '').split(';', 1)[0] ?? '';
  const headers = { Origin: console.url, Cookie: cookie, 'Content-Type': 'application/json' };
  if (shouldQueue) {
    const control = await fetch(`${console.url}/api/control?project=home`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        operation: 'factory_request',
        input: { objective: 'Docker console persistence proof; dispatch stays disabled.' },
      }),
    });
    assert.equal(control.status, 200);
  }
  const snapshot = await fetch(`${console.url}/api/snapshot?project=home`, { headers });
  assert.equal(snapshot.headers.get('cache-control'), 'no-store');
  const featureShape = z.object({ objective: z.string() });
  const factory = z.object({ active: z.literal(false), features: z.array(featureShape) });
  const state = z.object({ factory }).parse(await snapshot.json());
  assert.ok(
    state.factory.features.some(
      (feature) => feature.objective === 'Docker console persistence proof; dispatch stays disabled.',
    ),
  );
  process.stdout.write('PASS: Container PWA pairing, CSP, authenticated durable control and disabled inference\n');
}

/** Run the smoke scenario. */
async function main(): Promise<void> {
  process.stdout.write(`Starting disposable Compose project ${project}\n`);
  await command('up', '-d', '--build', '--wait');
  await verifyConsole(true);
  const lead = await connect('claude-lead', 'anthropic');
  const worker = await connect('codex-1', 'openai');
  const identity = await worker('mesh_whoami');

  // Explicit idle approval resumes a waiting worker.
  const request = await worker('mesh_work_status');
  const waiting = worker('mesh_wait_for_work', { timeoutMs: 2000, afterRevision: request.revision });
  await lead('mesh_answer_check_in', {
    requestId: request.request_id,
    decision: 'idle',
    reason: 'Wait for the next message.',
  });
  const approval = await waiting;
  assert.equal(approval.reason, 'IDLE_APPROVED');

  // A new message wakes the idle worker and revokes the idle grant.
  const sleeping = worker('mesh_wait_for_work', { timeoutMs: 2000, afterRevision: approval.state?.revision });
  const sent = await lead('mesh_send_message', { to: 'codex-1', body: 'Persist through compose down/up' });
  const wake = await sleeping;
  assert.equal(wake.reason, 'MESSAGES');
  assert.equal(wake.state?.phase, 'CHECKIN_REQUIRED');
  const acknowledged = await lead('mesh_send_message', { to: 'codex-1', body: 'Already processed' });
  await worker('mesh_ack_message', { id: acknowledged.id });
  await worker('mesh_reply', { id: sent.id, body: 'Reply from another MCP process' });
  assert.equal((await lead('mesh_get_messages')).messages?.[0]?.body, 'Reply from another MCP process');
  await closeClients();

  // Nameless sessions join the team of the folder they were launched from.
  const folders = path.join(dataRoot, 'workspaces');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Create only a workspace under this smoke test's disposable bind mount.
  await mkdir(folders);
  try {
    const alpha = path.join(folders, 'alpha');
    const beta = path.join(folders, 'beta');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Inside this test's own temporary directory.
    await mkdir(alpha);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Inside this test's own temporary directory.
    await mkdir(beta);
    const alphaLead = joinSchema.parse(await (await connectSession(alpha))('mesh_join', { role: 'lead' }));
    assert.equal(alphaLead.state.participant, 'orchestrator');
    const alphaWorker = joinSchema.parse(await (await connectSession(alpha))('mesh_join', {}));
    assert.equal(alphaWorker.state.phase, 'AWAITING_LEAD');
    assert.equal(alphaWorker.state.orchestrator?.name, alphaLead.agent.name);
    const betaSession = await connectSession(beta);
    assert.equal(rosterSchema.parse(await betaSession('mesh_list_agents')).length, 0);
    await closeClients();
  } finally {
    // The broker still owns open SQLite files; remove bind-mounted test data
    // only after container shutdown in the outer cleanup.
  }

  // State survives container recreation because the named volume is kept.
  process.stdout.write('Stopping and recreating containers while retaining the named volume\n');
  await command('down');
  await command('up', '-d', '--wait');
  await verifyConsole(false);
  const resumed = await connect('codex-1', 'openai');
  assert.equal((await resumed('mesh_whoami')).id, identity.id);
  assert.equal((await resumed('mesh_work_status')).phase, 'CHECKIN_REQUIRED');
  const inbox = await resumed('mesh_get_messages');
  assert.equal(inbox.messages?.length, 1);
  assert.equal(inbox.messages[0]?.id, sent.id);
  await resumed('mesh_ack_message', { id: sent.id });
  assert.equal((await resumed('mesh_get_messages')).messages?.length, 0);
  process.stdout.write(
    'PASS: Docker MCP wait/resume, explicit idle approval, messaging, workspace sessions, stable identity and persistence\n',
  );
}

try {
  await main();
} finally {
  try {
    await closeClients();
  } finally {
    // Remove ONLY this test's containers and volume.
    await command('down', '--volumes');
    assert.equal(path.dirname(dataRoot), path.resolve(tmpdir()));
    assert.ok(path.basename(dataRoot).startsWith('agentmesh-docker-'));
    await rm(dataRoot, { recursive: true, force: true });
  }
}
