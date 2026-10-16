/**
 * The MALT broker: a loopback HTTP JSON-RPC service.
 *
 * The broker is the single long-running process. It serves its home project
 * plus any number of workspace teams (see teams.ts), each with its own
 * {@link Store} (and therefore SQLite file) and waiter registry. It validates
 * every request, routes it to its team, and wakes that team's parked waiters
 * after each committed change.
 *
 * HTTP surface:
 *
 * - `GET /health` returns `{ ok: true, version }` for health checks.
 * - `POST /rpc` takes `{ operation, input, credentials }` and returns either
 *   `{ result }` or `{ error: { code, message } }` with a matching status.
 *   An `x-agentmesh-team` header addresses a workspace team; without it the
 *   request addresses the home project.
 *
 * Request pipeline, in order: reject browser origins (no CORS, ever), route,
 * select the team, verify its bearer token and project ID, read a bounded JSON body,
 * validate the envelope and operation, validate the input, expire stale
 * presence, authenticate the agent (except for public operations), execute,
 * and finally notify waiters.
 *
 * Errors: a {@link MeshError} is returned with its code and status. Any other
 * error is an internal fault; its details are logged by code only and hidden
 * from the caller as `INTERNAL`.
 *
 * @file
 */

import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';

import { z } from 'zod/v3';

import { FactoryService } from './factory/service.ts';
import { isTerminalOperation } from './factory/terminal-schema.ts';
import { ProjectGitHub } from './github.ts';
import { ProjectLearning } from './learning.ts';
import { log } from './log.ts';
import {
  MeshError,
  PROJECT_OPERATION_TIMEOUT_MS,
  errorStatus,
  isGitHubOperation,
  isFactoryOperation,
  isLearningOperation,
  isOperation,
  parseInput,
} from './protocol.ts';
import { Store, isPublicOperation, isStoreOperation } from './store.ts';
import { createTeam, listTeams, loadTeam, normalizeWorkspace } from './teams.ts';
import { Waiters } from './waiters.ts';

import type { MeshConfig } from './config.ts';
import type { FactoryOperation } from './factory/schema.ts';
import type { TerminalOperation } from './factory/terminal-schema.ts';
import type { GitHubRunner } from './github.ts';
import type { GitHubOperation, LearningOperation, Operation } from './protocol.ts';
import type { PresentedCredentials } from './store.ts';
import type { TeamAccess, TeamConfig } from './teams.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** The version reported by the health endpoint. */
const VERSION = '0.1.0';

/** Largest accepted request body, in bytes (256 KiB). */
const MAX_BODY_BYTES = 262_144;

/** Deadline for receiving a complete request (headers and body), in ms. */
const REQUEST_TIMEOUT_MS = 10_000;

/** Idle socket timeout for ordinary requests, in milliseconds. */
const SOCKET_TIMEOUT_MS = 15_000;

/** Grace added to a wait's own timeout before its socket times out, in ms. */
const WAIT_SOCKET_GRACE_MS = 5000;

/** Longest interval between presence sweeps, in milliseconds. */
const MAX_SWEEP_INTERVAL_MS = 5000;

/** HTTP status for a successful response. */
const HTTP_OK = 200;

/** Mutations requiring the current workspace's designated lead. */
const LEAD_PROJECT_OPERATIONS: ReadonlySet<Operation> = new Set([
  'github_connect',
  'github_create_issue',
  'github_set_status',
  'learning_set_skill_state',
]);

/** Pure local inspection does not append new events or wake workers. */
const READ_PROJECT_OPERATIONS: ReadonlySet<Operation> = new Set([
  'github_status',
  'learning_status',
  'learning_read_skill',
]);

/** Port implied by an `http:` URL that names no port. */
const DEFAULT_HTTP_PORT = 80;

/**
 * Agent credentials. Absent or `null` means "no credentials"; missing fields
 * are allowed here and simply fail authentication later.
 */
const credentialsSchema = z
  .object({ agentId: z.string(), secret: z.string(), sessionId: z.string() })
  .partial()
  .nullish()
  .transform((value) => value ?? undefined);

