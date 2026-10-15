/**
 * Project configuration and persistent agent identities.
 *
 * A "project" (or team) is a directory containing a `.malt/` directory with this layout.
 *
 * ```text
 * .malt/
 *     config.json            project ID, display name, broker URL, bearer token
 *     identities/<name>.json one durable secret per agent name
 *     state/mesh.db          SQLite state (plus WAL files)
 *     teams/<slug>.json      workspace routing references only (see teams.ts)
 *     github/                project-specific GitHub connection and operation journals
 *     knowledge/             lessons, pinned research, reviewed skill candidates
 *     skills/                active skill manifest and retained versions
 *     README.md              generated public state overview
 * ```
 *
 * The project ID separates teams: a broker rejects requests carrying another
 * project's ID, and a database refuses to open for the wrong project. The
 * bearer token authenticates local RPC; it is unrelated to any model-provider
 * credential, and neither value is ever logged. Configuration lives beside the
 * SQLite state so that the workspace's .malt directory preserves both together.
 *
 * Every file read from disk is validated with a schema, so a hand-edited or
 * truncated file produces a clear error instead of undefined behaviour.
 *
 * @file
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { z } from 'zod/v3';

import { hasErrorCode } from './errors.ts';
import { ensureProjectGuidance } from './guidance.ts';
import { ensurePrivateStateIgnored } from './private-state.ts';
import { AGENT_NAME_PATTERN } from './protocol.ts';
import { migrateBrandState } from './state-migration.ts';
import { writeAtomic } from './summary.ts';

export { hasErrorCode } from './errors.ts';

/** Directory name, inside the project root, that holds all MALT state. */
export const STATE_DIRECTORY_NAME = '.malt';

/** Directory used by releases before project-local storage. */
const LEGACY_DIRECTORY_NAME = '.agentmesh';

/** Number of random bytes in project tokens and identity secrets. */
const SECRET_BYTES = 32;

/** Number of random bytes in the suffix of a generated session name. */
const SESSION_SUFFIX_BYTES = 4;

/** Longest prefix of a generated session name, leaving room for the suffix. */
const SESSION_PREFIX_MAX = 40;

/** Prefix of a generated session name when no runtime label is available. */
const DEFAULT_SESSION_PREFIX = 'agent';

/** Minimum heartbeat interval accepted from configuration, in milliseconds. */
const HEARTBEAT_MIN_MS = 100;

/** Default interval between bridge heartbeats, in milliseconds. */
const DEFAULT_HEARTBEAT_MS = 15_000;

/** Default silence after which an agent is considered offline, in milliseconds. */
const DEFAULT_OFFLINE_MS = 60_000;

/**
 * The offline threshold must cover at least this many heartbeat intervals, so
 * one delayed heartbeat never marks a live agent offline.
 */
const HEARTBEATS_PER_OFFLINE_WINDOW = 2;

/** Default broker URL. Docker publishes the same port on host loopback. */
const DEFAULT_URL = 'http://127.0.0.1:4317';

/**
 * Hostnames the broker URL may use. The HTTP transport intentionally has no
 * remote or TLS mode at this milestone; inside Docker, bridges also reach the
 * broker over loopback within the container.
 */
const LOCAL_HOSTNAMES: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Owner-only permissions for directories holding secrets. */
const PRIVATE_DIRECTORY_MODE = 0o700;

/** Owner-only permissions for files holding secrets. */
const PRIVATE_FILE_MODE = 0o600;

/** Error message shown for any structurally invalid configuration file. */
const INVALID_CONFIGURATION = 'Invalid MALT configuration.';

/** Schema of `config.json` exactly as persisted on disk. */
const persistedConfigSchema = z
  .object({
    version: z.literal(1),
    projectId: z.string().min(1),
    name: z.string().min(1),
    url: z.string().url(),
    token: z.string().min(SECRET_BYTES),
    heartbeatMs: z.number().int().min(HEARTBEAT_MIN_MS),
    offlineMs: z.number().int(),
    // The workspace folder a team serves; absent for the home project.
    workspace: z.string().optional(),
  })
  .refine((config) => config.offlineMs >= config.heartbeatMs * HEARTBEATS_PER_OFFLINE_WINDOW, {
    message: 'offlineMs must be at least twice heartbeatMs',
  });

/** The persisted configuration fields. */
type PersistedConfig = z.output<typeof persistedConfigSchema>;

/**
 * A loaded project configuration: the persisted fields plus the locations
 * derived from the project root.
 */
export interface MeshConfig extends Readonly<PersistedConfig> {
  /** Absolute path of the project root directory. */
  readonly root: string;
  /** Absolute path of the `.malt` state directory. */
  readonly directory: string;
  /** Absolute path of the SQLite database file. */
  readonly database: string;

  /**
   * The workspace team this configuration addresses, sent to the broker with
   * every request; absent for the home project. Returned paths address the
   * actual workspace store on the broker's filesystem, including mapped
   * Docker paths, so named identity files are also project-local.
   */
  readonly team?: string | undefined;
}

