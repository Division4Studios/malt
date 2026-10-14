/**
 * Restartable rebranding of stopped project state, including owned Git worktrees.
 * Migration never merges stores or changes message/credential identities.
 *
 * @file
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  symlinkSync,
  readlinkSync,
} from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { z } from 'zod';

import { hasErrorCode } from './errors.ts';
import { writeAtomic } from './summary.ts';

/** Validated recursive JSON, never an unchecked cast from disk. */
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
/** Structured paths are rebased; free text and non-JSON artifacts are retained. */
const jsonSchema: z.ZodType<Json> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jsonSchema), z.record(jsonSchema)]),
);
/** Journal location remains identical through the directory rename. */
const JOURNAL = 'brand-migration.json';
/** Tables with structured factory paths; all other history remains untouched. */
const TABLES = [
  {
    name: 'factory_settings',
    select: 'SELECT rowid AS row, data FROM factory_settings',
    update: 'UPDATE factory_settings SET data=? WHERE rowid=?',
  },
  {
    name: 'factory_tasks',
    select: 'SELECT rowid AS row, data FROM factory_tasks',
    update: 'UPDATE factory_tasks SET data=? WHERE rowid=?',
  },
  {
    name: 'factory_task_versions',
    select: 'SELECT rowid AS row, data FROM factory_task_versions',
    update: 'UPDATE factory_task_versions SET data=? WHERE rowid=?',
  },
  {
    name: 'factory_jobs',
    select: 'SELECT rowid AS row, data FROM factory_jobs',
    update: 'UPDATE factory_jobs SET data=? WHERE rowid=?',
  },
  {
    name: 'factory_features',
    select: 'SELECT rowid AS row, data FROM factory_features',
    update: 'UPDATE factory_features SET data=? WHERE rowid=?',
  },
  {
    name: 'factory_skill_requests',
    select: 'SELECT rowid AS row, data FROM factory_skill_requests',
    update: 'UPDATE factory_skill_requests SET data=? WHERE rowid=?',
  },
];
/** Migration journal contains paths and status, never credentials. */
const journalSchema = z.object({
  version: z.literal(1),
  source: z.string(),
  destination: z.string(),
  complete: z.boolean(),
});
/** Only ownership-ledger entries can authorize Git repairs. */
const ownershipSchema = z.array(
  z.object({ id: z.string(), directory: z.string(), branch: z.string().nullable(), removed: z.boolean() }),
);

/**
 * Rebase only absolute path values confined to the old state root.
 *
 * @param value - Validated JSON value.
 * @param source - Old state root.
 * @param destination - New state root.
 * @returns Equivalent JSON with new operational paths.
 */
function rebase(value: Json, source: string, destination: string): Json {
  if (typeof value === 'string') {
    if (value === source || value.startsWith(`${source}${path.sep}`)) {
      return `${destination}${value.slice(source.length)}`;
    }
    const portableSource = source.replaceAll('\\', '/');
    return value === portableSource || value.startsWith(`${portableSource}/`)
      ? `${destination.replaceAll('\\', '/')}${value.slice(portableSource.length)}`
      : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => rebase(entry, source, destination));
  }
  return value !== null && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, rebase(entry, source, destination)]))
    : value;
}

/**
 * Atomically refresh one structured runtime file without modifying raw logs.
 *
 * @param file - Confined runtime JSON file.
 * @param source - Old state root.
 * @param destination - New state root.
 */
function rebaseFile(file: string, source: string, destination: string): void {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Caller supplies only JSON files under the selected private factory tree.
  const previous = readFileSync(file, 'utf8');
  const parsed = jsonSchema.parse(JSON.parse(previous));
  const updated = JSON.stringify(rebase(parsed, source, destination), null, 2);
  if (JSON.stringify(jsonSchema.parse(JSON.parse(previous))) !== JSON.stringify(JSON.parse(updated))) {
    writeAtomic(file, `${updated}\n`);
  }
}

/**
 * Update fixed table statements; migration never interpolates SQL identifiers.
 *
 * @param database - Exclusively held stopped store.
 * @param source - Old state root.
 * @param destination - New state root.
 */
function updateTables(database: DatabaseSync, source: string, destination: string): void {
  for (const table of TABLES) {
    if (
      database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table.name) === undefined
    ) {
      continue;
    }
    for (const raw of database.prepare(table.select).all()) {
      const row = z.object({ row: z.number(), data: z.string() }).parse(raw);
      const parsed = jsonSchema.parse(JSON.parse(row.data));
      const data = JSON.stringify(rebase(parsed, source, destination));
      database.prepare(table.update).run(data, row.row);
    }
  }
}

/**
 * Validate a fixed worktree link before removing the link itself.
 *
 * @param link - Owned memory link.
 * @param directory - Owned worktree.
 * @param source - Previous state root.
 * @param destination - Current state root.
 * @throws {Error} For unexpected files or foreign memory links.
 */
