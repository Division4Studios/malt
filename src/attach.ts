/**
 * Project-scoped MCP registration for `attach`.
 *
 * Claude Code reads `<project>/.mcp.json` and Codex reads
 * `<project>/.codex/config.toml` (in projects it trusts). Both take precedence
 * over a user-wide `agentmesh` entry of the same name, so attaching a project
 * never edits user-wide configuration and works next to an older Docker
 * registration. Each bridge runs this checkout's CLI with `--autostart`, so
 * opening a session in the project starts the project's broker when needed.
 *
 * The files hold machine-specific paths. A file Git already tracks is left
 * alone and reported; an untracked one is excluded through the repository's
 * local `info/exclude`, never through the shared `.gitignore`.
 *
 * @file
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { z } from 'zod/v3';

import { hasErrorCode } from './errors.ts';
import { writeAtomic } from './summary.ts';

/** MCP server name the bridge is registered under. */
export const SERVER_NAME = 'agentmesh';
/** Claude Code's project MCP file, relative to the project root. */
export const CLAUDE_MCP_FILE = '.mcp.json';
/** Codex's project configuration, relative to the project root. */
export const CODEX_CONFIG_FILE = path.join('.codex', 'config.toml');
/** First line of the managed Codex block. */
const CODEX_BEGIN = '# >>> malt attach: managed block, rewritten by `malt attach` >>>';
/** Last line of the managed Codex block. */
const CODEX_END = '# <<< malt attach <<<';
/** One bridge wait may last up to an hour; the broker renews internal waits. */
const TOOL_TIMEOUT_MS = 3_600_000;
/** The same allowance in the seconds Codex expects. */
const TOOL_TIMEOUT_SECONDS = 3600;
/** Codex's bridge startup allowance, in seconds. */
const CODEX_STARTUP_SECONDS = 30;
/** A JSON object whose members are not yet validated. */
const objectSchema = z.record(z.string(), z.unknown());

/**
 * Variables Codex forwards to the bridge. Codex passes MCP servers only a
 * minimal environment, and an auto-started broker inherits the bridge's, so
 * Git, GitHub CLI and the provider CLIs need these to find their own state.
 */
const CODEX_FORWARDED_VARIABLES = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'TMPDIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'SSH_AUTH_SOCK',
  'PATHEXT',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'TEMP',
  'TMP',
  'USERNAME',
] as const;

/** How one registration file ended up. */
export interface RegistrationOutcome {
  /** Absolute path of the file. */
  readonly file: string;
  /** Written or refreshed, already current, or left alone. */
  readonly state: 'skipped' | 'unchanged' | 'written';
  /** Why it was left alone. */
  readonly reason?: string;
}

/** Both providers' outcomes. */
export interface Registrations {
  /** Claude Code's `.mcp.json`. */
  readonly claude: RegistrationOutcome;
  /** Codex's `.codex/config.toml`. */
  readonly codex: RegistrationOutcome;
}

/** What a bridge registration runs. */
export interface BridgeCommand {
  /** Executable: the Node.js running this CLI. */
  readonly command: string;
  /** Arguments after the executable. */
  readonly args: readonly string[];
}

/** Git queries attach needs; replaceable in tests. */
export interface GitProbe {
  /** Whether Git tracks this project-relative path. */
  readonly isTracked: (root: string, relative: string) => boolean;
  /** Absolute path of the repository's local exclude file, or null outside Git. */
  readonly excludeFile: (root: string) => string | null;
}

/**
 * Run Git in the project, returning trimmed output or null on failure.
 *
 * @param root - Project root.
 * @param args - Git arguments.
 * @returns Output, or null when Git failed.
 */
