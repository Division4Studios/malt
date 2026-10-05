import { randomUUID } from 'node:crypto';
import { loadIdentity } from './config.js';
import { MeshError } from './protocol.js';
import { log } from './log.js';

export async function rpc(config, operation, input = {}, credentials, { signal } = {}) {
  log('debug', 'bridge', 'rpc_started', { operation });
  let response;
  try {
    response = await fetch(new URL('/rpc', config.url), {
      // Long-poll requests need a longer network deadline than ordinary RPCs.
      // The MCP cancellation signal is combined with, not substituted for, it.
      method: 'POST', redirect: 'error', signal: AbortSignal.any([
        AbortSignal.timeout(operation === 'wait_for_work' ? (input.timeoutMs ?? 20000) + 5000 : 5000),
        ...(signal ? [signal] : []),
      ]),
      // Small local teams do not need pooled connections. Closing each socket
      // avoids reusing a dead keep-alive connection immediately after restart,
      // without automatically retrying a possibly committed send operation.
      headers: { 'content-type': 'application/json', connection: 'close', authorization: `Bearer ${config.token}`, 'x-agentmesh-project': config.projectId },
      body: JSON.stringify({ operation, input, credentials }),
    });
  } catch {
    if (signal?.aborted) throw new MeshError('WAIT_CANCELLED', 'Request cancelled.', 499);
    throw new MeshError('BROKER_UNAVAILABLE', 'Cannot reach Agent Mesh. Start the broker and check the project configuration.', 503);
  }
  const data = await response.json();
  if (!response.ok) throw new MeshError(data.error?.code ?? 'HTTP_ERROR', data.error?.message ?? 'Broker request failed.', response.status);
  log('debug', 'bridge', 'rpc_completed', { operation });
  return data.result;
}

export class AgentClient {
  constructor(config, { name, provider = 'unknown', runtime = 'attached', role = 'generalist' }) {
    this.config = config;
    this.registration = { ...loadIdentity(config, name), provider, runtime, role, sessionId: randomUUID() };
    this.credentials = undefined;
    this.heartbeat = undefined;
    this.pendingHeartbeat = undefined;
    this.closed = false;
    this.shutdown = new AbortController();
  }
  async connect() {
    const agent = await rpc(this.config, 'register', this.registration);
    this.credentials = { agentId: agent.id, secret: this.registration.secret, sessionId: this.registration.sessionId };
    log('info', 'bridge', 'registered', { actor: agent.id, name: agent.name, status: agent.status });
    return agent;
  }
  async call(operation, input = {}, options = {}) {
    if (this.closed) throw new MeshError('CLIENT_CLOSED', 'This bridge is closed.');
    if (!this.credentials) await this.connect();
    return rpc(this.config, operation, input, this.credentials, {
      signal: AbortSignal.any([this.shutdown.signal, ...(options.signal ? [options.signal] : [])]),
    });
  }
  startHeartbeat(onError = () => {}) {
    // The bridge owns presence renewal, independently of whether its model is
    // working, waiting inside a tool call, or idle-approved by the lead.
    if (this.heartbeat || this.closed) return;
    this.heartbeat = setInterval(() => {
      if (this.pendingHeartbeat) return;
      this.pendingHeartbeat = this.call('heartbeat').catch(onError).finally(() => { this.pendingHeartbeat = undefined; });
    }, this.config.heartbeatMs);
    this.heartbeat.unref();
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    this.shutdown.abort();
    await this.pendingHeartbeat;
    // Use a fresh bounded RPC: the ordinary call signal was just cancelled.
    if (this.credentials) await rpc(this.config, 'disconnect', {}, this.credentials).catch(() => {});
    log('info', 'bridge', 'closed', { actor: this.credentials?.agentId });
  }
}
