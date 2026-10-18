/**
 * Authenticated installable local PWA; all mutations proxy the existing broker.
 *
 * @file
 */
import { Buffer } from 'node:buffer';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

import { z } from 'zod/v3';

import { MeshError } from '../protocol.ts';

import { readArtifact } from './artifacts.ts';
import { ensurePairingCode, readPairingCode } from './pairing.ts';
import { ProjectGateway } from './projects.ts';
import { recommendationQuery } from './recommendation-query.ts';
import { OperatorSessions } from './security.ts';
import { telemetryRoute } from './telemetry-routes.ts';
import { TerminalStreams } from './terminal-streams.ts';

import type { MeshConfig } from '../config.ts';
import type { RecommendationOperator } from '../factory/recommendation-decisions.ts';
import type { TerminalOperator } from '../factory/terminal-schema.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** Static assets are explicit, preventing arbitrary path traversal. */
const ASSETS = new Map<string, readonly [string, string]>([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['dist/app.js', 'text/javascript; charset=utf-8']],
  ['/history.js', ['dist/history.js', 'text/javascript; charset=utf-8']],
  ['/activity-ui.js', ['dist/activity-ui.js', 'text/javascript; charset=utf-8']],
  ['/views.js', ['dist/views.js', 'text/javascript; charset=utf-8']],
  ['/worker-ui.js', ['dist/worker-ui.js', 'text/javascript; charset=utf-8']],
  ['/learning-ui.js', ['dist/learning-ui.js', 'text/javascript; charset=utf-8']],
  ['/pwa.js', ['dist/pwa.js', 'text/javascript; charset=utf-8']],
  ['/brand-ui.js', ['dist/brand-ui.js', 'text/javascript; charset=utf-8']],
  ['/workflow-ui.js', ['dist/workflow-ui.js', 'text/javascript; charset=utf-8']],
  ['/organization-ui.js', ['dist/organization-ui.js', 'text/javascript; charset=utf-8']],
  ['/recovery-ui.js', ['dist/recovery-ui.js', 'text/javascript; charset=utf-8']],
  ['/triage-ui.js', ['dist/triage-ui.js', 'text/javascript; charset=utf-8']],
  ['/report-ui.js', ['dist/report-ui.js', 'text/javascript; charset=utf-8']],
  ['/navigation.js', ['dist/navigation.js', 'text/javascript; charset=utf-8']],
  ['/freshness.js', ['dist/freshness.js', 'text/javascript; charset=utf-8']],
  ['/console-clock.js', ['dist/console-clock.js', 'text/javascript; charset=utf-8']],
  ['/capacity-details.js', ['dist/capacity-details.js', 'text/javascript; charset=utf-8']],
  ['/capacity-view.js', ['dist/capacity-view.js', 'text/javascript; charset=utf-8']],
  ['/admission-ui.js', ['dist/admission-ui.js', 'text/javascript; charset=utf-8']],
  ['/model-policy-ui.js', ['dist/model-policy-ui.js', 'text/javascript; charset=utf-8']],
  ['/selection-ui.js', ['dist/selection-ui.js', 'text/javascript; charset=utf-8']],
  ['/api.js', ['dist/api.js', 'text/javascript; charset=utf-8']],
  ...[
    'terminal-parser',
    'terminal-style',
    'terminal-grid',
    'terminal-width',
    'terminal-screen',
    'terminal-render-model',
    'terminal-render',
    'terminal-contract',
    'terminal-stream',
    'terminal-pane',
    'terminal-workspace',
    'terminal-keys',
    'terminal-writes',
    'terminal-input',
    'telemetry-format',
    'transcript-ui',
    'sessions-ui',
    'cost-chart',
    'price-editor',
    'costs-ui',
    'i18n',
    'catalog-zh',
    'catalog-zh-shell',
    'catalog-zh-factory',
    'catalog-zh-board',
    'catalog-zh-workflows',
    'catalog-zh-project',
    'catalog-zh-costs',
    'theme',
    'objective-ui',
    'console-views',
    'log-tails',
    'console-model',
    'board-model',
    'approval-model',
    'console-dom',
    'approval-dialog',
    'inbox-model',
    'question-dialog',
    'inbox-notifier',
    'inbox-ui',
    'board-actions',
    'board-ui',
    'automations-model',
    'automations-ui',
    'diff-parse',
    'pulls-ui',
    'pulls-controller',
    'diff-model',
    'diff-ui',
    'onboarding-model',
    'onboarding-ui',
    'settings-model',
    'settings-ui',
    'project-views',
    'roles-model',
    'roles-dom',
    'roles-ui',
    'secrets-model',
    'secrets-ui',
    'step-override-model',
    'workflow-history-model',
    'workflow-history-ui',
    'step-override-ui',
    'delivery-ui',
    'goal-model',
    'checklist-dialog',
    'goal-ui',
    'spend-model',
    'spend-editor',
    'workflow-model',
    'workflow-checks',
    'workflow-dom',
    'workflow-preview',
    'workflow-step-editor',
    'workflow-editor',
    'workflows-ui',
  ].map((name): [string, [string, string]] => [`/${name}.js`, [`dist/${name}.js`, 'text/javascript; charset=utf-8']]),
  ['/terminal.css', ['terminal.css', 'text/css; charset=utf-8']],
  ['/sessions.css', ['sessions.css', 'text/css; charset=utf-8']],
  ['/board.css', ['board.css', 'text/css; charset=utf-8']],
  ['/workflows.css', ['workflows.css', 'text/css; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/manifest.webmanifest', ['manifest.webmanifest', 'application/manifest+json']],
  ['/sw.js', ['dist/sw.js', 'text/javascript; charset=utf-8']],
  ['/icon.svg', ['icon.svg', 'image/svg+xml']],
  ['/icon-192.png', ['icon-192.png', 'image/png']],
  ['/icon-512.png', ['icon-512.png', 'image/png']],
]);
/** App source distribution root. */
const WEB_ROOT = path.resolve(import.meta.dirname, '..', '..', 'web');
/** Maximum operator input bytes. */
const BODY_MAX = 262_144;
/** Explicit HTTP response statuses. */
const HTTP = {
  ok: 200,
  badRequest: 400,
  unauthorized: 401,
  forbidden: 403,
  notFound: 404,
  methodNotAllowed: 405,
  tooManyRequests: 429,
} as const;
/** Broker event page bound. */
const HISTORY_LIMIT_MAX = 100;
/** Default backward page, matching the recent snapshot window. */
const HISTORY_LIMIT_DEFAULT = 50;
/** Maximum local folder input. */
const PATH_MAX = 4096;
/** Maximum presented local pairing code. */
const PAIR_CODE_MAX = 64;
/** Highest valid TCP listener port. */
const MAX_PORT = 65_535;
/** Unpaid browser state refresh interval. */
const STREAM_MS = 2000;
/** Concurrent streams are bounded regardless of browser reconnect behavior. */
const STREAM_LIMIT = 8;
/** Stream expiry lets native EventSource reconnect and reauthenticate. */
const STREAM_LIFETIME = 120_000;
/** Maximum encoded private snapshot; histories must remain bounded. */
const STREAM_FRAME_BYTES = 1_048_576;
/** Bound a slow subscriber without accumulating another snapshot. */
const STREAM_DRAIN_MS = 5000;
/** Fixed local response security policy. */
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

