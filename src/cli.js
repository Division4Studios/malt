#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';
import { AgentClient, rpc } from './client.js';

// The CLI has three lifetimes: short human queries, a foreground broker, and
// a stdio bridge owned by an MCP host. Only the broker imports SQLite directly.
const help = `Agent Mesh 0.1 — durable local agent communication

Usage: node src/cli.js <command> [options]
  init                         Initialize .agentmesh in the project
  start                        Start the broker (foreground; Ctrl+C to stop)
  status                       Compact team overview
  agents                       List registered agents and presence
  events                       Read the durable coordination event log
  lead --name NAME             Designate/replace the orchestrator (human control)
  mcp --name NAME               Run a persistent stdio MCP bridge
  message --name NAME --to PEER --body TEXT
  messages --name NAME          Read this identity's unread inbox
  ack --name NAME --id ID       Acknowledge an inbox message

Options:
  --project PATH               Project directory (default: current directory)
  --provider TEXT              Provider label (default: unknown)
  --runtime TEXT               Runtime label (default: attached)
  --role TEXT                  Role label (default: generalist)
  --host ADDRESS               Broker bind address (default: 127.0.0.1)
  --after NUMBER --limit NUMBER Paginate messages or events (default: 0 / 50)
  --all                        Include acknowledged inbox messages
  --verbose                    Log detailed broker/bridge activity to stderr

Docker: docker compose up -d --build
        docker compose exec broker node src/cli.js status --project /data
        docker compose down
`;

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    project: { type: 'string' }, name: { type: 'string' }, provider: { type: 'string' }, runtime: { type: 'string' }, role: { type: 'string' },
    host: { type: 'string' }, to: { type: 'string' }, body: { type: 'string' }, id: { type: 'string' },
    after: { type: 'string' }, limit: { type: 'string' }, all: { type: 'boolean' }, verbose: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.verbose) process.env.AGENTMESH_LOG_LEVEL = 'debug';
  const [command] = positionals;
  if (values.help || !command || command === 'help') return console.log(help);
  if (positionals.length !== 1) throw new Error('Unexpected positional arguments. Use --help.');
  if (!['init', 'start', 'mcp', 'status', 'agents', 'events', 'lead', 'message', 'messages', 'ack'].includes(command)) throw new Error(`Unknown command: ${command}`);
  const config = loadConfig(values.project, { create: command === 'init' || command === 'start' });
  const print = value => console.log(JSON.stringify(value, null, 2));
  if (command === 'init') return print({ project: config.name, directory: config.directory, url: config.url });
  if (command === 'start') {
    const { startBroker } = await import('./broker.js');
    const broker = await startBroker(config, { host: values.host });
    print({ category: 'broker', state: 'listening', project: config.name, host: values.host ?? '127.0.0.1', port: broker.port });
    // SIGINT (terminal Ctrl+C) and SIGTERM (Docker stop) share one shutdown.
    // Pending waits are cancelled before the database connection is closed.
    let closing = false;
    const stop = async () => { if (closing) return; closing = true; await broker.close(); };
    process.once('SIGINT', () => { void stop(); });
    process.once('SIGTERM', () => { void stop(); });
    return;
  }
  const pagination = { after: values.after === undefined ? 0 : Number(values.after), limit: values.limit === undefined ? 50 : Number(values.limit) };
  if (['status', 'agents', 'events'].includes(command)) return print(await rpc(config, { status: 'team_status', agents: 'list_agents', events: 'events' }[command], command === 'events' ? pagination : {}));
  if (!values.name) throw new Error('--name is required. Use a distinct name for each independent session.');
  if (command === 'lead') return print(await rpc(config, 'set_lead', { agent: values.name }));
  if (command === 'mcp') {
    // Never print human-readable startup text here: stdout is JSON-RPC. All
    // diagnostics, including verbose messages, are written through log.js.
    const { startMcp } = await import('./mcp.js');
    const bridge = await startMcp(config, values);
    process.once('SIGINT', () => { void bridge.close().finally(() => process.exit(0)); });
    process.once('SIGTERM', () => { void bridge.close().finally(() => process.exit(0)); });
    return;
  }
  // One-shot human CLI identities observe/message the team; they should not
  // create requests asking the orchestrator to assign them coding work.
  const client = new AgentClient(config, { ...values, role: values.role ?? 'observer' });
  try {
    if (command === 'message') print(await client.call('send_message', { to: values.to, body: values.body }));
    if (command === 'messages') print(await client.call('get_messages', { ...pagination, unreadOnly: !values.all }));
    if (command === 'ack') print(await client.call('ack_message', { id: values.id }));
  } finally { await client.close(); }
}

main().catch(error => { console.error(`${error.code ?? 'ERROR'}: ${error.message}`); process.exitCode = 1; });
