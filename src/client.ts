/**
 * HTTP client for the broker, plus the per-agent session wrapper.
 *
 * {@link rpc} performs one authenticated JSON-RPC request. It never retries:
 * a send that timed out may still have committed, so retrying could deliver a
 * message twice. Every request uses a fresh connection (`connection: close`),
 * which avoids reusing a dead keep-alive socket right after a broker restart.
 *
 * {@link AgentClient} represents one live agent session: it loads (or creates)
 * the agent's durable identity, registers with a fresh session UUID, attaches
 * credentials to every call, renews presence with heartbeats, and disconnects
 * cleanly on close.
 *
 * @file
 */

import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { loadIdentity } from './config.ts';
import { log } from './log.ts';
import { MeshError, WAIT_TIMEOUT_DEFAULT_MS, isMeshErrorCode } from './protocol.ts';

import type { MeshConfig } from './config.ts';
import type { AgentRow } from './database.ts';
import type { Operation, OperationRawInput } from './protocol.ts';
import type { Credentials, StoreOperation, StoreResults } from './store.ts';
import type { WaitResult } from './waiters.ts';

/** Network deadline for ordinary requests, in milliseconds. */
const REQUEST_TIMEOUT_MS = 5000;

/**
 * Extra network allowance for a wait beyond its own timeout, so the broker's
 * timeout response always arrives before the client gives up.
 */
const WAIT_NETWORK_GRACE_MS = 5000;

/** Operations an agent session can call (registration happens on connect). */
export type ClientOperation = StoreOperation | 'wait_for_work';

/** The result type of every operation an agent session can call. */
export interface ClientResults extends StoreResults {
  /** The wake result of a wait. */
  readonly wait_for_work: WaitResult;
}

/** Options for a single request. */
export interface RpcOptions {
  /** Agent credentials; omitted for project-token-only (public) calls. */
  readonly credentials?: Credentials | undefined;
  /** Cancels the request (for example when an MCP host cancels a tool call). */
  readonly signal?: AbortSignal | undefined;
}

/** Options for a call made through an {@link AgentClient}. */
export interface CallOptions {
  /** Cancels the request (for example when an MCP host cancels a tool call). */
  readonly signal?: AbortSignal | undefined;
}

/** The body of a failed broker response. */
const errorEnvelopeSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

/** Extracts a wait's requested timeout from otherwise unvalidated input. */
const waitTimeoutSchema = z.object({ timeoutMs: z.number() }).partial();

/**
 * Compute the network deadline for a request.
 *
 * Long-poll waits need a longer deadline than ordinary RPCs: the requested
 * wait time plus a grace period.
 *
 * @param operation - The operation being requested.
 * @param input - The request input, consulted for a wait's `timeoutMs`.
 * @returns The deadline in milliseconds.
 */
function deadlineFor(operation: Operation, input: unknown): number {
  if (operation !== 'wait_for_work') {
    return REQUEST_TIMEOUT_MS;
  }
  const parsed = waitTimeoutSchema.safeParse(input);
  return (parsed.data?.timeoutMs ?? WAIT_TIMEOUT_DEFAULT_MS) + WAIT_NETWORK_GRACE_MS;
}

/**
 * Determine whether a decoded body is a success envelope.
 *
 * @param body - The decoded JSON body.
 * @returns Whether the body is an object with a `result` key.
 */
function hasResult(body: unknown): body is { readonly result: unknown } {
  return typeof body === 'object' && body !== null && 'result' in body;
}

/**
 * Decode a broker response body into a result or a thrown {@link MeshError}.
 *
 * @param response - The HTTP response.
 * @returns The operation's result.
 * @throws {MeshError} The broker's error, or HTTP_ERROR for anything
 *   unexpected (non-JSON bodies, unknown codes).
 */
