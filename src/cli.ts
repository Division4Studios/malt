#!/usr/bin/env node

/**
 * The `agentmesh` command-line interface.
 *
 * One entry point serves three very different process lifetimes:
 *
 * 1. **Short human queries** (`status`, `agents`, `events`, `lead`,
 *    `message`, `messages`, `ack`) print exactly one JSON document to stdout
 *    and exit.
 * 2. **The broker** (`start`) runs in the foreground until SIGINT/SIGTERM.
 * 3. **An MCP bridge** (`mcp`) is owned by an MCP host; its stdout IS the MCP
 *    protocol stream, so nothing else may ever be printed there.
 *
 * Only the broker imports SQLite (through a dynamic import), so the CLI and
 * bridges start quickly and never touch the database file directly.
 *
 * Errors are printed to stderr as `CODE: message` and set a non-zero exit
 * code. The process is never terminated with `process.exit`: setting
 * `process.exitCode` lets pending output and cleanup finish first.
 *
 * @file
 */

import { parseArgs } from 'node:util';

import { AgentClient, rpc } from './client.ts';
import { loadConfig } from './config.ts';
import { MeshError } from './protocol.ts';

import type { MeshConfig } from './config.ts';

/** Usage text for `--help`. */
const HELP = `Agent Mesh 0.1 — durable local agent communication

Usage: node src/cli.ts <command> [options]
  init                         Initialize .agentmesh in the project
  start                        Start the broker (foreground; Ctrl+C to stop)
  status                       Compact team overview
  agents                       List registered agents and presence
  events                       Read the durable coordination event log
  lead --name NAME             Designate/replace the orchestrator (human control)
  mcp --name NAME              Run a persistent stdio MCP bridge
  message --name NAME --to PEER --body TEXT
  messages --name NAME         Read this identity's unread inbox
  ack --name NAME --id ID      Acknowledge an inbox message

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
        docker compose exec broker node src/cli.ts status --project /data
        docker compose down
`;

/** Every command the CLI accepts. */
const COMMANDS = ['init', 'start', 'mcp', 'status', 'agents', 'events', 'lead', 'message', 'messages', 'ack'] as const;

/** A CLI command. */
type Command = (typeof COMMANDS)[number];

/** Default page size for `messages` and `events`. */
const DEFAULT_PAGE_LIMIT = 50;

/** The parsed command-line options. */
interface CliOptions {
  /** `--project`: the project directory. */
  readonly project?: string | undefined;
  /** `--name`: the agent identity to act as. */
  readonly name?: string | undefined;
  /** `--provider`: provider label for registration. */
  readonly provider?: string | undefined;
  /** `--runtime`: runtime label for registration. */
  readonly runtime?: string | undefined;
  /** `--role`: role label for registration. */
  readonly role?: string | undefined;
  /** `--host`: broker bind address. */
  readonly host?: string | undefined;
  /** `--to`: message recipient. */
  readonly to?: string | undefined;
  /** `--body`: message text. */
  readonly body?: string | undefined;
  /** `--id`: message ID to acknowledge. */
  readonly id?: string | undefined;
  /** `--after`: pagination cursor. */
  readonly after?: string | undefined;
  /** `--limit`: page size. */
  readonly limit?: string | undefined;
  /** `--all`: include acknowledged messages. */
  readonly all?: boolean | undefined;
}

/**
 * Determine whether a positional argument names a known command.
 *
 * @param value - The first positional argument.
 * @returns Whether it is a {@link Command}.
 */
function isCommand(value: string): value is Command {
  return (COMMANDS as readonly string[]).includes(value);
}

/**
 * Print a JSON document as the command's single stdout result.
 *
 * @param value - The JSON-serialisable result.
 */
function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Parse the `--after`/`--limit` pagination options.
 *
 * @param options - The parsed command-line options.
 * @returns The cursor and page size; the broker validates their bounds.
 */
function pagination(options: CliOptions): { readonly after: number; readonly limit: number } {
  return {
    after: options.after === undefined ? 0 : Number(options.after),
    limit: options.limit === undefined ? DEFAULT_PAGE_LIMIT : Number(options.limit),
  };
}

/**
 * Run the broker in the foreground until SIGINT or SIGTERM.
 *
 * @param config - The project configuration.
 * @param options - The parsed command-line options.
 */