function git(root: string, args: readonly string[]): string | null {
  try {
    // eslint-disable-next-line sonarjs/no-os-command-from-path, n/no-sync -- Shell-free, read-only Git queries in the operator's chosen project.
    return execFileSync('git', [...args], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim();
  } catch {
    return null;
  }
}

/** The real Git queries. */
const GIT: GitProbe = {
  isTracked: (root, relative) =>
    git(root, ['ls-files', '--error-unmatch', '--', relative.replaceAll('\\', '/')]) !== null,
  excludeFile: (root) => {
    const file = git(root, ['rev-parse', '--git-path', 'info/exclude']);
    return file === null ? null : path.resolve(root, file);
  },
};

/**
 * The bridge command for one provider.
 *
 * @param cli - Absolute path of MALT's `src/cli.ts`.
 * @param root - Project root.
 * @param provider - Which session runs the bridge.
 * @returns Executable and arguments.
 */
export function bridgeCommand(cli: string, root: string, provider: 'claude' | 'codex'): BridgeCommand {
  const identity =
    provider === 'claude'
      ? ['--provider', 'anthropic', '--runtime', 'claude-code']
      : // Codex reports no MCP roots, so the bridge is told its workspace.
        ['--provider', 'openai', '--runtime', 'codex-cli', '--workspace', root];
  return { command: process.execPath, args: [cli, 'mcp', '--project', root, ...identity, '--autostart'] };
}

/**
 * Read a text file, or null when it does not exist.
 *
 * @param file - Absolute path.
 * @returns Contents, or null.
 * @throws {Error} For errors other than a missing file.
 */
function readOptional(file: string): string | null {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- A fixed registration file inside the selected project.
    return readFileSync(file, 'utf8');
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return null;
    }
    throw error;
  }
}

/**
 * Keep an untracked registration file out of commits without touching `.gitignore`.
 *
 * @param root - Project root.
 * @param relative - Project-relative path.
 * @param probe - Git queries.
 */
