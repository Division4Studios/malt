/**
 * Workspace teams: one isolated team per project folder.
 *
 * A single broker serves its home project (the directory it was started with)
 * plus any number of workspace teams. Each team's ID, token, database,
 * roster, orchestrator and conversations live inside its actual workspace.
 * The home project keeps only routing references for reopening those stores.
 *
 * ```text
 * <workspace>/.malt/{config.json, state/mesh.db}
 * <home>/.malt/teams/<slug>.json
 * ```
 *
 * A team is identified by its workspace folder, normally the folder an MCP
 * host such as Claude Code was started in (reported through MCP roots). The
 * folder is normalized into a key, and the key is hashed into a stable,
 * filesystem-safe slug, so the same folder always reaches the same team and
 * different folders never share one. State from one project is therefore
 * never mistaken for another project's.
 *
 * @file
 */

import { createHash } from 'node:crypto';
import { mkdirSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod/v3';

import {
  STATE_DIRECTORY_NAME,
  hasErrorCode,
  loadConfig,
  migrateDirectory,
  readJsonFile,
  toLabel,
  writeIfAbsent,
} from './config.ts';
import { MeshError } from './protocol.ts';

import type { MeshConfig } from './config.ts';

/** Directory name, inside the home state directory, holding workspace teams. */
const TEAMS_DIRECTORY_NAME = 'teams';

/** Hex characters of the workspace hash kept in a team slug. */
const SLUG_HASH_LENGTH = 12;

/** Longest readable label at the start of a team slug. */
const SLUG_LABEL_MAX = 40;

/** Label used when a workspace folder name has no usable characters. */
const DEFAULT_SLUG_LABEL = 'team';

/** Filename extension length of a persisted routing reference. */
const REFERENCE_EXTENSION_LENGTH = '.json'.length;

/**
 * A team slug: a lowercase label, a hyphen and a hash. It doubles as a
 * directory name, so it never contains path separators or dots.
 */
const TEAM_SLUG_PATTERN = /^[\da-z][\d\-a-z]{0,62}$/v;

/** A Windows drive path such as `C:/work` (after slash normalization). */
const WINDOWS_DRIVE_PATTERN = /^[A-Za-z]:(?:\/|$)/v;

/** A drive path as it appears in a file URI's pathname, such as `/C:/work`. */
const URI_DRIVE_PATTERN = /^\/[A-Za-z]:(?:\/|$)/v;

/** Persistent routing reference; no messages or credentials live here. */
const referenceSchema = z.object({ version: z.literal(1), workspace: z.string() }).strict();

/** A normalized workspace folder. */
export interface Workspace {
  /** Comparison key: case-folded on Windows, whose paths are case-insensitive. */
  readonly key: string;
  /** The folder as reported, with forward slashes; shown to people. */
  readonly display: string;
  /** The folder's last path segment; the team's display name. */
  readonly name: string;
}

/** What `open_team` returns: everything a client needs to address a team. */
export const teamAccessSchema = z.object({
  team: z.string(),
  name: z.string(),
  workspace: z.string(),
  storageRoot: z.string(),
  projectId: z.string(),
  token: z.string(),
});

/** Access details for one workspace team. */
export type TeamAccess = z.output<typeof teamAccessSchema>;

/** A workspace team's configuration, tagged with the team's slug. */
export type TeamConfig = MeshConfig & { readonly team: string };

/** One workspace team as listed by `list_teams`. */
export interface TeamSummary {
  /** The team's slug, as sent in the `x-agentmesh-team` header. */
  readonly team: string;
  /** The team's display name. */
  readonly name: string;
  /** The workspace folder the team serves. */
  readonly workspace: string | null;
}

/**
 * Normalize a workspace folder given as an absolute path or a `file:` URI.
 *
 * Backslashes become forward slashes, trailing slashes are dropped, and the
 * leading slash of a URI drive path (`/C:/work`) is removed. Windows paths
 * are compared case-insensitively, POSIX paths exactly.
 *
 * @param raw - The folder, for example `file:///E:/work/app` or `/srv/app`.
 * @returns The normalized workspace.
 * @throws {MeshError} NO_WORKSPACE for relative or unparseable locations.
 */
export function normalizeWorkspace(raw: string): Workspace {
  let location = raw.trim();
  if (/^file:/iv.test(location)) {
    let url: URL;
    try {
      url = new URL(location);
    } catch (error) {
      throw new MeshError('NO_WORKSPACE', 'The workspace URI is malformed.', { cause: error });
    }
    const pathname = decodeURIComponent(url.pathname);
    // A host names a UNC share: file://server/share/folder.
    location = url.host === '' ? pathname : `//${url.host}${pathname}`;
  }
  location = location.replaceAll('\\', '/');
  if (URI_DRIVE_PATTERN.test(location)) {
    location = location.slice(1);
  }
  const isWindows = WINDOWS_DRIVE_PATTERN.test(location) || location.startsWith('//');
  if (!isWindows && !location.startsWith('/')) {
    throw new MeshError('NO_WORKSPACE', 'The workspace must be an absolute path or a file URI.');
  }
  const uncPrefix = location.startsWith('//') ? '/' : '';
  location = uncPrefix + path.posix.normalize(location);
  let trimmed = location;
  while (trimmed.endsWith('/')) {
    trimmed = trimmed.slice(0, -1);
  }
  // Keep a lone root ("/" or "C:/") recognisable after trimming.
  const display = trimmed === '' || trimmed.endsWith(':') ? `${trimmed}/` : trimmed;
  const name = display.split('/').findLast((segment) => segment !== '' && !segment.endsWith(':')) ?? display;
  return { key: isWindows ? display.toLowerCase() : display, display, name };
}

/**
 * Derive the stable slug of a workspace's team.
 *
 * @param workspace - The normalized workspace.
 * @returns A readable label from the folder name plus a hash of its key.
 */
export function teamSlug(workspace: Workspace): string {
  const label = toLabel(workspace.name, SLUG_LABEL_MAX);
  const hash = createHash('sha256').update(workspace.key).digest('hex').slice(0, SLUG_HASH_LENGTH);
  return `${label === '' ? DEFAULT_SLUG_LABEL : label}-${hash}`;
}

/**
 * The project root holding a team's files.
 *
 * @param home - The home project's configuration.
 * @param slug - The team's slug; validated here because it becomes a path.
 * @returns The team's project root directory.
 * @throws {MeshError} UNKNOWN_TEAM for a malformed slug.
 */
function teamRoot(home: MeshConfig, slug: string): string {
  if (!TEAM_SLUG_PATTERN.test(slug)) {
    throw new MeshError('UNKNOWN_TEAM', 'No such team.');
  }
  return path.join(home.directory, TEAMS_DIRECTORY_NAME, slug);
}

/**
 * Resolve a host workspace to the broker's filesystem, including Docker mounts.
 * A broker never invents an inaccessible host directory inside its own container.
 *
 * @param workspace - Normalized host workspace.
 * @returns The accessible project directory on the broker.
 * @throws {MeshError} WORKSPACE_UNAVAILABLE for inaccessible or unmapped folders.
 */
export function workspaceRoot(workspace: Workspace): string {
  const hostRoot = process.env['AGENTMESH_HOST_ROOT'];
  const mountRoot = process.env['AGENTMESH_MOUNT_ROOT'];
  let root = workspace.display;
  if (hostRoot !== undefined && hostRoot !== '' && mountRoot !== undefined && mountRoot !== '') {
    const host = normalizeWorkspace(hostRoot);
    const prefix = host.key.endsWith('/') ? host.key : `${host.key}/`;
    if (workspace.key !== host.key && !workspace.key.startsWith(prefix)) {
      throw new MeshError('WORKSPACE_UNAVAILABLE', 'The workspace is outside the configured Docker workspace mount.');
    }
    root = path.resolve(mountRoot, workspace.display.slice(host.display.length).replace(/^\//v, ''));
    const relative = path.relative(path.resolve(mountRoot), root);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new MeshError('WORKSPACE_UNAVAILABLE', 'The workspace escapes the configured Docker workspace mount.');
    }
  } else if (process.platform !== 'win32' && (WINDOWS_DRIVE_PATTERN.test(root) || root.startsWith('//'))) {
    throw new MeshError(
      'WORKSPACE_UNAVAILABLE',
      'Mount the host workspace and configure AGENTMESH_HOST_ROOT and AGENTMESH_MOUNT_ROOT, or run the broker natively.',
    );
  }
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- The broker verifies the user-selected workspace before storing anything there.
    if (!statSync(root).isDirectory()) {
      throw new Error('Not a directory.');
    }
  } catch (error) {
    throw new MeshError(
      'WORKSPACE_UNAVAILABLE',
      'The project folder is not accessible to the broker. Mount it or run the broker natively.',
      { cause: error },
    );
  }
  return path.resolve(root);
}

/**
 * Open a workspace's team, creating it on first use.
 *
 * A new team inherits the home project's broker URL and presence timing, so
 * the broker's sweeps and the bridges' heartbeats agree in every team.
 *
 * @param home - The home project's configuration.
 * @param workspace - The normalized workspace.
 * @returns The team's configuration, tagged with its slug.
 */
export function createTeam(home: MeshConfig, workspace: Workspace): TeamConfig {
  const team = teamSlug(workspace);
  const root = workspaceRoot(workspace);
  const legacyRoot = teamRoot(home, team);
  // Old brokers kept workspace data centrally. Relocate the whole stopped
  // store before creating anything in the target project.
  migrateDirectory(path.join(legacyRoot, '.agentmesh'), path.join(root, STATE_DIRECTORY_NAME));
  migrateDirectory(path.join(legacyRoot, '.mlt'), path.join(root, STATE_DIRECTORY_NAME));
  migrateDirectory(path.join(legacyRoot, STATE_DIRECTORY_NAME), path.join(root, STATE_DIRECTORY_NAME));
  const config = loadConfig(root, {
    create: true,
    initial: {
      name: workspace.name,
      url: home.url,
      heartbeatMs: home.heartbeatMs,
      offlineMs: home.offlineMs,
      workspace: workspace.display,
    },
  });
  // A tiny routing index lets the broker reopen projects after a restart.
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- The index lives under the broker's project-local state directory.
  mkdirSync(path.dirname(legacyRoot), { recursive: true });
  writeIfAbsent(`${legacyRoot}.json`, `${JSON.stringify({ version: 1, workspace: workspace.display }, null, 2)}\n`);
  return { ...config, team };
}

/**
 * Load an existing team's configuration.
 *
 * @param home - The home project's configuration.
 * @param slug - The slug from the request's team header; untrusted.
 * @returns The team's configuration, tagged with its slug.
 * @throws {MeshError} UNKNOWN_TEAM when no such team exists.
 */
export function loadTeam(home: MeshConfig, slug: string): TeamConfig {
  try {
    const reference = referenceSchema.parse(readJsonFile(`${teamRoot(home, slug)}.json`));
    const workspace = normalizeWorkspace(reference.workspace);
    if (teamSlug(workspace) !== slug) {
      throw new MeshError('UNKNOWN_TEAM', 'The workspace routing reference does not match its team.');
    }
    return { ...loadConfig(workspaceRoot(workspace)), team: slug };
  } catch (error) {
    if (
      error instanceof MeshError ||
      hasErrorCode(error, 'ENOENT') ||
      (Error.isError(error) && hasErrorCode(error.cause, 'ENOENT'))
    ) {
      throw new MeshError('UNKNOWN_TEAM', 'No such team.', { cause: error });
    }
    throw error;
  }
}

/**
 * List the workspace teams stored under a home project.
 *
 * @param home - The home project's configuration.
 * @returns Every readable team, ordered by display name.
 */
export async function listTeams(home: MeshConfig): Promise<TeamSummary[]> {
  let entries: string[];
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- The path is derived from the home project root, which is this tool's purpose.
    entries = await readdir(path.join(home.directory, TEAMS_DIRECTORY_NAME));
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return [];
    }
    throw error;
  }
  const teams: TeamSummary[] = [];
  for (const entry of entries) {
    const slug = entry.endsWith('.json') ? entry.slice(0, -REFERENCE_EXTENSION_LENGTH) : entry;
    if (!TEAM_SLUG_PATTERN.test(slug)) {
      continue;
    }
    try {
      const config = loadTeam(home, slug);
      teams.push({ team: slug, name: config.name, workspace: config.workspace ?? null });
    } catch {
      // A half-created or damaged team directory is skipped, not fatal.
    }
  }
  return teams.toSorted((left, right) => left.name.localeCompare(right.name));
}