function removeMemoryLink(link: string, directory: string, source: string, destination: string): void {
  // eslint-disable-next-line security/detect-non-literal-fs-filename, n/no-sync -- Stopped bootstrap inspects only a fixed memory link in a ledger-owned worktree.
  const target = lstatSync(link);
  if (!target.isSymbolicLink()) {
    throw new Error('Preserved unexpected non-link worktree memory; reconcile before migration.');
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename, n/no-sync -- Verify the link target before replacing it; never follow or remove a foreign target.
  const previous = path.resolve(directory, readlinkSync(link));
  if (previous !== source && previous !== destination) {
    throw new Error('Preserved foreign worktree memory link; reconcile before migration.');
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename, n/no-sync -- Unlink only the verified owned link during synchronous stopped bootstrap.
  unlinkSync(link);
}

/**
 * Replace a memory symlink only when its target is the old or new project root.
 *
 * @param directory - Validated owned worktree.
 * @param source - Old state root.
 * @param destination - New state root.
 * @throws {Error} For unexpected links or real directories.
 */
function repairMemory(directory: string, source: string, destination: string): void {
  for (const name of ['.mlt', '.malt']) {
    const link = path.join(directory, name);
    try {
      removeMemoryLink(link, directory, source, destination);
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) {
        throw error;
      }
    }
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename, n/no-sync -- Stopped migration creates only a fixed project-memory link in a validated owned worktree.
  symlinkSync(destination, path.join(directory, '.malt'), process.platform === 'win32' ? 'junction' : 'dir');
}

/**
 * Rebase durable factory records inside one SQLite transaction.
 *
 * @param source - Old state root.
 * @param destination - New state root.
 * @throws {Error} For invalid records or database write failures.
 */
function rebaseDatabase(source: string, destination: string): void {
  const file = path.join(destination, 'state', 'mesh.db');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixed project-local database path.
  if (!existsSync(file)) {
    return;
  }
  using database = new DatabaseSync(file);
  try {
    database.exec('BEGIN IMMEDIATE');
    updateTables(database, source, destination);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Repair Git back-pointers and owned memory links after the physical move.
 *
 * @param root - Selected repository.
 * @param source - Old state root.
 * @param destination - New state root.
 * @throws {Error} For unsafe ownership or Git repair failures.
 */
function repairWorktrees(root: string, source: string, destination: string): void {
  const ledger = path.join(destination, 'factory', 'worktrees.json');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixed private ownership ledger.
  if (!existsSync(ledger)) {
    return;
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Validate ownership before issuing any Git or link operations.
  const records = ownershipSchema.parse(JSON.parse(readFileSync(ledger, 'utf8')));
  for (const record of records) {
    if (record.removed) {
      continue;
    }
    const directory = z.string().parse(rebase(record.directory, source, destination));
    const relative = path.relative(path.join(destination, 'worktrees'), directory);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Migration encountered a foreign worktree; repair its ownership ledger.');
    }
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Only validated owned worktrees are inspected.
    if (!existsSync(directory)) {
      continue;
    }
    // eslint-disable-next-line sonarjs/no-os-command-from-path, n/no-sync -- Stopped bootstrap runs shell-free Git only against an explicitly owned worktree.
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: directory,
      encoding: 'utf8',
    }).trim();
    // eslint-disable-next-line sonarjs/no-os-command-from-path, n/no-sync -- Compare repository identity before repairing any back-pointer.
    const original = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
    if (path.resolve(common) !== path.resolve(original)) {
      throw new Error('Migration worktree belongs to a different repository.');
    }
    // eslint-disable-next-line sonarjs/no-os-command-from-path, n/no-sync -- Shell-free stopped bootstrap repairs only ledger-owned worktrees belonging to the selected repository.
    execFileSync('git', ['worktree', 'repair', directory], { cwd: root, stdio: 'pipe' });
    repairMemory(directory, source, destination);
  }
  rebaseFile(ledger, source, destination);
}

/**
 * Move .mlt to .malt and resume interrupted repairs before any broker opens it.
 * Stop the broker first: SQLite WAL/SHM presence deliberately blocks migration.
 *
 * @param root - Absolute selected project root.
 * @throws {Error} For conflicting stores, unclean shutdown or unsafe ownership.
 */
export function migrateBrandState(root: string): void {
  const source = path.join(root, '.mlt');
  const destination = path.join(root, '.malt');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Inspect only fixed legacy and new state roots.
  if (existsSync(source)) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Never merge two state directories.
    if (existsSync(destination)) {
      throw new Error('Both .mlt and .malt exist. Reconcile the stores before migration.');
    }
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- The stopped legacy tree is inspected without following worktree links.
    const entries = readdirSync(path.join(source, 'state'));
    if (entries.some((entry) => entry.endsWith('.db-wal') || entry.endsWith('.db-shm'))) {
      throw new Error('Stop the legacy broker cleanly before migrating .mlt; SQLite journal files remain.');
    }
    writeAtomic(
      path.join(source, JOURNAL),
      `${JSON.stringify({ version: 1, source, destination, complete: false })}\n`,
    );
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Atomic rename of the entire verified stopped state directory.
    renameSync(source, destination);
  }
  const journal = path.join(destination, JOURNAL);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixed migration checkpoint in the selected state root.
  if (!existsSync(journal)) {
    return;
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Validate the fixed checkpoint before resuming repairs.
  const checkpoint = journalSchema.parse(JSON.parse(readFileSync(journal, 'utf8')));
  if (checkpoint.complete) {
    return;
  }
  if (checkpoint.source !== source || checkpoint.destination !== destination) {
    throw new Error('Migration checkpoint belongs to a different project; reconcile its paths.');
  }
  rebaseDatabase(source, destination);
  repairWorktrees(root, source, destination);
  const factory = path.join(destination, 'factory');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Only factory operational JSON is rebased; source trees, skills and raw logs are retained.
  if (existsSync(factory)) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Inspect the fixed factory artifact tree without following symbolic links.
    const entries = readdirSync(factory, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.json')) {
        rebaseFile(path.join(entry.parentPath, entry.name), source, destination);
      }
    }
  }
  writeAtomic(journal, `${JSON.stringify({ ...checkpoint, complete: true }, null, 2)}\n`);
}
