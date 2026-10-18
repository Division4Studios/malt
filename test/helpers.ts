/**
 * Shared fixtures for the MALT test suites.
 *
 * Every test runs against its own temporary project directory, so tests are
 * fully isolated from each other and from any real team. Helpers here create
 * those projects, adjust their persisted configuration (which bridge
 * subprocesses read from disk), poll for asynchronous conditions, and drive
 * real MCP bridge subprocesses through the official MCP SDK client.
 *
 * Nothing in this module calls a model: the "agents" in tests are SDK clients
 * and {@link AgentClient} instances.
 *
 * @file
 */

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod/v3';

import { PROJECT_OPERATOR } from '../src/capability-endpoints.ts';
import { loadConfig } from '../src/config.ts';
import { ProjectGitHub } from '../src/github.ts';

import type { ClientResults } from '../src/client.ts';
import type { MeshConfig } from '../src/config.ts';
import type { WorkState } from '../src/coordination.ts';
import type { AgentRow } from '../src/database.ts';
import type { GitHubRunner } from '../src/github.ts';
import type { ToolOperation } from '../src/protocol.ts';
import type { InboxPage } from '../src/store.ts';
import type { Buffer } from 'node:buffer';
import type { TestContext } from 'node:test';

/** Configuration fields a test may override before anything reads them. */
export type ConfigOverrides = Partial<Pick<MeshConfig, 'heartbeatMs' | 'offlineMs' | 'url'>>;

/** Default deadline for {@link until}, in milliseconds. */
const UNTIL_TIMEOUT_MS = 3000;

/** Poll interval for {@link until}, in milliseconds. */
const UNTIL_POLL_MS = 5;

/** Absolute path of the CLI entry point launched as an MCP bridge. */
export const CLI_PATH = path.resolve('src/cli.ts');

/** Registers a cleanup callback; callbacks run last-in, first-out. */
export type Defer = (callback: () => unknown) => void;

/**
 * Create a last-in, first-out cleanup stack for a test.
 *
 * `node:test` runs `after` hooks in registration order, but resources must be
 * released in reverse: clients before the broker, the broker (and its SQLite
 * file) before the temporary directory, which Windows cannot delete while the
 * database is open. Every callback runs even if an earlier one fails; all
 * failures are reported together.
 *
 * @param t - The running test.
 * @returns A function that registers a cleanup callback.
 */
export function createCleanup(t: TestContext): Defer {
  const cleanups: (() => unknown)[] = [];
  t.after(async () => {
    const failures: unknown[] = [];
    for (const cleanup of cleanups.toReversed()) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Test cleanup failed');
    }
  });
  return (cleanup) => {
    cleanups.push(cleanup);
  };
}

/**
 * Create a temporary project, removed when the test's cleanup runs.
 *
 * @param defer - The test's cleanup stack.
 * @param prefix - Directory name prefix, to identify leftovers if any.
 * @returns The new project's configuration.
 */
export function createProject(defer: Defer, prefix = 'agentmesh-test-'): MeshConfig {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  defer(() => {
    // Windows console teardown can briefly retain the directory after every owned PID exits.
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return loadConfig(root, { create: true });
}

/**
 * Persist configuration changes to `config.json` and reload.
 *
 * Bridge subprocesses read the configuration from disk, so any change they
 * must observe (broker port, heartbeat timing) has to be written, not just
 * applied to an in-memory object.
 *
 * @param config - The current configuration.
 * @param overrides - The fields to change.
 * @returns The reloaded configuration.
 */
export function updateConfig(config: MeshConfig, overrides: ConfigOverrides): MeshConfig {
  const persisted = {
    version: config.version,
    projectId: config.projectId,
    name: config.name,
    url: overrides.url ?? config.url,
    token: config.token,
    heartbeatMs: overrides.heartbeatMs ?? config.heartbeatMs,
    offlineMs: overrides.offlineMs ?? config.offlineMs,
  };
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- The path is inside the test's own temporary project.
  writeFileSync(path.join(config.directory, 'config.json'), `${JSON.stringify(persisted, null, 2)}\n`);
  return loadConfig(config.root);
}

/**
 * The local URL of a broker listening on `port`.
 *
 * @param port - The broker's bound port.
 * @returns An `http://127.0.0.1:<port>` URL suitable for `config.url`.
 */
export function brokerUrl(port: number): string {
  return `http://127.0.0.1:${String(port)}`;
}

/**
 * Wait until a condition holds, polling briefly.
 *
 * @param isReady - Returns `true` once the awaited condition holds.
 * @param timeoutMs - How long to wait before failing.
 * @throws {Error} When the condition does not hold in time.
 */
export async function until(isReady: () => boolean, timeoutMs = UNTIL_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!isReady()) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for test condition');
    }
    await delay(UNTIL_POLL_MS);
  }
}