/**
 * Read bounded structured operator input.
 *
 * @param request - Browser mutation.
 * @returns Untrusted decoded JSON for the route schema.
 * @throws {MeshError} For unexpected content or oversized input.
 */
async function body(request: IncomingMessage): Promise<unknown> {
  if (request.headers['content-type']?.startsWith('application/json') !== true) {
    throw new MeshError('CONTENT_TYPE', 'Expected JSON input.');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const data: unknown = chunk;
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
    size += bytes.length;
    if (size > BODY_MAX) {
      throw new MeshError('TOO_LARGE', 'Operator input is too large.');
    }
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * Bound route errors without leaving a rejected request promise unhandled.
 *
 * @param request - Local operator request.
 * @param response - Owned response.
 * @param context - Private scoped services.
 */
async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: { sessions: OperatorSessions; gateway: ProjectGateway; streams: Streams },
): Promise<void> {
  try {
    await route(request, response, context);
  } catch (error) {
    const message =
      error instanceof MeshError || error instanceof z.ZodError
        ? error.message
        : 'The local service request failed. Check broker availability and project setup.';
    json(response, error instanceof MeshError ? error.status : HTTP.badRequest, { error: message });
  }
}

/**
 * Emit a private noncacheable API result.
 *
 * @param response - Browser response.
 * @param status - HTTP status.
 * @param result - Validated server result.
 */
function json(response: ServerResponse, status: number, result: unknown): void {
  if (response.destroyed) {
    return;
  }
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(result));
}
/** Bound streaming lifecycle and backpressure. */
class EventCursor {
  /** Last emitted durable sequence, absent for the initial recent window. */
  public after: number | undefined;