async function decodeResponse(response: Response): Promise<unknown> {
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new MeshError('HTTP_ERROR', 'Broker returned a non-JSON response.', {
      status: response.status,
      cause: error,
    });
  }
  // Detect failure explicitly. (A schema such as `{ result: z.unknown() }`
  // would also match an error body, because `unknown` accepts a missing key.)
  const failure = errorEnvelopeSchema.safeParse(body);
  if (!failure.success && response.ok && hasResult(body)) {
    return body.result;
  }
  const remote = failure.data?.error;
  throw new MeshError(
    isMeshErrorCode(remote?.code) ? remote.code : 'HTTP_ERROR',
    remote?.message ?? 'Broker request failed.',
    { status: response.status },
  );
}

/**
 * Perform one authenticated RPC request against the broker.
 *
 * @param config - The project configuration (URL, token, project ID).
 * @param operation - The operation to perform.
 * @param input - The operation input; validated by the broker.
 * @param options - Agent credentials (omitted for public calls) and an
 *   optional cancellation signal.
 * @returns The operation's result.
 * @throws {MeshError} WAIT_CANCELLED when cancelled, BROKER_UNAVAILABLE when
 *   the broker cannot be reached, or the broker's own error.
 */
export async function rpc(
  config: MeshConfig,
  operation: Operation,
  input: unknown = {},
  options: RpcOptions = {},
): Promise<unknown> {
  log('debug', 'bridge', 'rpc_started', { operation });
  const { credentials, signal } = options;
  // The caller's cancellation is COMBINED with, not substituted for, the
  // network deadline.
  const deadline = AbortSignal.timeout(deadlineFor(operation, input));
  const combined = AbortSignal.any(signal === undefined ? [deadline] : [deadline, signal]);
  const url = new URL('/rpc', config.url);
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      signal: combined,
      headers: {
        'content-type': 'application/json',
        connection: 'close',
        authorization: `Bearer ${config.token}`,
        'x-agentmesh-project': config.projectId,
      },
      body: JSON.stringify({ operation, input, credentials }),
    });
  } catch (error) {
    if (signal?.aborted === true) {
      throw new MeshError('WAIT_CANCELLED', 'Request cancelled.', { cause: error });
    }
    throw new MeshError(
      'BROKER_UNAVAILABLE',
      'Cannot reach Agent Mesh. Start the broker and check the project configuration.',
      { cause: error },
    );
  }
  const result = await decodeResponse(response);
  log('debug', 'bridge', 'rpc_completed', { operation });
  return result;
}

/** How an agent session describes itself when registering. */
export interface AgentClientOptions {
  /** The agent's unique name within the project. */
  readonly name: string;
  /** Model provider label, for example `anthropic`. */
  readonly provider?: string | undefined;
  /** Runtime label, for example `claude-code`. */
  readonly runtime?: string | undefined;
  /** Role label; `lead` bootstraps the orchestrator, `observer` opts out. */
  readonly role?: string | undefined;
}

/** One live agent session. See the file overview. */
export class AgentClient {
  /** Aborted on close, cancelling every in-flight request of this session. */
  private readonly shutdown = new AbortController();

  /** The project configuration. */
  private readonly config: MeshConfig;

  /** Registration details, including the durable secret and session UUID. */
  private readonly registration: {
    readonly name: string;

    readonly secret: string;

    readonly sessionId: string;

    readonly provider: string;

    readonly runtime: string;

    readonly role: string;
  };

  /** Credentials obtained on registration; `undefined` until connected. */
  private credentials: Credentials | undefined;

  /** The heartbeat timer, while heartbeats run. */
  private heartbeat: NodeJS.Timeout | undefined;

  /** The heartbeat request currently in flight, if any. */
  private pendingHeartbeat: Promise<void> | undefined;

  /** Whether {@link AgentClient.close} has been called. */
  private closed = false;

  /**
   * Prepare a session for an agent, loading or creating its identity.
   *
   * @param config - The project configuration.
   * @param options - The agent's name and descriptive labels.
   */
  public constructor(config: MeshConfig, options: AgentClientOptions) {
    this.config = config;
    this.registration = {
      ...loadIdentity(config, options.name),
      provider: options.provider ?? 'unknown',
      runtime: options.runtime ?? 'attached',
      role: options.role ?? 'generalist',
      // A new session UUID on every launch: the lease that fences out any
      // older bridge still running under the same identity.
      sessionId: randomUUID(),
    };
  }

