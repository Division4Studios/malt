/**
 * Hash-fenced bundled skill upgrades. Unknown local edits never become owned
 * merely because they were found on disk; approved library overrides win later.
 *
 * @file
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { hasErrorCode } from '../errors.ts';
import { writeAtomic } from '../summary.ts';

import type { MeshConfig } from '../config.ts';

/** Bundle names are fixed and never derived from a remote candidate. */
export const BASELINE_NAMES = [
  'factory-session',
  'factory-product',
  'factory-development',
  'factory-review',
  'factory-release',
  'factory-learning',
] as const;
/** Durable ownership receipts, compatible with the original unversioned index. */
const indexSchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]),
  hashes: z.record(z.string().regex(/^[\da-f]{64}$/v)).default({}),
  conflicts: z.array(z.enum(BASELINE_NAMES)).max(BASELINE_NAMES.length).default([]),
});

/**
 * Report unresolved local edits without loading complete skill instructions.
 *
 * @param mesh - Selected project.
 * @returns Explicit baseline ownership conflicts.
 */
export function baselineConflicts(mesh: MeshConfig): string[] {
  const index = readOptional(path.join(mesh.directory, 'skills', 'builtin-index.json'));
  return index === null ? [] : indexSchema.parse(JSON.parse(index)).conflicts;
}

/**
 * Read a fixed baseline file or report its absence.
 *
 * @param file - Fixed project/bundle file.
 * @returns Stored text, absent when never installed.
 * @throws {Error} For filesystem failures other than absence.
 */
function readOptional(file: string): string | null {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Callers supply only allowlisted baseline/index paths.
    return readFileSync(file, 'utf8');
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT')) {
      throw error;
    }
    return null;
  }
}

/**
 * Compute the instruction revision retained in assignment evidence.
 *
 * @param content - Exact skill instructions.
 * @returns Content hash.
 */
function revision(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Upgrade only unchanged managed baselines and retain every replaced revision.
 * Legacy differing files are preserved as conflicts, not silently overwritten.
 *
 * @param mesh - Selected project.
 * @param bundle - Reviewed distribution baseline.
 * @returns Ownership receipts and explicit conflicts for the generated index.
 * @throws {Error} For incomplete bundles, invalid receipts or filesystem failures.
 */
export function refreshBaselines(
  mesh: MeshConfig,
  bundle: string,
): { hashes: Record<string, string>; conflicts: string[] } {
  const prior = readOptional(path.join(mesh.directory, 'skills', 'builtin-index.json'));
  const hashes = prior === null ? {} : indexSchema.parse(JSON.parse(prior)).hashes;
  const conflicts: string[] = [];
  for (const name of BASELINE_NAMES) {
    const file = path.join(mesh.directory, 'skills', 'builtin', name, 'SKILL.md');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Prepare only an allowlisted project-local baseline directory.
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const current = readOptional(file);
    const packaged = readOptional(path.join(bundle, name, 'SKILL.md'));
    if (packaged === null) {
      throw new Error(`Missing bundled lifecycle skill: ${name}`);
    }
    const nextHash = revision(packaged);
    const currentHash = current === null ? null : revision(current);
    if (currentHash === nextHash) {
      hashes[name] = nextHash;
      continue;
    }
    const ownedHash = Object.entries(hashes).find(([key]) => key === name)?.[1];
    if (current !== null && revision(current) !== ownedHash) {
      conflicts.push(name);
      continue;
    }
    if (current !== null) {
      const archive = path.join(mesh.directory, 'skills', 'builtin-history', revision(current), name, 'SKILL.md');
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Archive only the exact managed revision under this project's private history.
      mkdirSync(path.dirname(archive), { recursive: true, mode: 0o700 });
      writeAtomic(archive, current);
    }
    writeAtomic(file, packaged);
    hashes[name] = nextHash;
  }
  return { hashes, conflicts };
}