  /**
   * Restore a validated reconnect cursor.
   *
   * @param previous - Incoming SSE last-event header.
   */
  public constructor(previous: string | string[] | undefined) {
    this.after = previous === undefined ? undefined : z.coerce.number().int().nonnegative().safe().parse(previous);
  }

  /**
   * Advance only after a single-flight snapshot read completes.
   *
   * @param next - Validated backend sequence.
   * @throws {Error} When a backend cursor regresses.
   */
  public advance(next: number): void {
    if (next < (this.after ?? 0)) {
      throw new Error('Timeline cursor regressed.');
    }
    this.after = next;
  }
}
/** Bound streaming lifecycle and backpressure. */
class Streams {
  /** Interactive output has separate transient buffers and per-session limits. */
  public readonly terminals = new TerminalStreams();
  /** Managed responses only. */
  private readonly clients = new Set<ServerResponse>();
  /** Single-flight reads prevent overlapping snapshots and unbounded work. */
  private readonly refreshing = new Set<ServerResponse>();
  /** End every owned browser stream on UI shutdown. */
  public close(): void {
    this.terminals.close();
    for (const client of this.clients) {
      client.end();
    }
    this.clients.clear();
  }

  /**
   * Stream real state and timeline snapshots with bounded refresh and lifetime.
   *
   * @param gateway - Broker project gateway.
   * @param project - Selected scope.
   * @param connection - Authenticated request, response and session boundary.
   */
  public async open(
    gateway: ProjectGateway,
    project: string,
    connection: { request: IncomingMessage; response: ServerResponse; sessions: OperatorSessions },
  ): Promise<void> {
    const { request, response, sessions } = connection;
    if (this.clients.size >= STREAM_LIMIT) {
      json(response, HTTP.tooManyRequests, { error: 'Too many live views.' });
      return;
    }
    gateway.config(project);
    const previous = request.headers['last-event-id'];
    const cursor = new EventCursor(previous);
    this.clients.add(response);
    response.writeHead(HTTP.ok, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    response.write('retry: 2000\n\n');
    const refresh = async (): Promise<void> => {
      if (this.refreshing.has(response) || response.destroyed) {
        return;
      }
      if (!sessions.authenticated(request)) {
        response.end();
        return;
      }
      this.refreshing.add(response);
      try {
        const snapshot = await gateway.snapshot(project, cursor.after);
        const next = z.object({ events: z.object({ nextCursor: z.number() }) }).parse(snapshot).events.nextCursor;
        cursor.advance(next);
        const frame = `id: ${String(next)}\nevent: state\ndata: ${JSON.stringify(snapshot)}\n\n`;
        if (Buffer.byteLength(frame) > STREAM_FRAME_BYTES) {
          throw new Error('Live snapshot exceeds the bounded stream frame limit.');
        }
        if (!response.write(frame)) {
          // A normal snapshot can exceed the socket high-water mark. Keep one
          // refresh in flight until it drains; never queue another frame.
          await once(response, 'drain', { signal: AbortSignal.timeout(STREAM_DRAIN_MS) });
        }
      } catch {
        if (canWriteStream(response)) {
          response.write('event: disconnected\ndata: {}\n\n');
        }
      } finally {
        this.refreshing.delete(response);
      }
    };
    const timer = setInterval(() => {
      void refresh();
    }, STREAM_MS);
    const lifetime = setTimeout(() => {
      response.end();
    }, STREAM_LIFETIME);
    response.once('close', () => {
      clearInterval(timer);
      clearTimeout(lifetime);
      this.clients.delete(response);
    });
    await refresh();
  }
}

/**
 * Recheck asynchronous socket closure without assuming its earlier state.
 *
 * @param response - Owned stream response.
 * @returns Whether a diagnostic frame may still be written.
 */
function canWriteStream(response: ServerResponse): boolean {
  return !response.destroyed && !response.writableEnded;
}
/** Running local UI service. */
export interface WebConsole {
  /** Local browser origin. */
  readonly url: string;
  /** Local pairing code at startup, shown by the owning CLI; `pairing-code --rotate` may replace it later. */
  readonly pairingCode: string;
  /** Stop only the UI server, keeping factory ownership with the broker. */
  readonly close: () => Promise<void>;
}

/**
 * Start a local PWA control service without exposing broker credentials.
 *
 * @param config - Broker home scope.
 * @param port - Requested local port, zero for isolated tests.
 * @param binding - Explicit container binding; public Host/Origin remain loopback-only.
 * @param operators - Memory-only capabilities from the colocated owning broker; a legacy terminal function is supported.
 * @returns Running operator console.
 */
export async function startWebConsole(
  config: MeshConfig,
  port = 4318,
  binding?: { host: '0.0.0.0'; publicPort: number },
  operators?: TerminalOperator | { terminal?: TerminalOperator; recommendation?: RecommendationOperator },
): Promise<WebConsole> {
  if (binding !== undefined) {
    z.object({ host: z.literal('0.0.0.0'), publicPort: z.number().int().min(1).max(MAX_PORT) })
      .strict()
      .parse(binding);
  }
  ensurePairingCode(config.directory);
  const sessions = new OperatorSessions(() => readPairingCode(config.directory));
  const capabilities = typeof operators === 'function' ? { terminal: operators } : operators;
  const gateway = new ProjectGateway(config, capabilities?.terminal, capabilities?.recommendation);
  const streams = new Streams();
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Security-Policy', CSP);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    void handleRequest(request, response, { sessions, gateway, streams });
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  const listening = once(server, 'listening');
  server.listen(port, binding?.host ?? '127.0.0.1');
  await listening;
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Console failed to bind.');
  }
  sessions.origin = `http://127.0.0.1:${String(binding?.publicPort ?? address.port)}`;
  return {
    url: sessions.origin,
    pairingCode: sessions.pairingCode,
    close: async () => {
      streams.close();
      const closed = once(server, 'close');
      server.close();
      await closed;
    },
  };
}