  /**
   * Register this session with the broker.
   *
   * @returns The registered agent's public row.
   */
  public async connect(): Promise<AgentRow> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- The broker in this same code base returns Store.register's AgentRow for `register`.
    const agent = (await rpc(this.config, 'register', this.registration)) as AgentRow;
    this.credentials = { agentId: agent.id, secret: this.registration.secret, sessionId: this.registration.sessionId };
    log('info', 'bridge', 'registered', { actor: agent.id, name: agent.name, status: agent.status });
    return agent;
  }

  /**
   * Call an operation with compile-time checked input and a typed result.
   *
   * @param operation - The operation to call.
   * @param input - The operation input.
   * @param options - Optional cancellation signal.
   * @returns The operation's typed result.
   */
  public async call<O extends ClientOperation>(
    operation: O,
    input: OperationRawInput<O>,
    options: CallOptions = {},
  ): Promise<ClientResults[O]> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- The broker in this same code base produces StoreResults/WaitResult for each operation; ClientResults is that contract.
    return (await this.request(operation, input, options)) as ClientResults[O];
  }

  /**
   * Call an operation with input that has not been statically typed, such as
   * MCP tool arguments. The broker validates the input.
   *
   * @param operation - The operation to call.
   * @param input - The untyped operation input.
   * @param options - Optional cancellation signal.
   * @returns The operation's untyped result.
   * @throws {MeshError} CLIENT_CLOSED after close, or any RPC failure.
   */
  public async request(operation: ClientOperation, input: unknown, options: CallOptions = {}): Promise<unknown> {
    if (this.closed) {
      throw new MeshError('CLIENT_CLOSED', 'This bridge is closed.');
    }
    // Connect lazily so one-shot CLI commands need no explicit connect step.
    const credentials = this.credentials ?? (await this.connectForCredentials());
    return rpc(this.config, operation, input, {
      credentials,
      signal: AbortSignal.any([this.shutdown.signal, ...(options.signal === undefined ? [] : [options.signal])]),
    });
  }

  /**
   * Start renewing presence in the background.
   *
   * The bridge owns presence renewal, independently of whether its model is
   * working, waiting inside a tool call, or idle-approved by the lead.
   *
   * Failures are logged, not thrown: a missed heartbeat is retried on the next
   * tick, and a lasting outage simply lets the lease expire.
   */
  public startHeartbeat(): void {
    if (this.heartbeat !== undefined || this.closed) {
      return;
    }
    this.heartbeat = setInterval(() => {
      // Never stack heartbeats: skip a tick while the previous one is pending.
      this.pendingHeartbeat ??= this.beat();
    }, this.config.heartbeatMs);
    // Heartbeats alone must never keep the process alive.
    this.heartbeat.unref();
  }

  /** Stop heartbeats, cancel in-flight requests and mark the agent offline. */
  public async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    clearInterval(this.heartbeat);
    this.shutdown.abort();
    await this.pendingHeartbeat;
    // Use a fresh bounded RPC: the session's own signal was just cancelled.
    if (this.credentials !== undefined) {
      try {
        await rpc(this.config, 'disconnect', {}, { credentials: this.credentials });
      } catch {
        // Best effort: an unreachable broker will expire the lease anyway.
      }
    }
    log('info', 'bridge', 'closed', { actor: this.credentials?.agentId });
  }

  /**
   * Connect and return the resulting credentials.
   *
   * @returns The session's credentials.
   * @throws {Error} When registration did not produce credentials.
   */
  private async connectForCredentials(): Promise<Credentials> {
    await this.connect();
    if (this.credentials === undefined) {
      throw new Error('Registration did not produce credentials.');
    }
    return this.credentials;
  }

  /**
   * Send one heartbeat, logging (not throwing) failures.
   *
   * @returns A promise settled when the heartbeat completes or fails.
   */
  private async beat(): Promise<void> {
    try {
      await this.call('heartbeat', {});
    } catch (error) {
      log('warn', 'bridge', 'heartbeat_failed', { code: error instanceof MeshError ? error.code : 'ERROR' });
    } finally {
      this.pendingHeartbeat = undefined;
    }
  }
}