/**
 * Interpret the envelope's credentials field.
 *
 * @param raw - The untrusted `credentials` value.
 * @returns The credentials, `undefined` when none were presented, or an empty
 *   object (which always fails authentication) when they are malformed.
 */
function readCredentials(raw: unknown): PresentedCredentials | undefined {
  const parsed = credentialsSchema.safeParse(raw);
  return parsed.success ? parsed.data : {};
}

/** The RPC request envelope. Field contents are validated separately. */
const envelopeSchema = z.object({
  operation: z.unknown(),
  input: z.unknown().optional(),
  credentials: z.unknown().optional(),
});

/** Options for {@link startBroker}. */
export interface BrokerOptions {
  /** Optional GitHub adapter factory for isolated integration tests. */
  readonly githubRunner?: ((config: MeshConfig) => GitHubRunner) | undefined;
  /** Interface to bind; defaults to loopback. Docker binds `0.0.0.0`. */
  readonly host?: string | undefined;
  /** Port to bind; defaults to the configured URL's port. Tests pass 0. */
  readonly port?: number | undefined;
  /** Clock override for the store, used by tests. */
  readonly now?: (() => number) | undefined;
}

/** One team the broker serves: its configuration, store and parked waits. */
export interface Team {
  /** Bounded project factory supervisor. */
  readonly factory: FactoryService;
  /** This project's durable lessons, research and shared skill library. */
  readonly learning: ProjectLearning;
  /** This workspace's GitHub Project integration and operation queue. */
  readonly github: ProjectGitHub;
  /** The team's configuration (token, project ID, ...). */
  readonly config: MeshConfig;
  /** The team's store. */
  readonly store: Store;
  /** The team's registry of parked waits. */
  readonly waiters: Waiters;
}

/** A running broker. */
export interface Broker {
  /** The home project's store. */
  readonly store: Store;
  /** The HTTP server. */
  readonly server: http.Server;
  /** The home project's registry of parked waits. */
  readonly waiters: Waiters;
  /** Workspace teams opened since the broker started, keyed by slug. */
  readonly teams: ReadonlyMap<string, Team>;
  /** The bound port (useful when port 0 was requested). */
  readonly port: number;
  /** Cancel waits, stop accepting requests and close the database. */
  readonly close: () => Promise<void>;
}

/** Everything a request handler needs, created once per broker. */
interface BrokerContext {
  /** Optional injected per-workspace GitHub adapter. */
  readonly githubRunner: ((config: MeshConfig) => GitHubRunner) | undefined;
  /** The home project, addressed by requests without a team header. */
  readonly home: Team;
  /** Workspace teams opened so far, keyed by slug; opened lazily. */
  readonly teams: Map<string, Team>;
  /** Clock override for every store, used by tests. */
  readonly now: (() => number) | undefined;
}

/**
 * Open a workspace team's store and register it with the broker.
 *
 * @param context - The broker context.
 * @param config - The team's configuration.
 * @returns The opened team.
 */
function openTeamStore(context: BrokerContext, config: TeamConfig): Team {
  if (config.projectId === context.home.config.projectId) {
    return context.home;
  }
  const store = new Store(config, { now: context.now });
  const github = new ProjectGitHub(config, context.githubRunner?.(config));
  const learning = new ProjectLearning(config, context.githubRunner?.(config));
  const team: Team = {
    config,
    store,
    waiters: new Waiters(store),
    github,
    learning,
    factory: new FactoryService(config, store, { github, learning }, { home: context.home.config.root }),
  };
  context.teams.set(config.team, team);
  team.factory.resume();
  log('info', 'broker', 'team_opened', { team: config.team });
  return team;
}

/**
 * Restore active registered target factories even without a browser or model session.
 * Inactive stores are closed immediately rather than kept as idle memory consumers.
 *
 * @param context - Sole broker and its durable workspace registry.
 */