async function runBroker(config: MeshConfig, options: CliOptions): Promise<void> {
  const { startBroker } = await import('./broker.ts');
  const broker = await startBroker(config, { host: options.host });
  print({
    category: 'broker',
    state: 'listening',
    project: config.name,
    host: options.host ?? '127.0.0.1',
    port: broker.port,
  });
  // SIGINT (terminal Ctrl+C) and SIGTERM (`docker stop`) share one shutdown.
  // Pending waits are cancelled before the database connection is closed.
  let isClosing = false;

  const stop = (): void => {
    if (isClosing) {
      return;
    }
    isClosing = true;
    void broker.close();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

/**
 * Run an MCP bridge until its host disconnects or a signal arrives.
 *
 * @param config - The project configuration.
 * @param name - The agent identity to act as.
 * @param options - The parsed command-line options.
 */
async function runBridge(config: MeshConfig, name: string, options: CliOptions): Promise<void> {
  // Never print anything to stdout here: it is the JSON-RPC channel. All
  // diagnostics, including verbose ones, go to stderr through log.ts.
  const { startMcp } = await import('./mcp.ts');
  const bridge = await startMcp(config, {
    name,
    provider: options.provider,
    runtime: options.runtime,
    role: options.role,
  });

  const stop = (): void => {
    // Closing disconnects the agent and releases stdin, after which the event
    // loop drains and the process exits naturally.
    void (async (): Promise<void> => {
      await bridge.close();
      process.stdin.destroy();
    })();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

/**
 * Run a one-shot human messaging command as an `observer` identity.
 *
 * One-shot human identities observe and message the team; they must not
 * create requests asking the orchestrator to assign them coding work, so the
 * role defaults to `observer`.
 *
 * @param config - The project configuration.
 * @param command - `message`, `messages` or `ack`.
 * @param name - The identity to act as.
 * @param options - The parsed command-line options.
 */
async function runMessaging(
  config: MeshConfig,
  command: 'ack' | 'message' | 'messages',
  name: string,
  options: CliOptions,
): Promise<void> {
  const client = new AgentClient(config, {
    name,
    provider: options.provider,
    runtime: options.runtime,
    role: options.role ?? 'observer',
  });
  try {
    if (command === 'message') {
      print(await client.request('send_message', { to: options.to, body: options.body }));
    } else if (command === 'messages') {
      print(await client.request('get_messages', { ...pagination(options), unreadOnly: options.all !== true }));
    } else {
      print(await client.request('ack_message', { id: options.id }));
    }
  } finally {
    await client.close();
  }
}

/**
 * Dispatch a validated command.
 *
 * @param command - The command to run.
 * @param options - The parsed command-line options.
 * @throws {Error} When a required option is missing.
 */
async function run(command: Command, options: CliOptions): Promise<void> {
  // Only `init` and `start` may create a project; see loadConfig.
  const config = loadConfig(options.project, { create: command === 'init' || command === 'start' });
  switch (command) {
    case 'init': {
      print({ project: config.name, directory: config.directory, url: config.url });
      return;
    }
    case 'start': {
      await runBroker(config, options);
      return;
    }
    case 'status': {
      print(await rpc(config, 'team_status', {}));
      return;
    }
    case 'agents': {
      print(await rpc(config, 'list_agents', {}));
      return;
    }
    case 'events': {
      print(await rpc(config, 'events', pagination(options)));
      return;
    }
    case 'lead':
    case 'mcp':
    case 'message':
    case 'messages':
    case 'ack': {
      const { name } = options;
      if (name === undefined) {
        throw new Error('--name is required. Use a distinct name for each independent session.');
      }
      if (command === 'lead') {
        print(await rpc(config, 'set_lead', { agent: name }));
      } else if (command === 'mcp') {
        await runBridge(config, name, options);
      } else {
        await runMessaging(config, command, name, options);
      }
    }
  }
}

/**
 * Parse arguments and run the requested command.
 *
 * @throws {Error} On unknown commands or unexpected arguments.
 */
async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      project: { type: 'string' },
      name: { type: 'string' },
      provider: { type: 'string' },
      runtime: { type: 'string' },
      role: { type: 'string' },
      host: { type: 'string' },
      to: { type: 'string' },
      body: { type: 'string' },
      id: { type: 'string' },
      after: { type: 'string' },
      limit: { type: 'string' },
      all: { type: 'boolean' },
      verbose: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  // The logger reads its level on every call, so this applies immediately.
  if (values.verbose === true) {
    process.env['AGENTMESH_LOG_LEVEL'] = 'debug';
  }
  const [command] = positionals;
  if (command === undefined || command === 'help' || values.help === true) {
    process.stdout.write(HELP);
    return;
  }
  if (positionals.length !== 1) {
    throw new Error('Unexpected positional arguments. Use --help.');
  }
  if (!isCommand(command)) {
    throw new Error(`Unknown command: ${command}`);
  }
  await run(command, values);
}

try {
  await main();
} catch (error) {
  const code = error instanceof MeshError ? error.code : 'ERROR';
  const message = Error.isError(error) ? error.message : String(error);
  process.stderr.write(`${code}: ${message}\n`);
  process.exitCode = 1;
}
