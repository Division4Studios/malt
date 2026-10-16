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
 * Human commands address the home project, or with `--workspace` the team of
 * that workspace folder (see teams.ts).
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

import path from 'node:path';
import { parseArgs } from 'node:util';

import { AgentClient, openTeamConfig, rpc } from './client.ts';
import { loadConfig, saveBrokerDiscovery } from './config.ts';
import { FACTORY_COMMANDS, isFactoryCommand, runFactoryCommand } from './factory-cli.ts';
import { MeshError } from './protocol.ts';

import type { MeshConfig } from './config.ts';
/** Default loopback operator port. */
const CONSOLE_PORT = 4318;
/** Largest valid TCP port. */
const MAX_PORT = 65_535;

/** Usage text for `--help`. */
const HELP = `MALT 0.1 — durable local agent communication

Usage: node src/cli.ts <command> [options]
  init                         Initialize .malt and project agent discovery files
  start                        Start the broker (foreground; Ctrl+C to stop)
  ui --port 4318              Serve the installable local PWA; prints a pairing code
  ui --with-broker             Own broker and console together; enables native terminals
  status                       Compact team overview
  dashboard                    Full-screen live team, deliveries, activity and capacity
  github-connect --file FILE   Verify target GitHub Project connection (JSON input)
  factory-setup --file FILE    Configure target factory validation and resource policies
  factory-start               Start autonomous work on the connected target project
  factory-pause               Stop managed processes and pause new dispatch
  factory-status              Inspect factory ledger as JSON
  factory-request --body TEXT  Queue an objective for product owner and lead
  factory-recover --file FILE  Recover a blocked objective with an explicit decision
  factory-triage --file FILE   Decide an exact delivery blocker
  factory-queue --file FILE    Reorder unfinished objectives and set dispatch focus
  factory-retry --file FILE    Resume a resolved blocked task or feature
  factory-reorder-objective --file FILE Move an unfinished objective using a saved revision
  factory-instruct --file FILE Send durable role instructions / coordinated scope changes
  factory-skill-decide --file FILE Approve or reject an independently reviewed skill revision
  agents                       List registered agents and presence
  events                       Read the durable coordination event log
  teams                        List the workspace teams of this broker
  lead --name NAME             Designate/replace the orchestrator (human control)
  mcp                          Run a stdio MCP bridge for one session; it joins
                               its workspace's team when the model calls mesh_join
  mcp --name NAME              Run a stdio MCP bridge for a fixed, durable identity
  message --name NAME --to PEER --body TEXT
  messages --name NAME         Read this identity's unread inbox
  ack --name NAME --id ID      Acknowledge an inbox message

Options:
  --project PATH               Project directory (default: current directory)
  --workspace PATH             Address the team of this workspace folder instead
                               of the home project (mcp: overrides MCP roots)
  --provider TEXT              Provider label (default: unknown)
  --runtime TEXT               Runtime label (default: attached)
  --role TEXT                  Role label for --name identities (default: generalist)
  --host ADDRESS               Broker bind address (default: 127.0.0.1)
  --after NUMBER --limit NUMBER Paginate messages or events (default: 0 / 50)
  --all                        Include acknowledged inbox messages
  --verbose                    Log detailed broker/bridge activity to stderr

Docker: docker compose up -d --build
        docker compose exec broker node src/cli.ts status --project /data
        docker compose down
`;

/** Every command the CLI accepts. */
const COMMANDS = [
  'ui',
  ...FACTORY_COMMANDS,
  'init',
  'start',
  'mcp',
  'status',
  'agents',
  'events',
  'teams',
  'lead',
  'message',
  'messages',
  'ack',
] as const;

/** A CLI command. */
type Command = (typeof COMMANDS)[number];

/** A command that reads or controls one team. */
type TeamCommand = Exclude<Command, 'init' | 'mcp' | 'start' | 'teams' | 'ui'>;

/** Default page size for `messages` and `events`. */
const DEFAULT_PAGE_LIMIT = 50;

