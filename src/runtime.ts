/**
 * A project's background runtime: one `ui --with-broker` process that owns the
 * project's broker and console, started on demand and discoverable through
 * `.malt/runtime.json`.
 *
 * `attach` starts it from the operator's shell, and an MCP bridge started with
 * `--autostart` starts it again when nothing answers, so a session can bring
 * MALT up by itself. An exclusive lock file keeps two bridges that start at
 * the same moment from launching two runtimes. The runtime's output goes to
 * `.malt/logs/runtime.log`; nothing is written outside the project's `.malt`.
 *
 * @file
 */
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { z } from 'zod/v3';

import { rpc } from './client.ts';
import { hasErrorCode } from './errors.ts';
import { MeshError } from './protocol.ts';
import { writeAtomic } from './summary.ts';

import type { MeshConfig } from './config.ts';

/** Discovery record of the running runtime, inside `.malt`. */
export const RUNTIME_FILE = 'runtime.json';
/** Runtime output, relative to `.malt`. */
export const RUNTIME_LOG = path.join('logs', 'runtime.log');
/** Exclusive start lock, inside `.malt`. */
const LOCK_FILE = 'runtime.lock';
/** Console port a runtime prefers; another free port is used when it is taken. */
export const PREFERRED_CONSOLE_PORT = 4318;
/** How long a start may take before it is reported as failed. */
const START_TIMEOUT_MS = 30_000;
/** Interval between readiness probes while a runtime starts. */
const POLL_MS = 250;
/** A start lock older than this was left by a starter that died. */
const STALE_LOCK_MS = 60_000;
/** Private file mode for runtime records. */
const PRIVATE_FILE_MODE = 0o600;
/** Private directory mode for the log folder. */
const PRIVATE_DIRECTORY_MODE = 0o700;

/** What `.malt/runtime.json` records. */
const runtimeSchema = z.object({
  pid: z.number().int().positive(),
  brokerUrl: z.string().url(),
  consoleUrl: z.string().url(),
  startedAt: z.number().int(),
});

/** The running runtime's process and addresses. */
export type RuntimeRecord = z.output<typeof runtimeSchema>;

/** Who answers on the project's broker address. */
export type BrokerPresence = 'absent' | 'foreign' | 'ours';

/** Side effects of {@link ensureRuntime}; every one is replaceable in tests. */
export interface RuntimeProbes {
  /** Who answers on the project's broker address. */
  readonly presence: (config: MeshConfig) => Promise<BrokerPresence>;
  /** Start a detached runtime and return its process ID. */
  readonly launch: (request: LaunchRequest) => number;
  /** Whether a TCP port can be bound on loopback. */
  readonly isPortFree: (port: number) => Promise<boolean>;
  /** Whether a process is alive. */
  readonly isAlive: (pid: number) => boolean;
  /** Current time in milliseconds. */
  readonly now: () => number;
}

/** What a launcher starts. */
export interface LaunchRequest {
  /** Absolute path of MALT's `src/cli.ts`. */
  readonly cli: string;
  /** Project root. */
  readonly root: string;
  /** Console port to bind; 0 lets the operating system choose. */
  readonly consolePort: number;
  /** Absolute path of the log file the runtime writes. */
  readonly log: string;
}

/** Options for {@link ensureRuntime}. */
export interface EnsureRuntimeOptions {
  /** Absolute path of MALT's `src/cli.ts`. */
  readonly cli: string;
  /** Start deadline in milliseconds. */
  readonly timeoutMs?: number;
  /** Probe overrides. */
  readonly probes?: Partial<RuntimeProbes>;
}

/** Outcome of {@link ensureRuntime}. */
export interface EnsuredRuntime {
  /** True when this call started the runtime. */
  readonly started: boolean;
  /** The runtime's record; null when a broker answers that was started some other way. */
  readonly record: RuntimeRecord | null;
}

/** Variables of the session that spawned a bridge, which must not leak into managed processes. */
const SESSION_VARIABLES = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_PROJECT_DIR'];

/**
 * Ask the project's broker who it serves.
 *
 * @param config - Project configuration.
 * @returns `ours` when it accepts the project token, `foreign` when another
 *   project's broker answers, `absent` when nothing does.
 */
export async function brokerPresence(config: MeshConfig): Promise<BrokerPresence> {
  try {
    await rpc(config, 'team_status', {});
    return 'ours';
  } catch (error) {
    if (error instanceof MeshError && error.code === 'BROKER_UNAVAILABLE') {
      return 'absent';
    }
    return error instanceof MeshError && error.code === 'UNAUTHORIZED' ? 'foreign' : 'ours';
  }
}

/**
 * Whether a loopback port can be bound right now.
 *
 * @param port - TCP port.
 * @returns True when nothing listens on it.
 */
