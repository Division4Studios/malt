/**
 * The Agent Mesh broker: a loopback HTTP JSON-RPC service.
 *
 * The broker is the single long-running process of a team. It owns the
 * {@link Store} (and therefore SQLite), validates every request, and wakes
 * parked waiters after each committed change.
 *
 * HTTP surface:
 *
 * - `GET /health` returns `{ ok: true, version }` for health checks.
 * - `POST /rpc` takes `{ operation, input, credentials }` and returns either
 *   `{ result }` or `{ error: { code, message } }` with a matching status.
 *
 * Request pipeline, in order: reject browser origins (no CORS, ever), route,
 * verify the project bearer token and project ID, read a bounded JSON body,
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

import { z } from 'zod';

import { log } from './log.ts';
import { MeshError, errorStatus, isOperation, parseInput } from './protocol.ts';
import { Store, isPublicOperation, isStoreOperation } from './store.ts';
import { Waiters } from './waiters.ts';

import type { MeshConfig } from './config.ts';
import type { Operation } from './protocol.ts';
import type { PresentedCredentials } from './store.ts';
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
  /** Interface to bind; defaults to loopback. Docker binds `0.0.0.0`. */
  readonly host?: string | undefined;
  /** Port to bind; defaults to the configured URL's port. Tests pass 0. */
  readonly port?: number | undefined;
  /** Clock override for the store, used by tests. */
  readonly now?: (() => number) | undefined;
}

/** A running broker. */
export interface Broker {
  /** The project store. */
  readonly store: Store;
  /** The HTTP server. */
  readonly server: http.Server;
  /** The registry of parked waits. */
  readonly waiters: Waiters;
  /** The bound port (useful when port 0 was requested). */
  readonly port: number;
  /** Cancel waits, stop accepting requests and close the database. */
  readonly close: () => Promise<void>;
}

/** Everything a request handler needs, created once per broker. */
interface BrokerContext {
  /** The project configuration (token, project ID, ...). */
  readonly config: MeshConfig;
  /** The project store. */
  readonly store: Store;
  /** The registry of parked waits. */
  readonly waiters: Waiters;
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
 * @param context - The broker context.
 * @param input - The raw wait input.
 * @param credentials - The waiting agent's credentials.
 * @param response - The response, whose closure cancels the wait.
 * @returns The wake result.
 */
async function handleWait(
  context: BrokerContext,
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
 * Execute one validated RPC operation.
 *
 * @param context - The broker context.
 * @param operation - The validated operation name.
 * @param input - The raw operation input.
 * @param credentials - The caller's agent credentials, if any.
 * @returns The operation's JSON-serialisable result.
 * @throws {MeshError} For any validation, authentication or domain failure.
 */
function executeOperation(
  context: BrokerContext,
  operation: Exclude<Operation, 'wait_for_work'>,
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
 * Handle one `POST /rpc` request after transport-level checks passed.
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
  const envelope = envelopeSchema.safeParse(await readJson(request));
  if (!envelope.success) {
    throw new MeshError('INVALID_REQUEST', 'Expected an RPC object.');
  }
  const { operation, input = {} } = envelope.data;
  if (!isOperation(operation)) {
    throw new MeshError('UNKNOWN_OPERATION', 'Unknown operation.');
  }
  setOperation(operation);
  log('debug', 'broker', 'rpc_received', { operation });
  const credentials = readCredentials(envelope.data.credentials);

  // Presence expiry runs before every operation so registration and
  // authentication always see current leases.
  context.store.expire();
  if (operation === 'wait_for_work') {
    return handleWait(context, input, credentials, response);
  }
  const result = executeOperation(context, operation, input, credentials);
  // Every store mutation is a synchronous, already COMMITTED transaction, so
  // waiters woken here can never observe partial state.
  context.waiters.notify();
  return result;
}

/**
 * Enforce the transport-level rules every RPC request must satisfy.
 *
 * @param context - The broker context.
 * @param request - The incoming request.
 * @throws {MeshError} NOT_FOUND, UNAUTHORIZED or WRONG_PROJECT.
 */
function assertRpcRequest(context: BrokerContext, request: IncomingMessage): void {
  if (request.method !== 'POST' || request.url !== '/rpc') {
    throw new MeshError('NOT_FOUND', 'Unknown endpoint.');
  }
  // The project token proves the caller can read this project's files.
  if (!isSameSecret(request.headers.authorization, `Bearer ${context.config.token}`)) {
    throw new MeshError('UNAUTHORIZED', 'Project authentication required.');
  }
  // The project ID stops a token from one team being replayed at another.
  if (request.headers['x-agentmesh-project'] !== context.config.projectId) {
    throw new MeshError('WRONG_PROJECT', 'Project identity does not match.');
  }
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
  // No browser-origin requests and no CORS: a web page must never be able to
  // drive the broker, even though it listens on loopback.
  if (request.headers.origin !== undefined) {
    throw new MeshError('FORBIDDEN_ORIGIN', 'Browser requests are not supported.');
  }
  if (request.method === 'GET' && request.url === '/health') {
    sendJson(response, HTTP_OK, { ok: true, version: VERSION });
    return;
  }
  assertRpcRequest(context, request);
  const result = await handleRpc(context, request, response, setOperation);
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
 * Start a broker for a project and begin listening.
 *
 * @param config - The project configuration.
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
  const context: BrokerContext = { config, store, waiters };

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
      try {
        store.expire();
        waiters.notify();
      } catch (error) {
        log('error', 'broker', 'presence_sweep_failed', { code: error instanceof MeshError ? error.code : 'ERROR' });
      }
    },
    Math.min(config.heartbeatMs, MAX_SWEEP_INTERVAL_MS),
  );
  // The sweep alone must never keep the process alive.
  sweep.unref();

  const boundPort = boundPortOf(server);
  log('info', 'broker', 'listening', { host, port: boundPort });

  return {
    store,
    server,
    waiters,
    port: boundPort,
    close: async (): Promise<void> => {
      clearInterval(sweep);
      log('info', 'broker', 'shutdown_started', { activeWaits: waiters.pending.size });
      // Fail parked waits first so their responses complete and close() can
      // finish; then stop the server, and only then close the database.
      waiters.close();
      await closeServer(server);
      store.close();
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
 * @returns A promise settled when the server has closed.
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