async function restoreFactories(context: BrokerContext): Promise<void> {
  const registered = await listTeams(context.home.config);
  for (const reference of registered) {
    try {
      const config = loadTeam(context.home.config, reference.team);
      if (config.projectId === context.home.config.projectId) {
        continue;
      }
      const team = openTeamStore(context, config);
      if (!team.factory.repository.active()) {
        // eslint-disable-next-line no-await-in-loop -- Restore projects one at a time and close inactive stores before allocating the next.
        await team.factory.close();
        team.store.close();
        context.teams.delete(reference.team);
      }
    } catch {
      log('error', 'broker', 'factory_restore_failed', { team: reference.team });
    }
  }
}

/**
 * Open (creating on first use) the team of a workspace folder.
 *
 * @param context - The broker context.
 * @param input - The raw `open_team` input.
 * @returns What a client needs to address the team.
 */
function openWorkspaceTeam(context: BrokerContext, input: unknown): TeamAccess {
  const workspace = normalizeWorkspace(parseInput('open_team', input).workspace);
  const config = createTeam(context.home.config, workspace);
  const team =
    config.projectId === context.home.config.projectId
      ? context.home
      : (context.teams.get(config.team) ?? openTeamStore(context, config));
  return {
    team: team === context.home ? '' : config.team,
    name: team.config.name,
    workspace: team.config.workspace ?? workspace.display,
    storageRoot: team.config.root,
    projectId: team.config.projectId,
    token: team.config.token,
  };
}

/**
 * Compare a presented secret with the expected one in constant time.
 *
 * @param presented - The value supplied by the client, if any.
 * @param expected - The correct value.
 * @returns Whether the two are identical.
 */
function isSameSecret(presented: string | undefined, expected: string): boolean {
  const left = Buffer.from(presented ?? '');
  const right = Buffer.from(expected);
  // timingSafeEqual requires equal lengths; a length mismatch is a mismatch.
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Read and parse a JSON request body of bounded size.
 *
 * @param request - The incoming request.
 * @returns The parsed, unvalidated JSON value.
 * @throws {MeshError} CONTENT_TYPE, TOO_LARGE or INVALID_JSON.
 */
async function readJson(request: IncomingMessage): Promise<unknown> {
  if (request.headers['content-type']?.startsWith('application/json') !== true) {
    throw new MeshError('CONTENT_TYPE', 'Expected application/json.');
  }
  let size = 0;
  const chunks: Buffer[] = [];
  // Accumulate chunk by chunk so an oversized body is rejected as soon as it
  // crosses the limit, without buffering the remainder.
  for await (const chunk of request) {
    const data: unknown = chunk;
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
    size += bytes.length;
    if (size > MAX_BODY_BYTES) {
      throw new MeshError('TOO_LARGE', 'Request exceeds 256 KiB.');
    }
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    throw new MeshError('INVALID_JSON', 'Malformed JSON.', { cause: error });
  }
}

/**
 * Write a JSON response unless the client has already gone away.
 *
 * @param response - The server response.
 * @param status - The HTTP status code.
 * @param body - The JSON-serialisable body.
 */
function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.destroyed) {
    return;
  }
  response.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(body));
}

/**
 * Run a `wait_for_work` request, cancelling the wait if the client leaves.
 *
 * @param context - The team the wait belongs to.
 * @param input - The raw wait input.
 * @param credentials - The waiting agent's credentials.
 * @param response - The response, whose closure cancels the wait.
 * @returns The wake result.
 */
async function handleWait(
  context: Team,
  input: unknown,
  credentials: PresentedCredentials | undefined,
  response: ServerResponse,
): Promise<unknown> {
  const parsed = parseInput('wait_for_work', input);
  // Authenticate before parking, so bad credentials fail immediately.
  context.store.authenticate(credentials);
  const cancellation = new AbortController();

  const onClose = (): void => {
    cancellation.abort();
  };
  response.once('close', onClose);
  // The socket must outlive the wait itself; see WAIT_SOCKET_GRACE_MS.
  response.setTimeout(parsed.timeoutMs + WAIT_SOCKET_GRACE_MS);
  try {
    return await context.waiters.wait(credentials, parsed, cancellation.signal);
  } finally {
    response.removeListener('close', onClose);
  }
}