/**
 * Route only explicit static assets and authenticated project controls.
 *
 * @param request - Local browser request.
 * @param response - HTTP result.
 * @param context - Authentication, scope and streams.
 */
async function route(
  request: IncomingMessage,
  response: ServerResponse,
  context: { sessions: OperatorSessions; gateway: ProjectGateway; streams: Streams },
): Promise<void> {
  const { sessions, gateway, streams } = context;
  if (!sessions.accepts(request)) {
    json(response, HTTP.forbidden, { error: 'Only this local console origin is allowed.' });
    return;
  }
  const url = new URL(request.url ?? '/', sessions.origin);
  if (request.method === 'POST' && url.pathname === '/api/pair') {
    const input = z
      .object({ code: z.string().max(PAIR_CODE_MAX) })
      .strict()
      .parse(await body(request));
    const isPaired = sessions.pair(input.code, response);
    json(response, isPaired ? HTTP.ok : HTTP.forbidden, { paired: isPaired });
    return;
  }
  if (!url.pathname.startsWith('/api/')) {
    await asset(url.pathname, request, response);
    return;
  }
  if (!sessions.authenticated(request)) {
    json(response, HTTP.unauthorized, { error: 'Pair this browser with the local console code.' });
    return;
  }
  await api(url, request, response, { sessions, gateway, streams });
}

/**
 * Serve a fixed app-shell asset, with authenticated data never cacheable.
 *
 * @param pathname - Exact asset route.
 * @param request - Local browser request.
 * @param response - Static asset response.
 */