/** Registration input for a store-level agent. */
export interface TestRegistration {
  /** The agent's name. */
  readonly name: string;
  /** The agent's identity secret. */
  readonly secret: string;
  /** The session UUID. */
  readonly sessionId: string;
  /** Provider label. */
  readonly provider: string;
  /** Runtime label. */
  readonly runtime: string;
  /** Role label. */
  readonly role: string;
}

/**
 * Build registration input with a fresh secret and session.
 *
 * @param name - The agent's name.
 * @returns Registration input for `Store.register`.
 */
export function registration(name: string): TestRegistration {
  return { name, secret: randomUUID(), sessionId: randomUUID(), provider: 'test', runtime: 'test', role: 'generalist' };
}

/** The result of `mesh_join`. */
export interface JoinResult {
  /** Whether this call joined the team. */
  readonly joined: boolean;
  /** The team joined. */
  readonly team: { readonly name: string; readonly workspace: string | null };
  /** The session's agent record. */
  readonly agent: AgentRow;
  /** The session's coordination view. */
  readonly state: WorkState;
}

/** The result type of each MCP tool, keyed by tool name. */
export type ToolResults = { readonly [O in ToolOperation as `mesh_${O}`]: ClientResults[O] } & {
  /** The membership created or confirmed by joining. */
  readonly mesh_join: JoinResult;
  /** The identity registered for the bridge. */
  readonly mesh_register: AgentRow;
  /** The first page of unread messages. */
  readonly mesh_get_unread_messages: InboxPage;
};

/** A raw MCP tool response: its error flag and decoded JSON payload. */
export interface RawToolResult {
  /** Whether the tool reported an error. */
  readonly isError: boolean;
  /** The decoded JSON payload. */
  readonly payload: unknown;
}

/** A connected MCP bridge subprocess. */
export interface BridgeHandle {
  /** The SDK client connected to the bridge. */
  readonly client: Client;
  /** Diagnostics the bridge wrote to stderr so far. */
  readonly diagnostics: () => string;
  /** Call a tool and return its decoded payload, whether or not it failed. */
  readonly callRaw: (name: keyof ToolResults, args?: Record<string, unknown>) => Promise<RawToolResult>;
  /** Call a tool that must succeed, returning its typed result. */
  readonly call: <N extends keyof ToolResults>(name: N, args?: Record<string, unknown>) => Promise<ToolResults[N]>;
}

/** Options for {@link startBridge}. */
export interface BridgeOptions {
  /** The agent's name; omit for a nameless session that joins on request. */
  readonly name?: string;
  /** Role label of a named agent, for example `lead` or `observer`. */
  readonly role?: string;
  /** Provider label. */
  readonly provider?: string;
  /** Runtime label; also the prefix of a session's generated name. */
  readonly runtime?: string;
  /** The `--workspace` option of the bridge. */
  readonly workspace?: string;
  /** Workspace roots the test host reports through MCP roots. */
  readonly roots?: readonly string[];
  /** Whether to run the bridge with debug logging. */
  readonly isVerbose?: boolean;
}

