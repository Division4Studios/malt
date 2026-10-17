/**
 * Back up and restore a project's private `.malt` folder, so an upgrade can be
 * rolled back. A backup is a plain folder: every SQLite database is copied with
 * `VACUUM INTO`, which writes one consistent snapshot even while the broker is
 * running, and every other file is copied as it is. Owned worktrees and caches
 * are left out: they are disposable working copies whose branches stay in Git.
 *
 * Restoring needs the broker to be stopped. The current `.malt` is never
 * deleted; it is moved aside to `.malt.before-restore-<time>`, so a restore can
 * itself be undone.
 *
 * Backups hold the same secrets as `.malt` (tokens, identities, the secrets
 * vault key), so they are written owner-only and must be kept as private as
 * the project folder.
 *
 * @file
 */
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { STATE_DIRECTORY_NAME } from './config.ts';
import { MeshError } from './protocol.ts';

import type { MeshConfig } from './config.ts';

/** Top-level folders a backup leaves out. */
const SKIPPED_FOLDERS: ReadonlySet<string> = new Set(['worktrees', 'cache']);
/** SQLite side files; the snapshot already contains their committed content. */
const SQLITE_SIDE_FILES = /\.db-(?:journal|shm|wal)$/v;
/** Manifest written at the root of every backup. */
export const BACKUP_MANIFEST = 'malt-backup.json';
/** How long a broker health probe may take before the broker counts as stopped. */
const HEALTH_MS = 1500;
/** Owner-only folder mode on POSIX. */
const PRIVATE_FOLDER = 0o700;

/** What one backup contains. */
export interface BackupManifest {
  /** When it was taken, in milliseconds since the epoch. */
  readonly createdAt: number;
  /** Project folder it was taken from. */
  readonly project: string;
  /** Files copied, relative to `.malt`. */
  readonly files: number;
  /** SQLite databases snapshotted with `VACUUM INTO`. */
  readonly databases: readonly string[];
}

/** Files and databases one copy wrote. */
interface CopyResult {
  /** Plain files and databases copied. */
  readonly files: number;
  /** Databases snapshotted, relative to `.malt`. */
  readonly databases: readonly string[];
}

/**
 * Copy one file, snapshotting SQLite databases instead of copying their bytes.
 *
 * @param source - File to copy.
 * @param target - Destination file.
 * @returns What kind of file it was.
 */
async function copyEntry(source: string, target: string): Promise<'database' | 'file'> {
  if (source.endsWith('.db')) {
    snapshotDatabase(source, target);
    return 'database';
  }
  await copyFile(source, target);
  return 'file';
}

/**
 * Copy a folder tree, leaving out worktrees, caches and SQLite side files.
 *
 * @param from - Source folder.
 * @param to - Destination folder, created owner-only.
 * @param relative - Path of `from` relative to `.malt`.
 * @returns Files copied and databases snapshotted.
 */
async function copyTree(from: string, to: string, relative: string): Promise<CopyResult> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Paths stay under the operator's own .malt and backup folders.
  await mkdir(to, { recursive: true, mode: PRIVATE_FOLDER });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Reads the operator's own .malt folder.
  const entries = await readdir(from, { withFileTypes: true });
  let files = 0;
  const databases: string[] = [];
  for (const entry of entries) {
    const name = path.join(relative, entry.name);
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory() && (relative !== '' || !SKIPPED_FOLDERS.has(entry.name))) {
      // eslint-disable-next-line no-await-in-loop -- Folders are copied one at a time to bound open files.
      const nested = await copyTree(source, target, name);
      files += nested.files;
      databases.push(...nested.databases);
    } else if (entry.isFile() && !SQLITE_SIDE_FILES.test(entry.name)) {
      // eslint-disable-next-line no-await-in-loop -- Files are copied one at a time to bound open files.
      if ((await copyEntry(source, target)) === 'database') {
        databases.push(name.replaceAll('\\', '/'));
      }
      files += 1;
    }
  }
  return { files, databases };
}

/**
 * Write a consistent snapshot of a SQLite database.
 *
 * @param source - Live database file.
 * @param target - New snapshot file; must not exist.
 */
function snapshotDatabase(source: string, target: string): void {
  using database = new DatabaseSync(source, { readOnly: true });
  database.prepare('VACUUM INTO ?').run(target);
}

/**
 * Back up a project's `.malt` folder.
 *
 * @param config - The project configuration.
 * @param destination - New, empty or missing backup folder.
 * @param now - Clock, for the manifest.
 * @returns What was backed up.
 * @throws {MeshError} When the destination already holds files.
 */
export async function backupProject(
  config: MeshConfig,
  destination: string,
  now = Date.now(),
): Promise<BackupManifest> {
  const target = path.resolve(destination);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- The operator names the backup folder.
  const existing = existsSync(target) ? await readdir(target) : [];
  if (existing.length > 0) {
    throw new MeshError('INVALID_INPUT', `Backup folder ${target} is not empty. Choose a new folder.`);
  }
  const result = await copyTree(config.directory, path.join(target, STATE_DIRECTORY_NAME), '');
  const manifest: BackupManifest = { createdAt: now, project: config.root, ...result };
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Writes the manifest inside the new backup folder.
  await writeFile(path.join(target, BACKUP_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return manifest;
}

/**
 * Whether a broker answers for this project.
 *
 * @param config - The project configuration.
 * @returns True when its `/health` endpoint responds.
 */
export async function isBrokerRunning(config: MeshConfig): Promise<boolean> {
  try {
    const response = await fetch(new URL('/health', config.url), { signal: AbortSignal.timeout(HEALTH_MS) });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Restore a backup into a project, moving the current `.malt` aside.
 *
 * @param project - Project folder to restore into.
 * @param backup - Folder written by {@link backupProject}.
 * @param options - Whether a broker is running, and the clock.
 * @param options.isRunning - A broker answers for this project.
 * @param options.now - Clock, for the moved-aside folder name.
 * @returns Where the previous `.malt` was moved, or null when there was none.
 * @throws {MeshError} When the broker runs or the folder is not a MALT backup.
 */
export async function restoreProject(
  project: string,
  backup: string,
  options: { readonly isRunning: boolean; readonly now: number },
): Promise<string | null> {
  if (options.isRunning) {
    throw new MeshError('FACTORY_GATED', 'Stop the broker (and any console that owns one) before restoring.');
  }
  const source = path.resolve(backup);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- The operator names the backup folder.
  if (!existsSync(path.join(source, BACKUP_MANIFEST)) || !existsSync(path.join(source, STATE_DIRECTORY_NAME))) {
    throw new MeshError('INVALID_INPUT', `${source} is not a MALT backup (no ${BACKUP_MANIFEST}).`);
  }
  const current = path.join(path.resolve(project), STATE_DIRECTORY_NAME);
  let previous: string | null = null;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- The project's own .malt folder.
  if (existsSync(current)) {
    const moment = new Date(options.now);
    previous = `${current}.before-restore-${moment.toISOString().replaceAll(/[.:]/gv, '-')}`;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Moves the project's own .malt aside.
    await rename(current, previous);
  }
  await copyTree(path.join(source, STATE_DIRECTORY_NAME), current, '');
  return previous;
}