function excludeLocally(root: string, relative: string, probe: GitProbe): void {
  const file = probe.excludeFile(root);
  if (file === null) {
    return;
  }
  const rule = `/${relative.replaceAll('\\', '/')}`;
  const existing = readOptional(file) ?? '';
  if (existing.split(/\r?\n/v).includes(rule)) {
    return;
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- The repository's own info folder.
  mkdirSync(path.dirname(file), { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename, n/no-sync -- The repository's own local exclude file.
  appendFileSync(file, `${existing === '' || existing.endsWith('\n') ? '' : '\n'}${rule}\n`);
}

/**
 * Write one registration file unless Git tracks it, then exclude it locally.
 *
 * @param root - Project root.
 * @param relative - Project-relative path.
 * @param next - Computes new contents from the current ones, or explains why not.
 * @param probe - Git queries.
 * @returns How the file ended up.
 */
function register(
  root: string,
  relative: string,
  next: (current: string | null) => string | { readonly reason: string },
  probe: GitProbe,
): RegistrationOutcome {
  const file = path.join(root, relative);
  if (probe.isTracked(root, relative)) {
    return {
      file,
      state: 'skipped',
      reason: 'Git tracks this file; add the entry by hand so machine paths are not committed.',
    };
  }
  const current = readOptional(file);
  const contents = next(current);
  if (typeof contents !== 'string') {
    return { file, state: 'skipped', reason: contents.reason };
  }
  excludeLocally(root, relative, probe);
  if (contents === current) {
    return { file, state: 'unchanged' };
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- The registration file's folder inside the selected project.
  mkdirSync(path.dirname(file), { recursive: true });
  writeAtomic(file, contents);
  return { file, state: 'written' };
}

/**
 * Merge the bridge into Claude Code's `.mcp.json`, keeping other servers.
 *
 * @param current - Existing contents, or null.
 * @param bridge - Bridge command.
 * @returns New contents, or why the file was left alone.
 */
export function mergeClaudeMcp(current: string | null, bridge: BridgeCommand): string | { readonly reason: string } {
  let document: unknown = {};
  if (current !== null && current.trim() !== '') {
    try {
      document = JSON.parse(current);
    } catch {
      return { reason: 'The file is not valid JSON; fix it and run attach again.' };
    }
  }
  const parsed = objectSchema.safeParse(document);
  if (!parsed.success) {
    return { reason: 'The file is not a JSON object; fix it and run attach again.' };
  }
  const servers = objectSchema.safeParse(parsed.data['mcpServers'] ?? {});
  if (!servers.success) {
    return { reason: 'mcpServers is not a JSON object; fix it and run attach again.' };
  }
  const entry = { type: 'stdio', command: bridge.command, args: bridge.args, timeout: TOOL_TIMEOUT_MS };
  const merged = { ...parsed.data, mcpServers: { ...servers.data, [SERVER_NAME]: entry } };
  return `${JSON.stringify(merged, null, 2)}\n`;
}

/**
 * A TOML basic string. JSON string escapes are valid TOML basic-string escapes.
 *
 * @param value - Text.
 * @returns Quoted TOML string.
 */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * Whether TOML text already has a table for this server.
 *
 * @param text - Codex configuration.
 * @returns True when a `[mcp_servers.agentmesh]` table or subtable exists.
 */
function hasServerTable(text: string): boolean {
  const table = `[mcp_servers.${SERVER_NAME}`;
  return text.split('\n').some((line) => {
    const compact = line.replaceAll(/\s/gv, '');
    return compact.startsWith(`${table}]`) || compact.startsWith(`${table}.`);
  });
}

/**
 * Merge the bridge into Codex's project configuration as one managed block.
 *
 * @param current - Existing contents, or null.
 * @param bridge - Bridge command.
 * @returns New contents, or why the file was left alone.
 */
export function mergeCodexConfig(current: string | null, bridge: BridgeCommand): string | { readonly reason: string } {
  const block = [
    CODEX_BEGIN,
    `[mcp_servers.${SERVER_NAME}]`,
    `command = ${tomlString(bridge.command)}`,
    `args = [${bridge.args.map((argument) => tomlString(argument)).join(', ')}]`,
    `env_vars = [${CODEX_FORWARDED_VARIABLES.map((name) => tomlString(name)).join(', ')}]`,
    `startup_timeout_sec = ${String(CODEX_STARTUP_SECONDS)}`,
    `tool_timeout_sec = ${String(TOOL_TIMEOUT_SECONDS)}`,
    CODEX_END,
  ].join('\n');
  const text = (current ?? '').replaceAll('\r\n', '\n');
  const begin = text.indexOf(CODEX_BEGIN);
  const end = text.indexOf(CODEX_END);
  if (begin !== -1 && end > begin) {
    return `${text.slice(0, begin)}${block}${text.slice(end + CODEX_END.length)}`;
  }
  if (hasServerTable(text)) {
    return { reason: `The file already defines mcp_servers.${SERVER_NAME}; remove it and run attach again.` };
  }
  let separator = '\n\n';
  if (text === '') {
    separator = '';
  } else if (text.endsWith('\n')) {
    separator = '\n';
  }
  return `${text}${separator}${block}\n`;
}

/**
 * Register the bridge for Claude Code and Codex in this project.
 *
 * @param root - Folder the project lives in.
 * @param cli - Absolute path of MALT's `src/cli.ts`.
 * @param probe - Git query overrides for tests.
 * @returns Each file's outcome.
 */
export function registerProjectBridges(root: string, cli: string, probe: GitProbe = GIT): Registrations {
  return {
    claude: register(
      root,
      CLAUDE_MCP_FILE,
      (current) => mergeClaudeMcp(current, bridgeCommand(cli, root, 'claude')),
      probe,
    ),
    codex: register(
      root,
      CODEX_CONFIG_FILE,
      (current) => mergeCodexConfig(current, bridgeCommand(cli, root, 'codex')),
      probe,
    ),
  };
}

/**
 * Whether Claude Code's MCP file registers this server.
 *
 * @param text - `.mcp.json` contents.
 * @returns False for invalid JSON or a missing entry.
 */
function hasClaudeServer(text: string): boolean {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return false;
  }
  const servers = objectSchema.safeParse(objectSchema.safeParse(document).data?.['mcpServers']);
  return servers.data?.[SERVER_NAME] !== undefined;
}

/**
 * Whether the project's registration files name this server.
 *
 * @param root - Folder the project lives in.
 * @returns Per provider, whether a project registration exists.
 */
export function projectRegistrations(root: string): { readonly claude: boolean; readonly codex: boolean } {
  const claude = readOptional(path.join(root, CLAUDE_MCP_FILE));
  const codex = readOptional(path.join(root, CODEX_CONFIG_FILE));
  return { claude: claude !== null && hasClaudeServer(claude), codex: codex !== null && hasServerTable(codex) };
}