/** Settings a newly created project starts with instead of the defaults. */
export type InitialSettings = Partial<
  Pick<PersistedConfig, 'heartbeatMs' | 'name' | 'offlineMs' | 'url' | 'workspace'>
>;

/** Options for {@link loadConfig}. */
export interface LoadConfigOptions {
  /** Create the project (directories, config and token) if it is missing. */
  readonly create?: boolean;
  /** Settings used only when this call creates the project. */
  readonly initial?: InitialSettings;
}

/** Schema of an identity file. */
const identitySchema = z.object({ name: z.string().regex(AGENT_NAME_PATTERN), secret: z.string().min(SECRET_BYTES) });

/** A durable agent identity: its name and the secret proving ownership. */
export type Identity = z.output<typeof identitySchema>;

/**
 * Write a file only if it does not already exist.
 *
 * Exclusive creation (`wx`) makes concurrent first runs safe: exactly one
 * writer creates the file and every other caller reuses it, so a restart can
 * never replace an existing team's ID, token or identity secret.
 *
 * @param file - Absolute path of the file.
 * @param contents - Contents to write if the file is created.
 * @returns Whether the file was created or already existed.
 * @throws {Error} Any filesystem error other than "already exists".
 */
export function writeIfAbsent(file: string, contents: string): 'created' | 'exists' {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- The path is derived from the user's chosen project root, which is this tool's purpose.
    writeFileSync(file, contents, { flag: 'wx', mode: PRIVATE_FILE_MODE });
    return 'created';
  } catch (error) {
    if (!hasErrorCode(error, 'EEXIST')) {
      throw error;
    }
    return 'exists';
  }
}

/**
 * Read and parse a JSON file.
 *
 * @param file - Absolute path of the file.
 * @returns The parsed, still unvalidated JSON value.
 */
export function readJsonFile(file: string): unknown {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- The path is derived from the user's chosen project root, which is this tool's purpose.
  return JSON.parse(readFileSync(file, 'utf8'));
}

/**
 * Load a team's configuration, optionally creating it first.
 *
 * Creation is only requested by `init` and `start`. Every other command must
 * find an existing project, so a typo in `--project` reports a missing project
 * rather than silently creating a new, empty team.
 *
 * @param project - Project directory; defaults to the current directory.
 * @param options - Loading options.
 * @returns The validated configuration with derived paths.
 * @throws {Error} When the project is missing, invalid, or not local-only.
 */
export function loadConfig(project: string = process.cwd(), options: LoadConfigOptions = {}): MeshConfig {
  const root = path.resolve(project);
  const directory = path.join(root, STATE_DIRECTORY_NAME);
  migrateBrandState(root);
  migrateDirectory(path.join(root, LEGACY_DIRECTORY_NAME), directory);
  const file = path.join(directory, 'config.json');

  if (options.create === true) {
    // The state directory is private: it holds the project token.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- The path is derived from the user's chosen project root, which is this tool's purpose.
    mkdirSync(path.join(directory, 'state'), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    ensurePrivateStateIgnored(root, directory);
    // A non-empty explicit display name wins; otherwise use the directory's
    // name. An empty variable (for example `AGENTMESH_PROJECT_NAME=`) counts as unset.
    const configuredName = process.env['AGENTMESH_PROJECT_NAME'];
    const initial: PersistedConfig = {
      version: 1,
      projectId: randomUUID(),
      name: configuredName !== undefined && configuredName !== '' ? configuredName : path.basename(root),
      url: DEFAULT_URL,
      token: randomBytes(SECRET_BYTES).toString('hex'),
      heartbeatMs: DEFAULT_HEARTBEAT_MS,
      offlineMs: DEFAULT_OFFLINE_MS,
      ...options.initial,
    };
    writeIfAbsent(file, `${JSON.stringify(initial, null, 2)}\n`);
    writeIfAbsent(
      path.join(directory, 'README.md'),
      "# MALT project state\n\nThis directory holds this project's durable configuration, identities, messages, decisions and event history.\n\nThe broker refreshes this file from committed state when it starts and after changes.\n\n- `config.json`: local broker access configuration (contains a secret).\n- `identities/`: durable agent credentials (private).\n- `state/mesh.db`: messages, agents, work decisions and event history.\n- `github/`: this project's GitHub connection, cached board and operation journal.\n- `teams/`: workspace routing references only; each workspace stores its own state in its `.malt`.\n\nRuntime files are ignored by Git. Do not publish credentials or database files.\n",
    );
  }

  let raw: unknown;
  try {
    raw = readJsonFile(file);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      throw new Error(`No MALT project at ${root}. Run malt init first.`, { cause: error });
    }
    throw error;
  }

  const parsed = persistedConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(INVALID_CONFIGURATION, { cause: parsed.error });
  }

  // Refuse any non-local broker URL; see LOCAL_HOSTNAMES.
  const url = new URL(parsed.data.url);
  if (url.protocol !== 'http:' || !LOCAL_HOSTNAMES.has(url.hostname)) {
    throw new Error('The broker URL must use local HTTP.');
  }

  ensurePrivateStateIgnored(root, directory);
  if (options.create === true) {
    // Project discovery never changes user-wide provider configuration.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Shared skills remain inside the selected project's state directory.
    mkdirSync(path.join(directory, 'skills'), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    writeIfAbsent(
      path.join(directory, 'skills', 'README.md'),
      '# Project skill library\n\nNo skills adopted yet. Use mesh_learning_status to inspect lessons and candidates. Independent lead review precedes human approval through factory_skill_decide. Approved local revisions override bundled defaults for new assignments.\n',
    );
    ensureProjectGuidance(root);
  }
  return { ...parsed.data, root, directory, database: path.join(directory, 'state', 'mesh.db') };
}