export async function isPortFree(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => {
      resolve(false);
    });
    server.listen(port, '127.0.0.1', () => {
      server.close(() => {
        resolve(true);
      });
    });
  });
}

/**
 * Whether a process is alive. A signal of 0 only checks for existence.
 *
 * @param pid - Process ID.
 * @returns True when the process exists.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to someone else.
    return hasErrorCode(error, 'EPERM');
  }
}

/**
 * Start a detached `ui --with-broker` process that outlives its starter.
 *
 * @param request - What to start and where it logs.
 * @returns The started process ID.
 * @throws {Error} When the process cannot be spawned.
 */
function launchDetached(request: LaunchRequest): number {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- The log folder is inside the selected project's .malt.
  mkdirSync(path.dirname(request.log), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  // eslint-disable-next-line security/detect-non-literal-fs-filename, n/no-sync -- The child inherits this descriptor; the log is inside .malt.
  const output = openSync(request.log, 'a', PRIVATE_FILE_MODE);
  try {
    const environment = { ...process.env };
    for (const name of SESSION_VARIABLES) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- Removes a fixed list of host-session variables.
      delete environment[name];
    }
    const child = spawn(
      process.execPath,
      [request.cli, 'ui', '--with-broker', '--project', request.root, '--port', String(request.consolePort)],
      { cwd: request.root, detached: true, env: environment, stdio: ['ignore', output, output], windowsHide: true },
    );
    child.unref();
    if (child.pid === undefined) {
      throw new Error('The MALT runtime could not be started.');
    }
    return child.pid;
  } finally {
    // eslint-disable-next-line n/no-sync -- The child holds its own copy of the descriptor.
    closeSync(output);
  }
}

/** The real probes. */
const DEFAULT_PROBES: RuntimeProbes = {
  presence: brokerPresence,
  launch: launchDetached,
  isPortFree,
  isAlive: isProcessAlive,
  now: Date.now,
};

/**
 * Read the runtime record, if one exists and is valid.
 *
 * @param config - The project's `.malt` location.
 * @returns The record, or null.
 */
export function readRuntimeRecord(config: Pick<MeshConfig, 'directory'>): RuntimeRecord | null {
  const file = path.join(config.directory, RUNTIME_FILE);
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- A fixed file inside the selected project's .malt.
    const parsed = runtimeSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Record the running runtime so bridges and `stop` can find it.
 *
 * @param config - Project configuration.
 * @param record - This process and its addresses.
 */
export function writeRuntimeRecord(config: MeshConfig, record: RuntimeRecord): void {
  writeAtomic(path.join(config.directory, RUNTIME_FILE), `${JSON.stringify(record, null, 2)}\n`);
}

/**
 * Remove the runtime record if it still names this process.
 *
 * @param config - Project configuration.
 * @param pid - Process whose record to remove.
 */
export function clearRuntimeRecord(config: MeshConfig, pid: number): void {
  if (readRuntimeRecord(config)?.pid === pid) {
    rmSync(path.join(config.directory, RUNTIME_FILE), { force: true });
  }
}

/**
 * Create the lock file exclusively.
 *
 * @param file - Path of `.malt/runtime.lock`.
 * @returns True when this process created it.
 * @throws {Error} For filesystem errors other than an existing lock.
 */
function wasLockCreated(file: string): boolean {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- An exclusive create is the lock; the file is inside .malt.
    writeFileSync(file, String(process.pid), { flag: 'wx', mode: PRIVATE_FILE_MODE });
    return true;
  } catch (error) {
    if (hasErrorCode(error, 'EEXIST')) {
      return false;
    }
    throw error;
  }
}

/**
 * Whether an existing lock was left by a starter that died or hung.
 *
 * @param file - Path of `.malt/runtime.lock`.
 * @param probes - Clock and liveness.
 * @returns True when it can be replaced.
 */
function isLockStale(file: string, probes: RuntimeProbes): boolean {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- The lock file is inside .malt.
    const holder = Number(readFileSync(file, 'utf8'));
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- The lock file is inside .malt.
    const age = probes.now() - statSync(file).mtimeMs;
    return age > STALE_LOCK_MS || !Number.isSafeInteger(holder) || !probes.isAlive(holder);
  } catch {
    // Released between the create attempt and this read.
    return true;
  }
}

/**
 * Take the exclusive start lock, replacing one left by a starter that died.
 *
 * @param file - Path of `.malt/runtime.lock`.
 * @param probes - Clock and liveness.
 * @returns True when this process now holds the lock.
 */