async function asset(pathname: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const entry = ASSETS.get(pathname);
  if (entry === undefined || request.method !== 'GET') {
    json(response, HTTP.notFound, { error: 'Unknown route.' });
    return;
  }
  const [file, type] = entry;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- The path comes only from the fixed app-shell allowlist above, never a requested filesystem path.
  const content = await readFile(path.join(WEB_ROOT, file));
  response.writeHead(HTTP.ok, { 'Content-Type': type, 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/' });
  response.end(content);
}

/** A decimal query cursor; coercion alone would accept blanks, signs and exponents. */
const queryInteger = z
  .string()
  .regex(/^\d{1,16}$/v)
  .transform(Number)
  .pipe(z.number().int().min(0).safe());
/** Exact backward history query; `limit` defaults to the snapshot window. */
const historyQuerySchema = z
  .object({
    project: z.string().min(1).max(PATH_MAX),
    before: queryInteger,
    limit: queryInteger.pipe(z.number().min(1).max(HISTORY_LIMIT_MAX)).default(String(HISTORY_LIMIT_DEFAULT)),
  })
  .strict();

/**
 * Parse an explicit, unambiguous history query.
 *
 * @param url - Parsed local URL.
 * @returns Explicit project scope, exclusive cursor and page size.
 * @throws {MeshError} For repeated parameters.
 */
function historyQuery(url: URL): z.output<typeof historyQuerySchema> {
  const keys = url.searchParams.keys().toArray();
  const unique = new Set(keys);
  if (unique.size !== keys.length) {
    throw new MeshError('INVALID_INPUT', 'History query parameters must not repeat.');
  }
  return historyQuerySchema.parse(Object.fromEntries(url.searchParams));
}

/**
 * Dispatch authenticated inspection routes without mixing their cases with mutations.
 *
 * @param url - Validated local request URL.
 * @param request - Authenticated incoming request.
 * @param response - Owned local response.
 * @param context - Same scoped gateway, sessions and stream authority as controls.
 */
async function inspectApi(
  url: URL,
  request: IncomingMessage,
  response: ServerResponse,
  context: { sessions: OperatorSessions; gateway: ProjectGateway; streams: Streams },
): Promise<void> {
  const { sessions, gateway, streams } = context;
  const project = url.searchParams.get('project') ?? 'home';
  switch (url.pathname) {
    case '/api/projects': {
      json(response, HTTP.ok, await gateway.list());
      return;
    }
    case '/api/snapshot': {
      json(response, HTTP.ok, await gateway.snapshot(project));
      return;
    }
    case '/api/recommendations':
    case '/api/recommendation': {
      const query = recommendationQuery(url, url.pathname === '/api/recommendations' ? 'list' : 'get');
      json(response, HTTP.ok, await gateway.recommendations(query.project, query.input));
      return;
    }
    case '/api/skill': {
      json(response, HTTP.ok, await gateway.skillProposal(project, url.searchParams.get('requestId') ?? ''));
      return;
    }
    case '/api/history': {
      const query = historyQuery(url);
      json(response, HTTP.ok, await gateway.history(query.project, query.before, query.limit));
      return;
    }
    case '/api/stream': {
      await streams.open(gateway, project, { request, response, sessions });
      return;
    }
    case '/api/local-pull': {
      const number = z.coerce.number().int().positive().parse(url.searchParams.get('number'));
      json(response, HTTP.ok, await gateway.localPull(project, number));
      return;
    }
    case '/api/version': {
      json(response, HTTP.ok, await gateway.versions(project));
      return;
    }
    case '/api/preflight': {
      json(response, HTTP.ok, await gateway.preflight(project));
      return;
    }
    case '/api/artifact': {
      json(response, HTTP.ok, await readArtifact(gateway.config(project), Object.fromEntries(url.searchParams)));
      return;
    }
    default: {
      // Attempt, transcript and cost reads; any other path is an unknown inspection route (404).
      json(response, HTTP.ok, await telemetryRoute(url, gateway));
    }
  }
}

/**
 * Dispatch operator API routes through existing broker controls.
 *
 * @param url - Parsed local URL.
 * @param request - Authenticated request.
 * @param response - HTTP result.
 * @param context - Scoped services.
 */
async function api(
  url: URL,
  request: IncomingMessage,
  response: ServerResponse,
  context: { sessions: OperatorSessions; gateway: ProjectGateway; streams: Streams },
): Promise<void> {
  const { sessions, gateway, streams } = context;
  const project = url.searchParams.get('project') ?? 'home';
  if (url.pathname.startsWith('/api/terminal')) {
    await streams.terminals.route(gateway, url, { request, response, sessions });
    return;
  }
  if (request.method === 'GET') {
    await inspectApi(url, request, response, context);
    return;
  }
  if (request.method !== 'POST') {
    json(response, HTTP.methodNotAllowed, { error: 'Method not allowed.' });
    return;
  }
  switch (url.pathname) {
    case '/api/recommendation/decide': {
      const query = recommendationQuery(url, 'read');
      json(response, HTTP.ok, await gateway.decideRecommendation(query.project, await body(request)));
      return;
    }
    case '/api/recommendation/read': {
      const query = recommendationQuery(url, 'read');
      json(response, HTTP.ok, await gateway.recommendations(query.project, await body(request), true));
      return;
    }
    case '/api/projects': {
      const input = z
        .object({ workspace: z.string().min(1).max(PATH_MAX) })
        .strict()
        .parse(await body(request));
      json(response, HTTP.ok, await gateway.open(input.workspace));
      return;
    }
    case '/api/control': {
      json(response, HTTP.ok, await gateway.control(project, await body(request)));
      return;
    }
    case '/api/logout': {
      sessions.logout(request, response);
      json(response, HTTP.ok, { ok: true });
      return;
    }
    default: {
      json(response, HTTP.notFound, { error: 'Unknown control route.' });
    }
  }
}
