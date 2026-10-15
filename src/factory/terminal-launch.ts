/** @file Server-owned interactive launch contracts; callers cannot provide arguments or environment. */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import { z } from 'zod/v3';

import { MeshError } from '../protocol.ts';

import { subscriptionEnvironment } from './authentication.ts';
import { MAX_COLUMNS, MAX_ROWS, MIN_COLUMNS, MIN_ROWS } from './terminal-frames.ts';

/** Maximum native filesystem metadata length. */
const PATH_LIMIT = 4096;
/** Bound unpaid native configuration inspection. */
const INSPECT_MS = 15_000;
/** Bound private CLI configuration before retaining only server names. */
const INSPECT_BYTES = 262_144;
/** Shell-free native CLI inspection. */
const execute = promisify(execFile);
/** This CLI override path supports only simple server identifiers. */
const MCP_NAME_MAX = 200;
/** Maximum configured MCP server count for one isolated terminal. */
const MCP_SERVERS_MAX = 100;
/** Validated override-path component. */
const mcpNameSchema = z
  .string()
  .min(1)
  .max(MCP_NAME_MAX)
  .regex(/^[\w\-]+$/v);
/** Only names survive the boundary; command arguments and HTTP headers are discarded. */
const mcpListSchema = z.array(z.object({ name: mcpNameSchema })).max(MCP_SERVERS_MAX);
/** Bounded descriptor, delivered only by the owning supervisor. */
export const terminalLaunchSchema = z
  .object({
    provider: z.enum(['codex', 'claude']),
    file: z.string().min(1).max(PATH_LIMIT),
    cwd: z
      .string()
      .min(1)
      .max(PATH_LIMIT)
      .refine((value) => path.isAbsolute(value)),
    columns: z.number().int().min(MIN_COLUMNS).max(MAX_COLUMNS),
    rows: z.number().int().min(MIN_ROWS).max(MAX_ROWS),
    mcpServers: z.array(mcpNameSchema).max(MCP_SERVERS_MAX).default([]),
  })
  .strict()
  .refine(
    (value) => [value.provider, `${value.provider}.exe`].includes(path.basename(value.file).toLowerCase()),
    'Expected a configured native provider executable.',
  );
/** Strict persisted launch metadata; no credentials or operator input. */
export type TerminalLaunch = z.infer<typeof terminalLaunchSchema>;
/** Server-built input before descriptor defaults are applied. */
export type TerminalLaunchInput = z.input<typeof terminalLaunchSchema>;
/** Only environment required for native subscription credential discovery and process startup. */
const ENVIRONMENT_KEYS: ReadonlySet<string> = new Set([
  'PATH',
  'PATHEXT',
  'HOME',
  'USERPROFILE',
  'SYSTEMROOT',
  'WINDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'LOCALAPPDATA',
  'APPDATA',
]);

/**
 * Construct the minimal environment without caller-supplied overrides.
 *
 * @param source - Owning process environment, never serialized.
 * @returns Subscription-only terminal environment.
 */
export function terminalEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const retained: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && ENVIRONMENT_KEYS.has(key.toUpperCase())) {
      retained[key] = value;
    }
  }
  const sanitized = subscriptionEnvironment(retained);
  return { ...sanitized, TERM: 'xterm-256color', CLAUDE_CODE_SKIP_PROMPT_HISTORY: '1' };
}

/**
 * Fixed literal arguments; no resume, remote, shell or approval-bypass mode.
 *
 * @param input - Server descriptor before default fields are applied.
 * @returns Native argument vector.
 */
export function terminalArguments(input: z.input<typeof terminalLaunchSchema>): string[] {
  const launch = terminalLaunchSchema.parse(input);
  return launch.provider === 'claude'
    ? ['--restricted', '--strict-mcp-config', '--permission-mode', 'manual']
    : [
        '--sandbox',
        'workspace-write',
        '--ask-for-approval',
        'on-request',
        '--cd',
        launch.cwd,
        '--no-daemon',
        '-c',
        'forced_login_method="chatgpt"',
        '-c',
        'model_provider="openai"',
        '-c',
        'history.persistence="none"',
        ...launch.mcpServers.flatMap((name) => ['-c', `mcp_servers.${name}.enabled=false`]),
      ];
}

/**
 * Inspect names in the exact scratch context without connecting MCP servers or invoking inference.
 *
 * @param file - Already validated configured Codex executable.
 * @param cwd - Owned scratch worktree.
 * @returns Server names to disable in the frozen descriptor.
 * @throws {MeshError} If configuration cannot be isolated by this CLI.
 */
export async function terminalMcpServers(file: string, cwd: string): Promise<string[]> {
  try {
    const response = await execute(file, ['mcp', 'list', '--json'], {
      cwd,
      env: terminalEnvironment(process.env),
      windowsHide: true,
      timeout: INSPECT_MS,
      maxBuffer: INSPECT_BYTES,
      encoding: 'utf8',
    });
    return mcpListSchema.parse(JSON.parse(response.stdout)).map((entry) => entry.name);
  } catch {
    throw new MeshError(
      'FACTORY_GATED',
      'Cannot isolate native MCP configuration. Verify Codex and use simple MCP server names before starting a terminal.',
    );
  }
}
