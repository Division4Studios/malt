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

import { existsSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { COMMANDS } from './cli-commands.ts';
import { AgentClient, openTeamConfig, rpc } from './client.ts';
import { STATE_DIRECTORY_NAME, loadConfig, readJsonFile, saveBrokerDiscovery } from './config.ts';
import { isFactoryCommand, runFactoryCommand } from './factory-cli.ts';
import { log } from './log.ts';
import { MeshError } from './protocol.ts';

import type { Command } from './cli-commands.ts';
import type { MeshConfig } from './config.ts';
/** Default loopback operator port. */
const CONSOLE_PORT = 4318;
/** Largest valid TCP port. */
const MAX_PORT = 65_535;

/** Usage text for `--help`. */
const HELP = `MALT 0.1 — durable local agent communication

Usage: node src/cli.ts <command> [options]
  doctor [--json]              Preflight: Node, Git, provider logins, GitHub CLI, ports, .malt
  init                         Initialize .malt and project agent discovery files
  attach [--broker-port PORT]  Initialize .malt, register MALT for Claude Code and Codex
                               in this project, and start its background runtime
  stop                         Stop the project's background runtime
  start                        Start the broker (foreground; Ctrl+C to stop)
  ui --port 4318              Serve the installable local PWA; prints a pairing code
  ui --with-broker             Own broker and console together; enables native terminals
  pairing-code [--rotate]      Show (or re-issue) the persisted console pairing code
  backup --dir DIR             Snapshot .malt (databases via VACUUM INTO) into a new folder
  restore --dir DIR            Restore a backup with the broker stopped; .malt is moved aside
  status                       Compact team overview
  dashboard                    Full-screen live team, deliveries, activity and capacity
  github-connect --file FILE   Verify target GitHub Project connection (JSON input)
  github-section-save --file FILE  Save tracker and/or source sections unverified: {"tracker":{...},"source":{...}}
  github-verify                Verify the saved tracker and source sections with read-only GitHub discovery
  jira-discover --file FILE    Read-only Jira Cloud discovery: {"site","projectKey","email","tokenVariable"}
  capability-status            Show connector capability policies, support and history
  capability-set --file FILE   Change one connector capability policy (human only)
  mcp-binding-status           Show connector MCP bindings, their hashes and approval
  mcp-binding-propose --file FILE  Save a connector MCP binding for review (human only)
  mcp-binding-approve --file FILE  Approve one exact MCP binding hash (human only)
  factory-setup --file FILE    Configure target factory validation and resource policies
  factory-start               Start autonomous work on the connected target project
  factory-pause               Stop managed processes and pause new dispatch
  factory-status              Inspect factory ledger as JSON
  factory-cancel-job --file FILE  Cancel a live supervisor-owned job: {"jobId":"UUID"}
  factory-capacity --file FILE Record observed provider quota (resetAt: future epoch ms):
                               {"provider":"codex"|"claude"|"copilot","usedPercent":0-100,"resetAt":MS,"source":TEXT}
  factory-request --body TEXT  Queue an objective for product owner and lead
  factory-recover --file FILE  Recover a blocked objective with an explicit decision
  factory-triage --file FILE   Decide an exact delivery blocker
  factory-queue --file FILE    Reorder unfinished objectives and set dispatch focus
  factory-retry --file FILE    Resume a resolved blocked task or feature
  factory-reorder-objective --file FILE Move an unfinished objective using a saved revision
  factory-instruct --file FILE Send durable role instructions / coordinated scope changes
  factory-skill-decide --file FILE Approve or reject an independently reviewed skill revision
  factory-export-maintenance --file FILE Queue an approved skill proposal in a MALT source checkout:
                               {"requestId":"UUID","workspace":"PATH"}
  factory-manager --body TEXT  Message the persistent delivery manager
  factory-manager --file FILE  Manager action: {"action":"start"|"stop"|"status"|"history"|"answer",...}
  factory-local --file FILE    Local issues and pull requests: {"action":"summary"|"pull"|"sync",...}
  factory-reconcile-github [--apply] Propose (or apply) unpaid adoption of closed GitHub issues
  factory-worktrees-adopt      Hand .malt/worktrees to this host or container (paused)
  factory-prune [--apply]      Report (or, paused, remove) orphaned worktrees and snapshots
  agents                       List registered agents and presence
  events                       Read the durable coordination event log
  teams                        List the workspace teams of this broker
  lead --name NAME             Designate/replace the orchestrator (human control)
  mcp                          Run a stdio MCP bridge for one session; it joins
                               its workspace's team when the model calls mesh_join
  mcp --name NAME              Run a stdio MCP bridge for a fixed, durable identity
  mcp --autostart              Start the project's background runtime if nothing answers
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
        docker compose exec broker node src/cli.ts pairing-code --project /data
        docker compose exec broker node src/cli.ts status --project /data
        docker compose down
`;

/** A command that reads or controls one team. */
type TeamCommand = Exclude<
  Command,
  'attach' | 'backup' | 'doctor' | 'init' | 'mcp' | 'pairing-code' | 'restore' | 'start' | 'stop' | 'teams' | 'ui'
>;

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
  /** `--deny-tools`: comma-separated seat tools a managed role policy removed. */
  readonly 'deny-tools'?: string | undefined;
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
  /** `--apply`: apply proposed GitHub reconciliation decisions, or remove pruned worktrees, instead of a dry run. */
  readonly apply?: boolean | undefined;
  /** `--json`: print one machine-readable document (doctor). */
  readonly json?: boolean | undefined;
  /** `--rotate`: re-issue the console pairing code. */
  readonly rotate?: boolean | undefined;
  /** `--dir`: backup folder to write or restore from. */
  readonly dir?: string | undefined;
  /** `--autostart`: a bridge starts the project's background runtime when nothing answers. */
  readonly autostart?: boolean | undefined;
  /** `--broker-port`: the port `attach` saves for this project's broker. */
  readonly 'broker-port'?: string | undefined;
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
  if (record.autostart === true) {
    const { ensureRuntime } = await import('./runtime.ts');
    try {
      const runtime = await ensureRuntime(config, { cli: import.meta.filename });
      log('info', 'bridge', 'runtime_ready', { started: runtime.started, console: runtime.record?.consoleUrl });
    } catch (error) {
      // The bridge still connects; its tools report the unreachable broker.
      log('warn', 'bridge', 'runtime_start_failed', { message: Error.isError(error) ? error.message : String(error) });
    }
  }
  const { startMcp } = await import('./mcp.ts');
  const bridge = await startMcp(config, {
    name: record.name,
    provider: record.provider,
    runtime: record.runtime,
    role: record.role,
    deniedTools: record['deny-tools']?.split(',').filter((tool) => tool !== ''),
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
 * Whether a command works on project files without a broker connection.
 *
 * @param command - Validated CLI command.
 * @returns True for `doctor`, `backup` and `restore`.
 */
function isProjectFileCommand(command: Command): command is 'backup' | 'doctor' | 'restore' {
  return ['backup', 'doctor', 'restore'].includes(command);
}

/**
 * Run a command that works on project files without a broker connection.
 *
 * @param command - `doctor`, `backup` or `restore`.
 * @param options - Parsed options.
 */
async function runProjectFileCommand(command: 'backup' | 'doctor' | 'restore', options: CliOptions): Promise<void> {
  if (command !== 'doctor') {
    print(await runBackupCommand(command, options));
  } else if (!(await isDoctorPassing(options))) {
    process.exitCode = 1;
  }
}

/**
 * Back up or restore the project's `.malt` folder.
 *
 * @param command - `backup` or `restore`.
 * @param options - Parsed options; `--dir` names the backup folder.
 * @returns The backup manifest, or where the previous `.malt` was moved.
 * @throws {Error} When `--dir` is missing.
 */
async function runBackupCommand(command: 'backup' | 'restore', options: CliOptions): Promise<unknown> {
  if (options.dir === undefined) {
    throw new Error(`${command} needs --dir DIR.`);
  }
  const { backupProject, isBrokerRunning, restoreProject } = await import('./backup.ts');
  if (command === 'backup') {
    return await backupProject(loadConfig(options.project), options.dir);
  }
  const project = path.resolve(options.project ?? '.');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- The operator names their own project folder.
  const config = existsSync(path.join(project, STATE_DIRECTORY_NAME, 'config.json')) ? loadConfig(project) : null;
  const isRunning = config !== null && (await isBrokerRunning(config));
  return { movedAside: await restoreProject(project, options.dir, { isRunning, now: Date.now() }) };
}

/**
 * Whether a command may create the project; see loadConfig.
 *
 * @param command - Validated CLI command.
 * @param record - Parsed options; `ui` creates only when it owns the broker.
 * @returns True for `init`, `attach`, `start` and `ui --with-broker`.
 */
function isCreatingCommand(command: Command, record: CliOptions): boolean {
  return ['attach', 'init', 'start'].includes(command) || (command === 'ui' && record['with-broker'] === true);
}

/**
 * Dispatch a validated command.
 *
 * @param command - The command to run.
 * @param options - The parsed command-line options.
 */
async function run(command: Command, options: CliOptions): Promise<void> {
  const record = options;
  if (isProjectFileCommand(command)) {
    await runProjectFileCommand(command, record);
    return;
  }
  const home = loadConfig(record.project, { create: isCreatingCommand(command, record) });
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
      case 'attach':
      case 'stop': {
        print(await runRuntimeCommand(command, home, record));
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
      case 'pairing-code': {
        await runPairingCode(home, record);
        return;
      }
      case 'ui': {
        await runConsole(home, record);
      }
    }
  }
}

/**
 * Serve the local PWA, printing and logging its pairing code once.
 *
 * @param home - Home project.
 * @param record - Port and broker ownership options.
 * @throws {Error} When `--port` is not a valid port.
 */
async function runConsole(home: MeshConfig, record: CliOptions): Promise<void> {
  const { startNativeConsole } = await import('./web/native.ts');
  const port = record.port === undefined ? CONSOLE_PORT : Number(record.port);
  if (!Number.isSafeInteger(port) || port < 0 || port > MAX_PORT) {
    throw new Error('Use a valid local UI port.');
  }
  const isOwner = record['with-broker'] === true;
  const console = await startNativeConsole(home, port, isOwner);
  const { clearRuntimeRecord, writeRuntimeRecord } = await import('./runtime.ts');
  if (isOwner) {
    // Bridges, attach and stop find the owning process through this record.
    writeRuntimeRecord(home, { pid: process.pid, brokerUrl: home.url, consoleUrl: console.url, startedAt: Date.now() });
  }
  // The one log record that contains the code, so it survives a scrolled-away terminal.
  log('info', 'console', 'pairing_code', { url: console.url, pairingCode: console.pairingCode });
  print({
    url: console.url,
    pairingCode: console.pairingCode,
    note: 'Pair locally; browser installation does not install the native daemon. Re-show it with pairing-code.',
  });
  const close = (): void => {
    if (isOwner) {
      clearRuntimeRecord(home, process.pid);
    }
    void console.close();
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}

/**
 * Attach the project, or stop its background runtime.
 *
 * @param command - `attach` or `stop`.
 * @param home - Project.
 * @param record - Parsed options.
 * @returns The command's single result.
 */
async function runRuntimeCommand(command: 'attach' | 'stop', home: MeshConfig, record: CliOptions): Promise<unknown> {
  if (command === 'attach') {
    return await runAttach(home, record);
  }
  const { stopRuntime } = await import('./runtime.ts');
  const pid = await stopRuntime(home);
  return { stopped: pid !== null, pid };
}

/**
 * Attach MALT to a project: initialize `.malt`, register the bridge for
 * Claude Code and Codex in the project, and start its background runtime.
 *
 * @param home - Project, created by the caller when missing.
 * @param record - `--broker-port` saves a port for this project's broker.
 * @returns What was registered and where the runtime answers.
 * @throws {Error} When `--broker-port` is not a valid port.
 */
async function runAttach(home: MeshConfig, record: CliOptions): Promise<unknown> {
  const { registerProjectBridges } = await import('./attach.ts');
  const { ensureRuntime, isProcessAlive, readRuntimeRecord, RUNTIME_LOG } = await import('./runtime.ts');
  const { ensurePairingCode } = await import('./web/pairing.ts');
  let config = home;
  if (record['broker-port'] !== undefined) {
    const port = Number(record['broker-port']);
    if (!Number.isSafeInteger(port) || port < 1 || port > MAX_PORT) {
      throw new Error('Use a broker port between 1 and 65535.');
    }
    const url = new URL(home.url);
    url.port = String(port);
    const running = readRuntimeRecord(home);
    if (running !== null && url.origin !== home.url && isProcessAlive(running.pid)) {
      // Two brokers must never share one project store.
      throw new Error(`This project's runtime is running on ${home.url}. Run stop first, then attach --broker-port.`);
    }
    config = { ...home, url: url.origin };
    saveBrokerDiscovery(config);
  }
  const cli = import.meta.filename;
  const registrations = registerProjectBridges(config.root, cli);
  const runtime = await ensureRuntime(config, { cli });
  return {
    project: config.name,
    directory: config.directory,
    registrations,
    runtime: {
      started: runtime.started,
      broker: runtime.record?.brokerUrl ?? config.url,
      console: runtime.record?.consoleUrl ?? null,
      log: path.join(config.directory, RUNTIME_LOG),
    },
    pairingCode: ensurePairingCode(config.directory),
    next: [
      'Open the console URL and enter the pairing code.',
      'Claude Code: start `claude` in this folder and approve the project MCP server "agentmesh" when asked.',
      'Codex: start `codex` in this folder and trust the project so it loads .codex/config.toml.',
      'Either session: run mesh_join (or /mcp__agentmesh__lead) to join the team.',
    ],
  };
}

/**
 * Show or re-issue the persisted console pairing code.
 *
 * @param home - Home project whose console owns the code.
 * @param record - `--rotate` re-issues it.
 */
async function runPairingCode(home: MeshConfig, record: CliOptions): Promise<void> {
  const { ensurePairingCode, rotatePairingCode } = await import('./web/pairing.ts');
  const isRotated = record.rotate === true;
  print({
    pairingCode: isRotated ? rotatePairingCode(home.directory) : ensurePairingCode(home.directory),
    rotated: isRotated,
    note: isRotated
      ? 'A running console accepts only this code from its next pairing attempt; paired browsers keep their sessions.'
      : 'Pair locally; keep this code private.',
  });
}

/**
 * Run the first-run preflight without creating or changing project state.
 *
 * @param options - Project, console port and output format.
 * @returns Whether no check failed.
 * @throws {Error} When `--port` is not a valid port.
 */
async function isDoctorPassing(options: CliOptions): Promise<boolean> {
  const { DEFAULT_BROKER_PORT, formatDoctor, runDoctor } = await import('./doctor.ts');
  const project = path.resolve(options.project ?? process.cwd());
  const consolePort = options.port === undefined ? CONSOLE_PORT : Number(options.port);
  if (!Number.isSafeInteger(consolePort) || consolePort < 1 || consolePort > MAX_PORT) {
    throw new Error('Use a console port between 1 and 65535.');
  }
  const report = await runDoctor({ project, brokerPort: savedBrokerPort(project) ?? DEFAULT_BROKER_PORT, consolePort });
  if (options.json === true) {
    print(report);
  } else {
    process.stdout.write(formatDoctor(report));
  }
  return report.ok;
}

/**
 * Read the broker port an existing project saved, without migrating or creating anything.
 *
 * @param project - Project folder.
 * @returns Saved port, or null for a new or unreadable project.
 */
function savedBrokerPort(project: string): number | null {
  let saved: unknown;
  try {
    saved = readJsonFile(path.join(project, STATE_DIRECTORY_NAME, 'config.json'));
  } catch {
    return null;
  }
  const url = typeof saved === 'object' && saved !== null && 'url' in saved ? saved.url : undefined;
  if (typeof url !== 'string' || !URL.canParse(url)) {
    return null;
  }
  const { port: text } = new URL(url);
  const port = Number(text);
  return Number.isSafeInteger(port) && port > 0 ? port : null;
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
      'deny-tools': { type: 'string' },
      host: { type: 'string' },
      to: { type: 'string' },
      body: { type: 'string' },
      id: { type: 'string' },
      after: { type: 'string' },
      limit: { type: 'string' },
      all: { type: 'boolean' },
      apply: { type: 'boolean' },
      json: { type: 'boolean' },
      rotate: { type: 'boolean' },
      dir: { type: 'string' },
      autostart: { type: 'boolean' },
      'broker-port': { type: 'string' },
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
  return ![
    'attach',
    'backup',
    'doctor',
    'init',
    'start',
    'stop',
    'mcp',
    'pairing-code',
    'restore',
    'teams',
    'ui',
  ].includes(value);
}
