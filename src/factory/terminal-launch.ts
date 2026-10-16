/** @file Server-owned interactive launch contracts; callers cannot provide arguments or environment. */
import path from 'node:path';

import { z } from 'zod/v3';

import { subscriptionEnvironment } from './authentication.ts';
import { MAX_COLUMNS, MAX_ROWS, MIN_COLUMNS, MIN_ROWS } from './terminal-frames.ts';

/** Maximum native filesystem metadata length. */
const PATH_LIMIT = 4096;
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
  })
  .strict()
  .refine(
    (value) => [value.provider, `${value.provider}.exe`].includes(path.basename(value.file).toLowerCase()),
    'Expected a configured native provider executable.',
  );
/** Strict persisted launch metadata; no credentials or operator input. */
export type TerminalLaunch = z.infer<typeof terminalLaunchSchema>;
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
 * @param launch - Validated server descriptor.
 * @returns Native argument vector.
 */
export function terminalArguments(launch: TerminalLaunch): string[] {
  terminalLaunchSchema.parse(launch);
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
        '-c',
        'mcp_servers.agentmesh.enabled=false',
      ];
}
