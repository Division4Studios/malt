/** @file Paired SSE relay for transient terminal output, never a log sink. */
import { Buffer } from 'node:buffer';
import { once } from 'node:events';

import { z } from 'zod/v3';

import { MeshError } from '../protocol.ts';

import type { ProjectGateway } from './projects.ts';
import type { OperatorSessions } from './security.ts';
import type { TerminalPage } from '../factory/terminal-reads.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** Finite sockets, readers and queued frames. */
const CLIENTS = 8;
/** Concurrent views of a single project terminal. */
const PER_SESSION = 2;
/** JSON escaping cannot create an unbounded pending frame. */
const FRAME_BYTES = 524_288;
/** Disconnect stalled consumers rather than accumulate frames. */
const DRAIN_MS = 5000;
/** Periodic reconnect restores all authorization boundaries. */
const LIFETIME_MS = 120_000;
/** Explicit response codes. */
const HTTP = { ok: 200, invalid: 400, unauthorized: 401, missing: 404, method: 405 } as const;
/** States which can still produce new output. */
const ACTIVE: ReadonlySet<string> = new Set(['requested', 'starting', 'running', 'closing']);
/** Exact stream query. */
const querySchema = z
  .object({
    project: z.string().min(1).default('home'),
    id: z.string().uuid(),
    after: z
      .string()
      .regex(/^\d{1,16}$/v)
      .default('0'),
  })
  .strict();
/** Owned request/session boundary. */
interface Connection {
  /** Paired operator request. */
  readonly request: IncomingMessage;
  /** Owned noncacheable response. */
  readonly response: ServerResponse;
  /** Live cookie authorization. */
  readonly sessions: OperatorSessions;
}
/** Validated selected stream and cursor. */
interface Cursor {
  /** Server-known project scope. */
  readonly project: string;
  /** Project-owned terminal. */
  readonly id: string;
  /** Last delivered safe sequence. */
  after: number;
}

/**
 * Recheck mutable authorization and disconnect state after awaited work.
 *
 * @param connection - Owned response and operator cookie.
 * @param signal - Stream lifetime.
 * @returns Whether private output may still be sent.
 */
function isAuthorized(connection: Connection, signal: AbortSignal): boolean {
  return !signal.aborted && !connection.response.destroyed && connection.sessions.authenticated(connection.request);
}

/**
 * Emit one bounded page and wait for drain before requesting another.
 *
 * @param response - Owned SSE socket.
 * @param page - Validated safe terminal output.
 * @param signal - Stream lifetime.
 * @throws {Error} For oversized or stalled output.
 */