/** One text content block of a tool response. */
const textContentSchema = z.object({ type: z.literal('text'), text: z.string() });

/** The shape of every tool response: one text block holding JSON. */
const toolResponseSchema = z.object({ isError: z.boolean().optional(), content: z.array(textContentSchema).min(1) });

/**
 * Launch a real MCP bridge subprocess and connect an SDK client to it.
 *
 * @param config - The project configuration (read from disk by the bridge).
 * @param options - The agent identity and logging options.
 * @returns A handle for calling tools and inspecting diagnostics.
 */
export async function startBridge(config: MeshConfig, options: BridgeOptions): Promise<BridgeHandle> {
  const args = [
    CLI_PATH,
    'mcp',
    '--project',
    config.root,
    ...(options.name === undefined ? [] : ['--name', options.name, '--role', options.role ?? 'generalist']),
    '--provider',
    options.provider ?? 'test',
    ...(options.runtime === undefined ? [] : ['--runtime', options.runtime]),
    ...(options.workspace === undefined ? [] : ['--workspace', options.workspace]),
    ...(options.isVerbose === true ? ['--verbose'] : []),
  ];
  const transport = new StdioClientTransport({ command: process.execPath, args, stderr: 'pipe' });
  let diagnostics = '';
  transport.stderr?.on('data', (chunk: Buffer) => {
    diagnostics += chunk.toString('utf8');
  });
  const { roots } = options;
  const client = new Client(
    { name: 'agentmesh-test-host', version: '1.0' },
    roots === undefined ? {} : { capabilities: { roots: {} } },
  );
  if (roots !== undefined) {
    client.setRequestHandler(ListRootsRequestSchema, () => ({ roots: roots.map((uri) => ({ uri })) }));
  }
  await client.connect(transport);

  const callRaw = async (
    name: keyof ToolResults,
    toolArguments: Record<string, unknown> = {},
  ): Promise<RawToolResult> => {
    const response = toolResponseSchema.parse(await client.callTool({ name, arguments: toolArguments }));
    const [first] = response.content;
    const payload: unknown = first === undefined ? undefined : JSON.parse(first.text);
    return { isError: response.isError === true, payload };
  };
  const call = async <N extends keyof ToolResults>(
    name: N,
    toolArguments: Record<string, unknown> = {},
  ): Promise<ToolResults[N]> => {
    const result = await callRaw(name, toolArguments);
    if (result.isError) {
      throw new Error(`${name} failed: ${JSON.stringify(result.payload)}\n${diagnostics}`);
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- The bridge returns the broker's typed results as JSON; ToolResults is that contract.
    return result.payload as ToolResults[N];
  };
  return { client, diagnostics: () => diagnostics, callRaw, call };
}

/** The payload of a failed tool call. */
const toolErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

/**
 * Extract the error code from a failed tool call's payload.
 *
 * @param payload - The decoded tool payload.
 * @returns The machine-readable code, such as `WAIT_SUPERSEDED`.
 */
export function toolErrorCode(payload: unknown): string {
  return toolErrorSchema.parse(payload).error.code;
}

/** The project-token human, as the broker derives it for web and CLI callers. */
export const OPERATOR = PROJECT_OPERATOR;

/**
 * Build a GitHub integration for connection and journal mechanics tests.
 * Capability decisions are covered against the real policy store in
 * `capability-enforcement.test.ts`; here every principal is allowed.
 *
 * @param config - Disposable project.
 * @param runner - Optional fixture GitHub CLI.
 * @returns Integration with an allow-all gate bound.
 */
export function mechanicsGitHub(config: MeshConfig, runner?: GitHubRunner): ProjectGitHub {
  return new ProjectGitHub(config, runner, {
    authorize: () => {
      /* Mechanics tests do not exercise capability policy. */
    },
    grantConnectionDefaults: () => {
      /* No policy to grant into. */
    },
  });
}
