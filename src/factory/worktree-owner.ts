/**
 * One execution environment owns a project's `.malt/worktrees`. Host and
 * Docker supervisors see the same files under different paths, and a Git
 * worktree's links only resolve on the side that created it, so mixing them
 * breaks Git in both. The first supervisor to dispatch records its project
 * root and platform; a supervisor started elsewhere, or a ledger that lists
 * worktrees outside this environment's root, refuses dispatch with one
 * message until the operator stops the other environment and hands
 * ownership over explicitly.
 *
 * @file
 */
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import { z } from 'zod/v3';

import { readJsonFile } from '../config.ts';
import { MeshError } from '../protocol.ts';
import { writeAtomic } from '../summary.ts';

import type { MeshConfig } from '../config.ts';

/** Earlier owners kept for the record. */
const HANDOVERS_KEPT = 10;

/** Where a supervisor runs. */
const environmentSchema = z.object({
  root: z.string(),
  platform: z.string(),
  isContainer: z.boolean(),
});
/** An earlier owner and when it handed over. */
const handoverSchema = environmentSchema.extend({ until: z.number() });
/** The recorded owner and its handovers. */
const ownerSchema = environmentSchema.extend({
  recordedAt: z.number(),
  handovers: z.array(handoverSchema).default([]),
});
/** The recorded owner of `.malt/worktrees`. */
export type WorktreeOwner = z.output<typeof ownerSchema>;
/** One entry of the owned-worktree ledger. */
const ledgerSchema = z.array(z.object({ directory: z.string(), removed: z.boolean() }).passthrough());

/**
 * This supervisor's environment.
 *
 * @param mesh - Project configuration.
 * @returns Project root, platform and whether it runs in a container.
 */
export function currentEnvironment(mesh: MeshConfig): z.output<typeof environmentSchema> {
  return { root: path.resolve(mesh.root), platform: process.platform, isContainer: existsSync('/.dockerenv') };
}

/**
 * How an environment is named in messages.
 *
 * @param environment - Root, platform and container flag.
 * @returns For example `Docker container (linux) at /data`.
 */
function describe(environment: z.output<typeof environmentSchema>): string {
  return `${environment.isContainer ? 'Docker container' : 'host'} (${environment.platform}) at ${environment.root}`;
}

/**
 * Where the owner record lives.
 *
 * @param mesh - Project configuration.
 * @returns `.malt/worktrees/owner.json`.
 */
function ownerFile(mesh: MeshConfig): string {
  return path.join(mesh.directory, 'worktrees', 'owner.json');
}

/**
 * Read the recorded owner.
 *
 * @param mesh - Project configuration.
 * @returns The owner, or null before any supervisor dispatched.
 */
export function readOwner(mesh: MeshConfig): WorktreeOwner | null {
  const file = ownerFile(mesh);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- The project's fixed owner record.
  return existsSync(file) ? ownerSchema.parse(readJsonFile(file)) : null;
}

/**
 * Persist the owner record, creating `.malt/worktrees` when needed.
 *
 * @param mesh - Project configuration.
 * @param owner - Record to write.
 */
function writeOwner(mesh: MeshConfig, owner: WorktreeOwner): void {
  const file = ownerFile(mesh);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- The project's fixed private worktree folder.
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeAtomic(file, `${JSON.stringify(owner, null, 2)}\n`);
}

/**
 * Ledger worktrees this environment did not create.
 *
 * @param mesh - Project configuration.
 * @returns Their recorded directories.
 */
function foreignWorktrees(mesh: MeshConfig): string[] {
  const ledger = path.join(mesh.directory, 'factory', 'worktrees.json');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- The project's fixed worktree ledger.
  if (!existsSync(ledger)) {
    return [];
  }
  const root = path.join(path.resolve(mesh.directory), 'worktrees');
  return ledgerSchema
    .parse(readJsonFile(ledger))
    .filter((entry) => !entry.removed)
    .map((entry) => entry.directory)
    .filter((directory) => {
      const relative = path.relative(root, path.resolve(directory));
      return relative.startsWith('..') || path.isAbsolute(relative);
    });
}

/**
 * Why this supervisor must not dispatch, if another environment owns the worktrees.
 * The first supervisor to ask becomes the owner, unless the ledger already lists
 * worktrees created elsewhere; then the operator must adopt them explicitly.
 *
 * @param mesh - Project configuration.
 * @param now - Current time.
 * @returns The refusal, or null when this environment owns the worktrees.
 */
export function worktreeOwnerBlocker(mesh: MeshConfig, now: number): string | null {
  const here = currentEnvironment(mesh);
  const owner = readOwner(mesh);
  if (owner !== null && owner.root === here.root && owner.platform === here.platform) {
    return null;
  }
  const foreign = owner === null ? foreignWorktrees(mesh) : [];
  if (owner === null && foreign.length === 0) {
    writeOwner(mesh, { ...here, recordedAt: now, handovers: [] });
    return null;
  }
  const holder = owner === null ? `another environment (it registered ${foreign[0] ?? ''})` : `the ${describe(owner)}`;
  return `.malt/worktrees belongs to ${holder}, but this supervisor runs in the ${describe(here)}. Host and Docker must never share worktrees. Stop the other environment, then run factory-worktrees-adopt here to hand ownership over. No worktree was touched.`;
}

/**
 * Hand ownership of the worktrees to this environment, recording the previous owner.
 *
 * @param mesh - Project configuration.
 * @param now - Handover time.
 * @returns The new owner record.
 * @throws {MeshError} When this environment already owns them, or worktrees the other environment created remain.
 */
export function adoptWorktrees(mesh: MeshConfig, now: number): WorktreeOwner {
  const here = currentEnvironment(mesh);
  const owner = readOwner(mesh);
  if (owner !== null && owner.root === here.root && owner.platform === here.platform) {
    throw new MeshError('INVALID_INPUT', 'This environment already owns .malt/worktrees.');
  }
  // Their Git links, ledger paths and memory links only resolve where they were created, so they are never adopted.
  const foreign = foreignWorktrees(mesh);
  if (foreign.length > 0) {
    throw new MeshError(
      'FACTORY_GATED',
      `${String(foreign.length)} worktrees were created by the other environment (first: ${foreign[0] ?? ''}) and cannot be used here. In that environment, finish, merge or cancel those deliveries so their worktrees are removed, then run factory-worktrees-adopt again. Ownership was not changed.`,
    );
  }
  const previous =
    owner === null
      ? []
      : [
          ...owner.handovers,
          { root: owner.root, platform: owner.platform, isContainer: owner.isContainer, until: now },
        ].slice(-HANDOVERS_KEPT);
  const adopted: WorktreeOwner = { ...here, recordedAt: now, handovers: previous };
  writeOwner(mesh, adopted);
  return adopted;
}