function hasTakenLock(file: string, probes: RuntimeProbes): boolean {
  if (wasLockCreated(file)) {
    return true;
  }
  if (!isLockStale(file, probes)) {
    return false;
  }
  rmSync(file, { force: true });
  return wasLockCreated(file);
}

/**
 * Wait until this project's broker answers and, when a pid is known, its
 * runtime record names that process.
 *
 * @param config - Project configuration.
 * @param probes - Presence probe and clock.
 * @param deadline - Absolute deadline.
 * @param pid - Process this call started, if any.
 * @returns The record once ready, or null when a broker started some other way answers.
 * @throws {MeshError} When the deadline passes or the started process exits.
 */
async function waitUntilReady(
  config: MeshConfig,
  probes: RuntimeProbes,
  deadline: number,
  pid: number | null,
): Promise<RuntimeRecord | null> {
  while (probes.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop -- Readiness is polled sequentially until the deadline.
    const presence = await probes.presence(config);
    const record = readRuntimeRecord(config);
    if (presence === 'ours' && (pid === null || record?.pid === pid)) {
      return record;
    }
    if (pid !== null && !probes.isAlive(pid)) {
      break;
    }
    // eslint-disable-next-line no-await-in-loop -- Readiness is polled sequentially until the deadline.
    await delay(POLL_MS);
  }
  throw new MeshError(
    'BROKER_UNAVAILABLE',
    `The MALT runtime did not start. See ${path.join(config.directory, RUNTIME_LOG)}.`,
  );
}

/**
 * Make sure this project's broker and console are running, starting a
 * detached runtime when nothing answers.
 *
 * @param config - Project configuration.
 * @param options - Where MALT's CLI is, the start deadline and probe overrides.
 * @returns Whether this call started it, and its record.
 * @throws {MeshError} WRONG_PROJECT when another project's broker holds the
 *   address, BROKER_UNAVAILABLE when the start fails.
 */
export async function ensureRuntime(config: MeshConfig, options: EnsureRuntimeOptions): Promise<EnsuredRuntime> {
  const probes: RuntimeProbes = { ...DEFAULT_PROBES, ...options.probes };
  const deadline = probes.now() + (options.timeoutMs ?? START_TIMEOUT_MS);
  const presence = await probes.presence(config);
  if (presence === 'ours') {
    return { started: false, record: readRuntimeRecord(config) };
  }
  if (presence === 'foreign') {
    throw new MeshError(
      'WRONG_PROJECT',
      `Another project's broker (or a Docker broker) answers on ${config.url}. Stop it, or give this project its own port with attach --broker-port PORT.`,
    );
  }
  const lock = path.join(config.directory, LOCK_FILE);
  if (!hasTakenLock(lock, probes)) {
    // Another bridge is starting it; wait for that start instead of racing it.
    return { started: false, record: await waitUntilReady(config, probes, deadline, null) };
  }
  try {
    const consolePort = (await probes.isPortFree(PREFERRED_CONSOLE_PORT)) ? PREFERRED_CONSOLE_PORT : 0;
    const pid = probes.launch({
      cli: options.cli,
      root: config.root,
      consolePort,
      log: path.join(config.directory, RUNTIME_LOG),
    });
    return { started: true, record: await waitUntilReady(config, probes, deadline, pid) };
  } finally {
    rmSync(lock, { force: true });
  }
}

/**
 * Stop the background runtime recorded for this project.
 *
 * On POSIX the runtime receives SIGTERM and shuts down in order. Windows has
 * no catchable termination signal, so the process ends at once; pause the
 * factory first so owned work is settled.
 *
 * @param config - Project configuration.
 * @param probes - Liveness, presence and clock overrides.
 * @returns The stopped process ID, or null when no runtime was recorded.
 * @throws {MeshError} When the runtime is still answering after the deadline.
 */
export async function stopRuntime(config: MeshConfig, probes: Partial<RuntimeProbes> = {}): Promise<number | null> {
  const selected: RuntimeProbes = { ...DEFAULT_PROBES, ...probes };
  const record = readRuntimeRecord(config);
  if (record === null || !selected.isAlive(record.pid)) {
    if (record !== null) {
      clearRuntimeRecord(config, record.pid);
    }
    return null;
  }
  process.kill(record.pid, 'SIGTERM');
  const deadline = selected.now() + START_TIMEOUT_MS;
  while (selected.now() < deadline && selected.isAlive(record.pid)) {
    // eslint-disable-next-line no-await-in-loop -- Shutdown is polled sequentially until the deadline.
    await delay(POLL_MS);
  }
  if (selected.isAlive(record.pid)) {
    throw new MeshError('BROKER_STOPPING', `The MALT runtime (process ${String(record.pid)}) is still shutting down.`);
  }
  clearRuntimeRecord(config, record.pid);
  return record.pid;
}