/**
 * Persist the CLI-selected loopback discovery URL without derived paths.
 *
 * @param config - Selected project configuration.
 * @throws {Error} When the discovery URL is invalid or cannot be persisted.
 */
export function saveBrokerDiscovery(config: MeshConfig): void {
  const parsed = persistedConfigSchema.parse(config);
  const url = new URL(parsed.url);
  if (url.protocol !== 'http:' || !LOCAL_HOSTNAMES.has(url.hostname)) {
    throw new Error('The broker URL must use local HTTP.');
  }
  writeAtomic(path.join(config.directory, 'config.json'), `${JSON.stringify(parsed, null, 2)}\n`);
}

/**
 * Move stopped legacy state as one directory, preserving every durable file.
 * Refuse a live or unclean SQLite journal and refuse to combine two stores.
 *
 * @param source - Legacy state directory.
 * @param destination - Project-local state directory.
 * @throws {Error} When migration needs shutdown or the destination already exists.
 */
export function migrateDirectory(source: string, destination: string): void {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Both paths are derived from validated project roots.
  if (!existsSync(source)) {
    return;
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- The destination is the requested project's state directory.
  if (existsSync(destination)) {
    throw new Error(`Both ${source} and ${destination} exist. Reconcile the stores before migration.`);
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Inspect only the legacy state directory before moving it.
  const entries = readdirSync(source, { recursive: true, encoding: 'utf8' });
  if (entries.some((entry) => entry.endsWith('.db-wal') || entry.endsWith('.db-shm'))) {
    throw new Error(`Stop the legacy broker cleanly before migrating ${source}; SQLite journal files remain.`);
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Move the entire verified stopped store, never individual SQLite files.
  renameSync(source, destination);
}

/**
 * Load the durable identity for an agent name, creating it on first use.
 *
 * Only the identity secret is persisted. A fresh session UUID is generated by
 * the client on every launch and is never treated as a durable identity; the
 * secret proves "I am this agent", the session proves "I am its live bridge".
 *
 * @param config - The project configuration.
 * @param agentName - The agent's name; also used as the identity filename.
 * @returns The agent's name and secret.
 * @throws {Error} When the name is unsafe or the identity file is invalid.
 */
export function loadIdentity(config: MeshConfig, agentName: string): Identity {
  // The name becomes a filename, so reject path separators and traversal
  // before it ever touches the filesystem.
  if (!AGENT_NAME_PATTERN.test(agentName)) {
    throw new Error('Agent names must use 1–64 letters, digits, underscores or hyphens.');
  }
  const file = path.join(config.directory, 'identities', `${agentName}.json`);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- The path is derived from the project root and a validated agent name.
  mkdirSync(path.dirname(file), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  writeIfAbsent(file, JSON.stringify({ name: agentName, secret: randomBytes(SECRET_BYTES).toString('hex') }));

  const parsed = identitySchema.safeParse(readJsonFile(file));
  if (!parsed.success) {
    throw new Error(`Invalid identity file for ${agentName}.`, { cause: parsed.error });
  }
  return parsed.data;
}

/**
 * Turn free text into a lowercase, hyphen-separated label of letters and
 * digits, suitable for names and directory names.
 *
 * @param text - The text, such as a runtime label or a folder name.
 * @param maxLength - The longest label to return.
 * @returns The label; empty when the text has no letters or digits.
 */
export function toLabel(text: string, maxLength: number): string {
  const words = text.toLowerCase().split(/[^\da-z]+/v);
  // Cutting at maxLength can leave one trailing hyphen; drop it.
  return words
    .filter((word) => word !== '')
    .join('-')
    .slice(0, maxLength)
    .replace(/-$/v, '');
}

/**
 * Create a session identity for one bridge process.
 *
 * Unlike {@link loadIdentity}, nothing is written to disk: the secret exists
 * only in the bridge's memory, so the identity ends with the process. The
 * name combines a readable prefix (normally the runtime label, such as
 * `claude-code`) with a random suffix, so concurrent sessions never collide.
 *
 * @param label - The label the name starts with; sanitized to the name pattern.
 * @returns A fresh name and secret.
 */
export function sessionIdentity(label = ''): Identity {
  const prefix = toLabel(label, SESSION_PREFIX_MAX);
  const suffix = randomBytes(SESSION_SUFFIX_BYTES).toString('hex');
  return {
    name: `${prefix === '' ? DEFAULT_SESSION_PREFIX : prefix}-${suffix}`,
    secret: randomBytes(SECRET_BYTES).toString('hex'),
  };
}