/**
 * Execute one validated RPC operation of a team.
 *
 * @param context - The team the operation belongs to.
 * @param operation - The validated operation name.
 * @param input - The raw operation input.
 * @param credentials - The caller's agent credentials, if any.
 * @returns The operation's JSON-serialisable result.
 * @throws {MeshError} For any validation, authentication or domain failure.
 */
function executeOperation(
  context: Team,
  operation: Exclude<
    Operation,
    | FactoryOperation
    | TerminalOperation
    | GitHubOperation
    | LearningOperation
    | 'list_teams'
    | 'open_team'
    | 'wait_for_work'
  >,
  input: unknown,
  credentials: PresentedCredentials | undefined,
): unknown {
  const { store } = context;
  if (!isStoreOperation(operation)) {
    // The only remaining non-store operation is registration.
    return store.register(parseInput('register', input));
  }
  // Validate before authenticating, so malformed input is always reported
  // as INVALID_INPUT regardless of the credentials presented.
  const parsed = parseInput(operation, input);
  // Public operations accept project-token-only callers; if credentials ARE
  // presented, they must still be valid.
  const actor = credentials === undefined && isPublicOperation(operation) ? null : store.authenticate(credentials);
  // Lead replacement is a human control authenticated by the project token.
  // It is intentionally NOT available to agents (nor exported as an MCP tool).
  if (operation === 'set_lead' && credentials !== undefined) {
    throw new MeshError('HUMAN_CONTROL_REQUIRED', 'Use the human CLI to replace the orchestrator.');
  }
  return store.executeRequest(operation, parsed, actor);
}

/**
 * Reject all agent authority before forwarding an operator-only terminal control.
 *
 * @param team - Authenticated project.
 * @param operation - Validated terminal operation.
 * @param envelope - Untrusted input and optional presented credentials.
 * @param response - Owned HTTP response.
 * @returns Project-fenced terminal result.
 * @throws {MeshError} For agent-credentialed calls.
 */
async function handleTerminal(
  team: Team,
  operation: TerminalOperation,
  envelope: { input?: unknown; credentials?: unknown },
  response: ServerResponse,
): Promise<unknown> {
  const input = envelope.input ?? {};
  parseInput(operation, input);
  if (envelope.credentials !== undefined) {
    throw new MeshError('HUMAN_CONTROL_REQUIRED', 'Terminal controls require an operator, never an agent session.');
  }
  response.setTimeout(PROJECT_OPERATION_TIMEOUT_MS);
  if (operation !== 'terminal_read') {
    return team.factory.terminalControl(operation, input);
  }
  const controller = new AbortController();
  response.once('close', () => {
    controller.abort();
  });
  return team.factory.terminals.control(operation, input, controller.signal);
}

/**
 * Handle one `POST /rpc` request: authenticate its team, then run it.
 *
 * @param context - The broker context.
 * @param request - The incoming request.
 * @param response - The server response (used to detect disconnects).
 * @param setOperation - Records the operation name for diagnostics.
 * @returns The operation's JSON-serialisable result.
 * @throws {MeshError} For any request, validation or domain failure.
 */
