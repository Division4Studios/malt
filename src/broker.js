import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { Store } from './store.js';
import { MeshError, schemas } from './protocol.js';
import { Waiters } from './waiters.js';
import { log } from './log.js';

const readOnly = new Set(['team_status', 'list_agents', 'events']);
const same = (a, b) => {
  const left = Buffer.from(a ?? '');
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

async function readJson(request) {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new MeshError('CONTENT_TYPE', 'Expected application/json.', 415);
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 262144) throw new MeshError('TOO_LARGE', 'Request exceeds 256 KiB.', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new MeshError('INVALID_JSON', 'Malformed JSON.', 400); }
}

export async function startBroker(config, { host = '127.0.0.1', port = Number(new URL(config.url).port || 80), now } = {}) {
  const store = new Store(config, { now });
  const waiters = new Waiters(store);
  const server = http.createServer(async (request, response) => {
    const started = Date.now();
    let operationName = 'unknown';
    const send = (status, body) => {
      if (!response.destroyed) {
        response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        response.end(JSON.stringify(body));
      }
    };
    try {
      // No browser-origin requests or CORS. All coordination calls require the project secret.
      if (request.headers.origin) throw new MeshError('FORBIDDEN_ORIGIN', 'Browser requests are not supported.', 403);
      if (request.method === 'GET' && request.url === '/health') return send(200, { ok: true, version: '0.1.0' });
      if (request.method !== 'POST' || request.url !== '/rpc') throw new MeshError('NOT_FOUND', 'Unknown endpoint.', 404);
      if (!same(request.headers.authorization, `Bearer ${config.token}`)) throw new MeshError('UNAUTHORIZED', 'Project authentication required.', 401);
      if (request.headers['x-agentmesh-project'] !== config.projectId) throw new MeshError('WRONG_PROJECT', 'Project identity does not match.', 403);
      const envelope = await readJson(request);
      if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new MeshError('INVALID_REQUEST', 'Expected an RPC object.');
      const { operation, input = {}, credentials } = envelope;
      if (!Object.hasOwn(schemas, operation)) throw new MeshError('UNKNOWN_OPERATION', 'Unknown operation.', 404);
      operationName = operation;
      log('debug', 'broker', 'rpc_received', { operation });
      const parsed = schemas[operation].safeParse(input);
      if (!parsed.success) throw new MeshError('INVALID_INPUT', parsed.error.issues.map(issue => `${issue.path.join('.') || 'input'}: ${issue.message}`).join('; '));
      store.expire();
      let result;
      if (operation === 'register') result = store.register(parsed.data);
      else {
        // Lead replacement is a human control operation authenticated by the
        // project secret. It is intentionally NOT exported as an MCP tool.
        const actor = (readOnly.has(operation) || operation === 'set_lead') && !credentials ? null : store.authenticate(credentials);
        if (operation === 'set_lead' && credentials) throw new MeshError('HUMAN_CONTROL_REQUIRED', 'Use the human CLI to replace the orchestrator.', 403);
        if (operation === 'wait_for_work') {
          const cancellation = new AbortController();
          const onClose = () => cancellation.abort();
          response.once('close', onClose);
          response.setTimeout(parsed.data.timeoutMs + 5000);
          try { result = await waiters.wait(credentials, parsed.data, cancellation.signal); }
          finally { response.removeListener('close', onClose); }
        } else {
          result = store.execute(operation, parsed.data, actor);
        }
      }
      // All store mutations are synchronous transactions. Notification here
      // runs AFTER COMMIT, never while a waiter could observe partial state.
      if (operation !== 'wait_for_work') waiters.notify();
      send(200, { result });
    } catch (error) {
      log(error instanceof MeshError ? 'warn' : 'error', 'broker', 'rpc_failed', { operation: operationName, code: error instanceof MeshError ? error.code : 'INTERNAL' });
      send(error instanceof MeshError ? error.status : 500, { error: { code: error instanceof MeshError ? error.code : 'INTERNAL', message: error instanceof MeshError ? error.message : 'Internal broker error.' } });
    } finally {
      if (request.url !== '/health') log('debug', 'broker', 'rpc_finished', { operation: operationName, status: response.statusCode, elapsedMs: Date.now() - started });
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.timeout = 15000;
  let timer;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => { server.removeListener('error', reject); resolve(); });
    });
    timer = setInterval(() => {
      try { store.expire(); waiters.notify(); }
      catch { log('error', 'broker', 'presence_sweep_failed'); }
    }, Math.min(config.heartbeatMs, 5000));
    timer.unref();
    log('info', 'broker', 'listening', { host, port: server.address().port });
  } catch (error) { store.close(); throw error; }
  return {
    store, server, waiters, port: server.address().port,
    async close() {
      clearInterval(timer);
      log('info', 'broker', 'shutdown_started', { activeWaits: waiters.pending.size });
      waiters.close();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      store.close();
    },
  };
}
