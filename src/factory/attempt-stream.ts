/**
 * Bounded, confined reads of one attempt's private artifacts. Only the fixed
 * provider stream and prompt files under this project's job directory are
 * opened; reads stop at an explicit byte cap and report truncation.
 *
 * @file
 */
import { Buffer } from 'node:buffer';
import { createReadStream } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { hasErrorCode } from '../errors.ts';

import type { MeshConfig } from '../config.ts';

/** Most provider stream bytes read for one attempt. */
export const STREAM_BYTES_MAX = 33_554_432;
/** Most prompt bytes read for a transcript's input preview. */
const PROMPT_BYTES_MAX = 16_384;
/** Fixed artifact files this module may read. */
type AttemptFile = 'stdout.log' | 'prompt.md';

/** Identity of a stream file version, used as a cache key. */
export interface StreamVersion {
  /** Canonical confined file path. */
  readonly file: string;
  /** Current size in bytes. */
  readonly size: number;
  /** Last modification time in milliseconds. */
  readonly mtimeMs: number;
}

/** Outcome of a bounded line read. */
export interface StreamRead {
  /** Whether the stream file existed and was readable. */
  readonly available: boolean;
  /** Bytes consumed from the file. */
  readonly bytes: number;
  /** Whether the byte cap stopped the read before the end of the file. */
  readonly truncated: boolean;
}

/**
 * Canonicalize a path that may not exist yet.
 *
 * @param target - Project-local path built from fixed segments.
 * @returns Canonical path, or null when it does not exist.
 * @throws {Error} For filesystem failures other than a missing path.
 */
async function canonical(target: string): Promise<string | null> {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Callers pass only the fixed job root or a fixed artifact file name.
    return await realpath(target);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return null;
    }
    throw error;
  }
}

/**
 * Resolve one fixed artifact file, refusing anything outside the project's job root.
 *
 * @param mesh - Selected project whose private directory owns the job.
 * @param artifact - Job artifact directory recorded by the supervisor.
 * @param file - Fixed artifact filename.
 * @returns Canonical file path, or null when the file does not exist.
 * @throws {Error} When the canonical path escapes this project's job directory.
 */
async function confined(mesh: MeshConfig, artifact: string, file: AttemptFile): Promise<string | null> {
  const root = await canonical(path.join(mesh.directory, 'factory', 'jobs'));
  const target = root === null ? null : await canonical(path.join(artifact, file));
  if (root === null || target === null) {
    return null;
  }
  const relative = path.relative(root, target);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Attempt artifact is outside this project.');
  }
  return target;
}

/**
 * Identify the current version of an attempt's provider stream without reading it.
 *
 * @param mesh - Selected project.
 * @param artifact - Job artifact directory.
 * @returns Size and modification time, or null when no stream exists yet.
 */
export async function streamVersion(mesh: MeshConfig, artifact: string): Promise<StreamVersion | null> {
  const file = await confined(mesh, artifact, 'stdout.log');
  if (file === null) {
    return null;
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- The canonical file passed project-root containment above.
  const details = await stat(file);
  return { file, size: details.size, mtimeMs: details.mtimeMs };
}

/**
 * Stream an attempt's provider events line by line up to the byte cap.
 *
 * @param version - Confined stream identity from {@link streamVersion}.
 * @param consume - Receives each complete line in order.
 * @returns Bytes consumed and whether the cap truncated the read.
 */
export async function readStreamLines(
  version: StreamVersion | null,
  consume: (line: string) => void,
): Promise<StreamRead> {
  if (version === null) {
    return { available: false, bytes: 0, truncated: false };
  }
  const limit = Math.min(version.size, STREAM_BYTES_MAX);
  if (limit === 0) {
    return { available: true, bytes: 0, truncated: false };
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- The canonical file passed project-root containment.
  const input = createReadStream(version.file, { start: 0, end: limit - 1, encoding: 'utf8' });
  let pending = '';
  for await (const chunk of input) {
    pending += String(chunk);
    let end = pending.indexOf('\n');
    while (end !== -1) {
      consume(pending.slice(0, end).replace(/\r$/v, ''));
      pending = pending.slice(end + 1);
      end = pending.indexOf('\n');
    }
  }
  // A cap or a live writer can cut the last event; pass it on only when it is a whole record.
  if (isWholeRecord(pending)) {
    consume(pending);
  }
  return { available: true, bytes: limit, truncated: version.size > STREAM_BYTES_MAX };
}

/**
 * Whether a final unterminated line is a complete JSON record rather than a cut-off fragment.
 *
 * @param line - Text after the last newline.
 * @returns True for a parseable, non-blank record.
 */
function isWholeRecord(line: string): boolean {
  if (line.trim() === '') {
    return false;
  }
  try {
    JSON.parse(line);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the first bounded part of the assignment prompt.
 *
 * @param mesh - Selected project.
 * @param artifact - Job artifact directory.
 * @returns Prompt prefix and whether more prompt text exists, or null when absent.
 */
export async function readPromptPrefix(
  mesh: MeshConfig,
  artifact: string,
): Promise<{ text: string; truncated: boolean } | null> {
  const file = await confined(mesh, artifact, 'prompt.md');
  if (file === null) {
    return null;
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- The canonical file passed project-root containment.
  await using handle = await open(file, 'r');
  const details = await handle.stat();
  const buffer = Buffer.alloc(Math.min(details.size, PROMPT_BYTES_MAX));
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
  const decoder = new TextDecoder();
  return {
    // Streaming decode withholds a multi-byte character cut by the byte bound.
    text: decoder.decode(buffer.subarray(0, bytesRead), { stream: true }),
    truncated: details.size > bytesRead,
  };
}