async function handleRpc(
  context: BrokerContext,
  request: IncomingMessage,
  response: ServerResponse,
  setOperation: (name: Operation) => void,
): Promise<unknown> {
  const team = authenticateTeam(context, request);
  const envelope = envelopeSchema.safeParse(await readJson(request));
  if (!envelope.success) {
    throw new MeshError('INVALID_REQUEST', 'Expected an RPC object.');
  }
  const { operation, input = {} } = envelope.data;
  if (!isOperation(operation)) {
    throw new MeshError('UNKNOWN_OPERATION', 'Unknown operation.');
  }
  setOperation(operation);
  log('debug', 'broker', 'rpc_received', { operation, team: team.config.team });
  if (operation === 'open_team' || operation === 'list_teams') {
    // Team management spans teams, so only the home project's token grants it.
    if (team !== context.home) {
      throw new MeshError('UNKNOWN_OPERATION', 'Team operations are available only on the home project.');
    }
    return operation === 'open_team' ? openWorkspaceTeam(context, input) : listTeams(context.home.config);
  }
  if (isTerminalOperation(operation)) {
    return handleTerminal(team, operation, envelope.data, response);
  }
  const credentials = readCredentials(envelope.data.credentials);

  // Presence expiry runs before every operation so registration and
  // authentication always see current leases.
  team.store.expire();
  if (isFactoryOperation(operation)) {
    parseInput(operation, input);
    assertFactoryAuthority(team, operation, credentials);
    response.setTimeout(PROJECT_OPERATION_TIMEOUT_MS);
    return team.factory.execute(
      operation,
      input,
      credentials === undefined ? null : team.store.authenticate(credentials),
    );
  }
  if (isLearningOperation(operation) || isGitHubOperation(operation)) {
    response.setTimeout(PROJECT_OPERATION_TIMEOUT_MS);
    return handleProjectOperation(team, operation, input, credentials);
  }
  if (operation === 'wait_for_work') {
    return handleWait(team, input, credentials, response);
  }
  const result = executeOperation(team, operation, input, credentials);
  // Every store mutation is a synchronous, already COMMITTED transaction, so
  // waiters woken here can never observe partial state.
  team.waiters.notify();
  return result;
}

/**
 * Authenticate role controls independently of their dispatch transport.
 *
 * @param team - Selected project.
 * @param operation - Validated factory operation.
 * @param credentials - Optional attached agent identity.
 * @throws {MeshError} When an agent attempts an operator-only operation.
 */
function assertFactoryAuthority(team: Team, operation: Operation, credentials: PresentedCredentials | undefined): void {
  if (credentials === undefined) {
    return;
  }
  if (['factory_skill_decide', 'factory_export_maintenance', 'factory_recover'].includes(operation)) {
    team.store.authenticate(credentials);
    throw new MeshError(
      'NOT_ORCHESTRATOR',
      'Only the human operator may approve skill changes, objective recovery or cross-project maintenance.',
    );
  }
  const actor = team.store.authenticate(credentials);
  if (
    operation !== 'factory_status' &&
    operation !== 'factory_read_source' &&
    operation !== 'factory_progress' &&
    actor !== team.store.coordination.leadId()
  ) {
    throw new MeshError('NOT_ORCHESTRATOR', 'Only the operator or designated project lead controls the factory.');
  }
}

/**
 * Execute external or file-backed project coordination without holding SQLite.
 *
 * @param team - Current workspace's services.
 * @param operation - GitHub or learning operation.
 * @param input - Untrusted RPC input.
 * @param credentials - Authenticated bridge identity.
 * @returns Project-scoped operation result.
 * @throws {MeshError} For invalid inputs, failed authentication or missing authority.
 */
async function handleProjectOperation(
  team: Team,
  operation: GitHubOperation | LearningOperation,
  input: unknown,
  credentials: PresentedCredentials | undefined,
): Promise<unknown> {
  parseInput(operation, input);
  if (credentials !== undefined && operation === 'learning_set_skill_state') {
    throw new MeshError('NOT_ORCHESTRATOR', 'Project skill activation and retirement require the human operator.');
  }
  const actor = credentials === undefined ? null : team.store.authenticate(credentials);
  if (
    credentials !== undefined &&
    LEAD_PROJECT_OPERATIONS.has(operation) &&
    team.store.coordination.leadId() !== actor
  ) {
    throw new MeshError(
      'NOT_ORCHESTRATOR',
      "Only this workspace's designated lead may change GitHub tickets or adopt project skills.",
    );
  }
  const result = isLearningOperation(operation)
    ? await team.learning.execute(operation, input, actor ?? '')
    : await team.github.execute(operation, input);
  if (!READ_PROJECT_OPERATIONS.has(operation)) {
    team.store.transaction(() => {
      team.store.event('PROJECT_OPERATION_COMPLETED', actor, { operation });
    });
    team.waiters.notify();
  }
  return result;
}