async function emit(response: ServerResponse, page: TerminalPage, signal: AbortSignal): Promise<void> {
  const frame = `id: ${String(page.nextCursor)}\nevent: terminal\ndata: ${JSON.stringify(page)}\n\n: heartbeat\n\n`;
  if (Buffer.byteLength(frame) > FRAME_BYTES) {
    throw new Error('Terminal frame exceeded its escaped byte ceiling.');
  }
  if (!response.headersSent) {
    response.writeHead(HTTP.ok, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    response.write('retry: 2000\n\n');
  }
  if (!response.write(frame)) {
    await once(response, 'drain', { signal: AbortSignal.any([signal, AbortSignal.timeout(DRAIN_MS)]) });
  }
}

/**
 * Finish a failed stream without leaking output or writing a second HTTP header.
 *
 * @param response - Owned socket.
 * @param error - Broker or transport failure.
 */
function fail(response: ServerResponse, error: unknown): void {
  if (response.destroyed || response.writableEnded) {
    return;
  }
  if (response.headersSent) {
    response.end('event: disconnected\ndata: {}\n\n');
    return;
  }
  response.writeHead(error instanceof MeshError ? error.status : HTTP.invalid, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify({ error: error instanceof MeshError ? error.message : 'Terminal stream unavailable.' }));
}

/** Bounded owned stream set; no output or credentials stored here. */
export class TerminalStreams {
  /** Project/session identity for subscriber fencing. */
  private readonly clients = new Map<ServerResponse, string>();

  /** Stop only these owned HTTP streams on console shutdown. */
  public close(): void {
    for (const response of this.clients.keys()) {
      response.destroy();
    }
  }

  /**
   * Route only explicit authenticated terminal inspection endpoints.
   *
   * @param gateway - Server-owned project routing.
   * @param url - Authorized request URL.
   * @param connection - Paired request boundary.
   */
  public async route(gateway: ProjectGateway, url: URL, connection: Connection): Promise<void> {
    const { response, request } = connection;
    if (request.method !== 'GET') {
      response.writeHead(HTTP.method, { 'Cache-Control': 'no-store' });
      response.end();
      return;
    }
    if (url.pathname === '/api/terminal-stream') {
      await this.open(gateway, url, connection);
      return;
    }
    if (url.pathname !== '/api/terminals') {
      response.writeHead(HTTP.missing, { 'Cache-Control': 'no-store' });
      response.end();
      return;
    }
    const metadata = await gateway.terminals(url.searchParams.get('project') ?? 'home');
    response.writeHead(HTTP.ok, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(metadata));
  }

  /**
   * Reserve bounded subscriptions and cancel all asynchronous work on disconnect.
   *
   * @param gateway - Server-owned project routing.
   * @param url - Exact stream query.
   * @param connection - Pairing/session boundary and owned response.
   * @throws {MeshError} For ambiguous cursors or subscriber pressure.
   */
  public async open(gateway: ProjectGateway, url: URL, connection: Connection): Promise<void> {
    const query = querySchema.parse(Object.fromEntries(url.searchParams));
    const names = new Set(url.searchParams.keys());
    if (url.searchParams.size !== names.size) {
      throw new MeshError('INVALID_INPUT', 'Duplicate terminal query parameters.');
    }
    const previous = connection.request.headers['last-event-id'];
    const after = z.coerce
      .number()
      .int()
      .nonnegative()
      .safe()
      .parse(previous ?? query.after);
    gateway.config(query.project);
    const key = `${query.project}:${query.id}`;
    const count = this.clients
      .values()
      .filter((entry) => entry === key)
      .toArray().length;
    if (this.clients.size >= CLIENTS || count >= PER_SESSION) {
      throw new MeshError('FACTORY_GATED', 'Terminal subscriber cap reached.');
    }
    const { response } = connection;
    const controller = new AbortController();
    const lifetime = setTimeout(() => {
      response.end();
      controller.abort();
    }, LIFETIME_MS);
    response.once('close', () => {
      controller.abort();
    });
    this.clients.set(response, key);
    try {
      await this.pump(gateway, { ...query, after }, connection, controller.signal);
    } catch (error) {
      fail(response, error);
    } finally {
      clearTimeout(lifetime);
      controller.abort();
      this.clients.delete(response);
      if (!response.headersSent && !response.destroyed) {
        response.writeHead(HTTP.unauthorized, { 'Cache-Control': 'no-store' });
      }
      response.end();
    }
  }

  /**
   * Reauthorize before and after every project-authenticated bounded broker poll.
   *
   * @param gateway - Project RPC boundary.
   * @param cursor - Mutable acknowledged sequence.
   * @param connection - Owned operator response.
   * @param signal - Stream cancellation.
   */
  private async pump(
    gateway: ProjectGateway,
    cursor: Cursor,
    connection: Connection,
    signal: AbortSignal,
  ): Promise<void> {
    let { after } = cursor;
    while (isAuthorized(connection, signal)) {
      // eslint-disable-next-line no-await-in-loop -- One bounded poll at a time; never overlap readers or queue output.
      const page = await gateway.terminalRead(cursor.project, cursor.id, after, signal);
      if (!isAuthorized(connection, signal)) {
        return;
      }
      // eslint-disable-next-line no-await-in-loop -- Drain this frame before reading the next page.
      await emit(connection.response, page, signal);
      after = page.nextCursor;
      if (page.unavailable || (!ACTIVE.has(page.session.state) && page.output.length === 0)) {
        return;
      }
    }
  }
}