/** The parsed command-line options. */
interface CliOptions {
  /** Keep native terminal authority in the same process as the paired console. */
  readonly 'with-broker'?: boolean | undefined;
  /** Broker listen port or local PWA port, depending on the command. */
  readonly port?: string | undefined;
  /** JSON settings/control input file. */
  readonly file?: string | undefined;
  /** `--project`: the project directory. */
  readonly project?: string | undefined;
  /** `--workspace`: the workspace folder whose team to address. */
  readonly workspace?: string | undefined;
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
 * Make a `--workspace` value absolute. Windows paths and `file:` URIs pass
 * through untouched, since the broker (possibly inside a Linux container)
 * normalizes them; anything relative resolves against the current directory.
 *
 * @param workspace - The option value.
 * @returns An absolute path or URI.
 */
function absoluteWorkspace(workspace: string): string {
  const isAbsolute = path.isAbsolute(workspace) || path.win32.isAbsolute(workspace) || workspace.startsWith('file:');
  return isAbsolute ? workspace : path.resolve(workspace);
}

/**
 * Parse the `--after`/`--limit` pagination options.
 *
 * @param options - The parsed command-line options.
 * @returns The cursor and page size; the broker validates their bounds.
 */
function pagination(options: CliOptions): { readonly after: number; readonly limit: number } {
  const record = options;
  return {
    after: record.after === undefined ? 0 : Number(record.after),
    limit: record.limit === undefined ? DEFAULT_PAGE_LIMIT : Number(record.limit),
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
  const selected = { ...config };
  if (options.port !== undefined) {
    const port = Number(options.port);
    if (!Number.isSafeInteger(port) || port < 1 || port > MAX_PORT) {
      throw new Error('Use a broker port between 1 and 65535.');
    }
    const url = new URL(config.url);
    url.port = String(port);
    selected.url = url.origin;
  }
  const broker = await startBroker(selected, { host: options.host });
  try {
    saveBrokerDiscovery(selected);
  } catch (error) {
    await broker.close();
    throw error;
  }
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
 * @param config - The home project's configuration.
 * @param options - The parsed command-line options.
 * @throws {Error} When `--role` is given without `--name`.
 */
async function runBridge(config: MeshConfig, options: CliOptions): Promise<void> {
  const record = options;
  if (record.name === undefined && record.role !== undefined) {
    throw new Error('--role applies to --name identities; a session chooses its role with mesh_join.');
  }
  // Never print anything to stdout here: it is the JSON-RPC channel. All
  // diagnostics, including verbose ones, go to stderr through log.ts.
  const { startMcp } = await import('./mcp.ts');
  const bridge = await startMcp(config, {
    name: record.name,
    provider: record.provider,
    runtime: record.runtime,
    role: record.role,
    workspace: record.workspace === undefined ? undefined : absoluteWorkspace(record.workspace),
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
 */
async function run(command: Command, options: CliOptions): Promise<void> {
  const record = options;
  // Only `init` and `start` may create a project; see loadConfig.
  const home = loadConfig(record.project, {
    create: command === 'init' || command === 'start' || (command === 'ui' && record['with-broker'] === true),
  });
  if (isTeamCommand(command)) {
    const config =
      record.workspace === undefined ? home : await openTeamConfig(home, absoluteWorkspace(record.workspace));
    await runTeamCommand(command, config, record);
  } else {
    switch (command) {
      case 'init': {
        print({ project: home.name, directory: home.directory, url: home.url });
        return;
      }
      case 'start': {
        await runBroker(home, record);
        return;
      }
      case 'teams': {
        print(await rpc(home, 'list_teams', {}));
        return;
      }
      case 'mcp': {
        await runBridge(home, record);
        return;
      }
      case 'ui': {
        const { startNativeConsole } = await import('./web/native.ts');
        const port = record.port === undefined ? CONSOLE_PORT : Number(record.port);
        if (!Number.isSafeInteger(port) || port < 0 || port > MAX_PORT) {
          throw new Error('Use a valid local UI port.');
        }
        const console = await startNativeConsole(home, port, record['with-broker'] === true);
        print({
          url: console.url,
          pairingCode: console.pairingCode,
          note: 'Pair locally; browser installation does not install the native daemon.',
        });
        process.once('SIGINT', () => {
          void console.close();
        });
        process.once('SIGTERM', () => {
          void console.close();
        });
      }
    }
  }
}

/**
 * Run a command that reads or controls one team: the home project, or the
 * workspace team selected with `--workspace`.
 *
 * @param command - The command to run.
 * @param config - The addressed team's configuration.
 * @param options - The parsed command-line options.
 * @throws {Error} When a required option is missing.
 */
async function runTeamCommand(command: TeamCommand, config: MeshConfig, options: CliOptions): Promise<void> {
  const record = options;
  if (isFactoryCommand(command)) {
    const result = await runFactoryCommand(command, config, options);
    if (result !== undefined) {
      print(result);
    }
    return;
  }
  switch (command) {
    case 'status': {
      print(await rpc(config, 'team_status', {}));
      return;
    }
    case 'agents': {
      print(await rpc(config, 'list_agents', {}));
      return;
    }
    case 'events': {
      print(await rpc(config, 'events', pagination(record)));
      return;
    }
    case 'lead':
    case 'message':
    case 'messages':
    case 'ack': {
      const { name } = record;
      if (name === undefined) {
        throw new Error('--name is required. Use a distinct name for each independent session.');
      }
      if (command === 'lead') {
        print(await rpc(config, 'set_lead', { agent: name }));
      } else {
        await runMessaging(config, command, name, record);
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
      port: { type: 'string' },
      'with-broker': { type: 'boolean' },
      file: { type: 'string' },
      workspace: { type: 'string' },
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

/**
 * Recognize commands scoped to a target workspace.
 *
 * @param value - Validated CLI command.
 * @returns Whether it addresses one workspace team.
 */
function isTeamCommand(value: Command): value is TeamCommand {
  return !['init', 'start', 'mcp', 'teams', 'ui'].includes(value);
}