/**
 * Verify that a request carries a team's bearer token and project ID.
 *
 * @param config - The addressed team's configuration.
 * @param request - The incoming request.
 * @throws {MeshError} UNAUTHORIZED or WRONG_PROJECT.
 */
function assertProjectCredentials(config: MeshConfig, request: IncomingMessage): void {
  // The project token proves the caller can read this project's files.
  if (!isSameSecret(request.headers.authorization, `Bearer ${config.token}`)) {
    throw new MeshError('UNAUTHORIZED', 'Project authentication required.');
  }
  // The project ID stops a token from one team being replayed at another.
  if (request.headers['x-agentmesh-project'] !== config.projectId) {
    throw new MeshError('WRONG_PROJECT', 'Project identity does not match.');
  }
}

/**
 * Enforce the transport-level rules every RPC request must satisfy and
 * select the team it addresses.
 *
 * @param context - The broker context.
 * @param request - The incoming request.
 * @returns The authenticated team.
 * @throws {MeshError} NOT_FOUND, UNKNOWN_TEAM, UNAUTHORIZED or WRONG_PROJECT.
 */
function authenticateTeam(context: BrokerContext, request: IncomingMessage): Team {
  if (request.method !== 'POST' || request.url !== '/rpc') {
    throw new MeshError('NOT_FOUND', 'Unknown endpoint.');
  }
  const slug = request.headers['x-agentmesh-team'];
  if (slug === undefined) {
    assertProjectCredentials(context.home.config, request);
    return context.home;
  }
  if (Array.isArray(slug)) {
    throw new MeshError('UNKNOWN_TEAM', 'No such team.');
  }
  // Only the team's configuration is read until the request authenticates;
  // its store (and SQLite file) opens afterwards.
  const opened = context.teams.get(slug);
  const config = opened?.config ?? loadTeam(context.home.config, slug);
  assertProjectCredentials(config, request);
  return opened ?? openTeamStore(context, { ...config, team: slug });
}

/**
 * Route a request and write its successful response.
 *
 * @param context - The broker context.
 * @param request - The incoming request.
 * @param response - The server response.
 * @param setOperation - Records the operation name for diagnostics.
 * @throws {MeshError} For any request, validation or domain failure; the
 *   caller maps it to an error response.
 */
async function respond(
  context: BrokerContext,
  request: IncomingMessage,
  response: ServerResponse,
  setOperation: (name: Operation) => void,
): Promise<void> {
  const record = request;
  // No browser-origin requests and no CORS: a web page must never be able to
  // drive the broker, even though it listens on loopback.
  if (record.headers.origin !== undefined) {
    throw new MeshError('FORBIDDEN_ORIGIN', 'Browser requests are not supported.');
  }
  if (record.method === 'GET' && record.url === '/health') {
    sendJson(response, HTTP_OK, { ok: true, version: VERSION });
    return;
  }
  const result = await handleRpc(context, record, response, setOperation);
  sendJson(response, HTTP_OK, { result });
}

/**
 * Handle one HTTP request end to end, including error mapping and logging.
 *
 * @param context - The broker context.
 * @param request - The incoming request.
 * @param response - The server response.
 */
async function handleRequest(
  context: BrokerContext,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const started = Date.now();
  let operationName = 'unknown';
  try {
    await respond(context, request, response, (name) => {
      operationName = name;
    });
  } catch (error) {
    const isKnown = error instanceof MeshError;
    const code = isKnown ? error.code : 'INTERNAL';
    log(isKnown ? 'warn' : 'error', 'broker', 'rpc_failed', { operation: operationName, code });
    sendJson(response, isKnown ? error.status : errorStatus('INTERNAL'), {
      error: { code, message: isKnown ? error.message : 'Internal broker error.' },
    });
  } finally {
    if (request.url !== '/health') {
      log('debug', 'broker', 'rpc_finished', {
        operation: operationName,
        status: response.statusCode,
        elapsedMs: Date.now() - started,
      });
    }
  }
}

