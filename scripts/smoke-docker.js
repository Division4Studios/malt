// This test owns a randomly named Compose project and removes only its own volume.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const exec = promisify(execFile);
const project = `agentmesh-smoke-${randomUUID().slice(0, 8)}`;
const compose = ['compose', '-f', resolve('compose.yaml'), '-p', project];
const env = { ...process.env, AGENTMESH_PORT: '0', AGENTMESH_PROJECT_NAME: project };
const clients = new Set();
async function command(...args) {
  try { return await exec('docker', [...compose, ...args], { env, timeout: 180000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }); }
  catch (error) { throw new Error(`docker compose ${args.join(' ')} failed\n${error.stderr ?? error.message}`); }
}
async function connect(name, provider) {
  const client = new Client({ name: 'docker-smoke', version: '1.0' });
  const transport = new StdioClientTransport({ command: 'docker', args: [...compose, 'exec', '-T', 'broker', 'node', 'src/cli.js', 'mcp', '--project', '/data', '--name', name, '--provider', provider, '--role', name === 'claude-lead' ? 'lead' : 'generalist'], env, stderr: 'pipe' });
  let diagnostic = '';
  transport.stderr.on('data', chunk => { diagnostic += chunk; });
  clients.add(client);
  await client.connect(transport, { timeout: 15000 });
  return {
    client,
    async call(name, args = {}) {
      const response = await client.callTool({ name, arguments: args });
      assert.ok(!response.isError, JSON.stringify(response) + diagnostic);
      return JSON.parse(response.content[0].text);
    },
  };
}
async function closeClients() {
  for (const client of clients) await client.close();
  clients.clear();
}

try {
  console.log(`Starting disposable Compose project ${project}`);
  await command('up', '-d', '--build', '--wait');
  const lead = await connect('claude-lead', 'anthropic');
  const worker = await connect('codex-1', 'openai');
  const identity = await worker.call('mesh_whoami');
  assert.equal((await lead.call('mesh_list_agents')).length, 2);
  const request = await worker.call('mesh_work_status');
  const waiting = worker.call('mesh_wait_for_work', { timeoutMs: 2000, afterRevision: request.revision });
  await lead.call('mesh_answer_check_in', { requestId: request.request_id, decision: 'idle', reason: 'Wait for the next message.' });
  const approval = await waiting;
  assert.equal(approval.reason, 'IDLE_APPROVED');
  const sleeping = worker.call('mesh_wait_for_work', { timeoutMs: 2000, afterRevision: approval.state.revision });
  const sent = await lead.call('mesh_send_message', { to: 'codex-1', body: 'Persist through compose down/up' });
  const wake = await sleeping;
  assert.equal(wake.reason, 'MESSAGES');
  assert.equal(wake.state.phase, 'CHECKIN_REQUIRED');
  const acknowledged = await lead.call('mesh_send_message', { to: 'codex-1', body: 'Already processed' });
  await worker.call('mesh_ack_message', { id: acknowledged.id });
  await worker.call('mesh_reply', { id: sent.id, body: 'Reply from another MCP process' });
  assert.equal((await lead.call('mesh_get_messages')).messages[0].body, 'Reply from another MCP process');
  await closeClients();
  console.log('Stopping and recreating containers while retaining the named volume');
  await command('down');
  await command('up', '-d', '--wait');
  const resumed = await connect('codex-1', 'openai');
  assert.equal((await resumed.call('mesh_whoami')).id, identity.id);
  assert.equal((await resumed.call('mesh_work_status')).phase, 'CHECKIN_REQUIRED');
  const inbox = await resumed.call('mesh_get_messages');
  assert.equal(inbox.messages.length, 1);
  assert.equal(inbox.messages[0].id, sent.id);
  await resumed.call('mesh_ack_message', { id: sent.id });
  assert.equal((await resumed.call('mesh_get_messages')).messages.length, 0);
  console.log('PASS: Docker MCP wait/resume, explicit idle approval, messaging, stable identity and persistence');
} finally {
  try { await closeClients(); }
  finally { await command('down', '--volumes'); }
}
