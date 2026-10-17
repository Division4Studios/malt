/**
 * The exact MALT source a running process was started from, so an operator
 * can see whether a running broker matches main after a merge. A container
 * image records its build commit in `MALT_SOURCE_REVISION`; a checkout reads
 * `HEAD` and whether tracked files differ from it. Either is read once, at
 * startup, and never changes while the process runs: merging new source does
 * not upgrade a running broker.
 *
 * @file
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

/** A full Git commit id. */
const COMMIT = /^[\da-f]{40}$/v;
/** Longest wait for a local Git read at startup. */
const GIT_TIMEOUT_MS = 5000;
/** The MALT source tree this module belongs to. */
const SOURCE_ROOT = path.resolve(import.meta.dirname, '..');

/** Where a running process's source came from. */
export interface SourceRevision {
  /** Full commit id, or null when it cannot be determined. */
  readonly commit: string | null;
  /** Whether tracked files differed from that commit at startup; null when unknown or built into an image. */
  readonly isDirty: boolean | null;
  /** How the commit was found. */
  readonly origin: 'image' | 'checkout' | 'unknown';
}

/** Reads a revision needs; injectable for tests. */
export interface RevisionProbes {
  /** Build-time revision recorded in the image, if any. */
  readonly environment: string | undefined;
  /** Run Git in the source tree; returns stdout, or null when Git failed. */
  readonly git: (args: readonly string[]) => string | null;
}

/**
 * Run Git in the MALT source tree without a shell.
 *
 * @param args - Git arguments.
 * @returns Standard output, or null when Git is missing or failed.
 */
function sourceGit(args: readonly string[]): string | null {
  // eslint-disable-next-line sonarjs/no-os-command-from-path, n/no-sync -- One bounded, shell-free startup read of the installed Git.
  const result = spawnSync('git', ['-C', SOURCE_ROOT, ...args], {
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
  });
  return result.status === 0 && result.error === undefined ? result.stdout : null;
}

/**
 * Determine the running source revision.
 *
 * @param probes - Image environment and Git access; defaults to this process's environment and Git.
 * @returns The recorded image commit, else the checkout's `HEAD` with its dirty state, else unknown.
 */
export function readSourceRevision(probes?: RevisionProbes): SourceRevision {
  const { environment, git } = probes ?? { environment: process.env['MALT_SOURCE_REVISION'], git: sourceGit };
  const recorded = environment?.trim().toLowerCase() ?? '';
  if (COMMIT.test(recorded)) {
    return { commit: recorded, isDirty: null, origin: 'image' };
  }
  const head = git(['rev-parse', '--verify', 'HEAD'])?.trim() ?? '';
  if (!COMMIT.test(head)) {
    return { commit: null, isDirty: null, origin: 'unknown' };
  }
  const status = git(['status', '--porcelain', '--untracked-files=no']);
  return { commit: head, isDirty: status === null ? null : status.trim() !== '', origin: 'checkout' };
}

/** This process's source revision, read once at startup. */
export const SOURCE_REVISION: SourceRevision = readSourceRevision();