/**
 * Start a broker for a home project and begin listening.
 *
 * @param config - The home project's configuration.
 * @param options - Bind address, port and clock overrides.
 * @returns The running broker.
 * @throws {Error} When the database cannot be opened or the port is in use.
 */
export async function startBroker(config: MeshConfig, options: BrokerOptions = {}): Promise<Broker> {
  const host = options.host ?? '127.0.0.1';
  const configuredUrl = new URL(config.url);
  const urlPort = configuredUrl.port;
  const port = options.port ?? (urlPort === '' ? DEFAULT_HTTP_PORT : Number(urlPort));
  const store = new Store(config, { now: options.now });
  const waiters = new Waiters(store);
  const github = new ProjectGitHub(config, options.githubRunner?.(config));
  const learning = new ProjectLearning(config, options.githubRunner?.(config));
  const context: BrokerContext = {
    home: {
      config,
      store,
      waiters,
      github,
      learning,
      factory: new FactoryService(config, store, { github, learning }, { home: config.root }),
    },
    teams: new Map(),
    now: options.now,
    githubRunner: options.githubRunner,
  };
  const allTeams = (): Team[] => [context.home, ...context.teams.values()];

  const server = http.createServer((request, response) => {
    void handleRequest(context, request, response);
  });
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = REQUEST_TIMEOUT_MS;
  server.timeout = SOCKET_TIMEOUT_MS;

  try {
    await listen(server, port, host);
  } catch (error) {
    store.close();
    throw error;
  }

  // Periodically expire silent agents even when no requests arrive, and wake
  // anyone waiting on a presence-dependent state.
  const sweep = setInterval(
    () => {
      for (const team of allTeams()) {
        try {
          team.store.expire();
          team.waiters.notify();
        } catch (error) {
          log('error', 'broker', 'presence_sweep_failed', {
            team: team.config.team,
            code: error instanceof MeshError ? error.code : 'ERROR',
          });
        }
      }
    },
    Math.min(config.heartbeatMs, MAX_SWEEP_INTERVAL_MS),
  );
  // The sweep alone must never keep the process alive.
  sweep.unref();

  const boundPort = boundPortOf(server);
  await restoreFactories(context);
  context.home.factory.resume();
  log('info', 'broker', 'listening', { host, port: boundPort });

  return {
    store,
    server,
    waiters,
    teams: context.teams,
    port: boundPort,
    close: async (): Promise<void> => {
      clearInterval(sweep);
      const teams = allTeams();
      log('info', 'broker', 'shutdown_started', {
        activeWaits: teams.reduce((total, team) => total + team.waiters.pending.size, 0),
      });
      // Fail parked waits first so their responses complete and close() can
      // finish; then stop the server, and only then close the databases.
      for (const team of teams) {
        team.waiters.close();
      }
      await Promise.allSettled(teams.map(async (team) => team.factory.close()));
      await closeServer(server);
      for (const team of teams) {
        team.store.close();
      }
    },
  };
}

/**
 * Start listening, resolving once bound or rejecting on a bind error.
 *
 * @param server - The HTTP server.
 * @param port - The port to bind.
 * @param host - The interface to bind.
 * @returns A promise settled when listening starts or fails.
 */
async function listen(server: http.Server, port: number, host: string): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<undefined>();
  server.once('error', reject);
  server.listen(port, host, () => {
    server.removeListener('error', reject);
    resolve(undefined);
  });
  return promise;
}

/**
 * Stop accepting connections and wait for in-flight requests to finish.
 *
 * @param server - The HTTP server.
 */
async function closeServer(server: http.Server): Promise<void> {
  // Subscribe before closing so the 'close' event cannot be missed.
  const closed = once(server, 'close');
  server.close();
  await closed;
}

/**
 * Read the TCP port a listening server is bound to.
 *
 * @param server - The broker's server, after `listen` succeeded.
 * @returns The TCP port number, which the OS chose when port 0 was requested.
 * @throws {Error} When the server is not bound to a TCP address.
 */
function boundPortOf(server: http.Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Broker is not listening on a TCP port.');
  }
  return address.port;
}
