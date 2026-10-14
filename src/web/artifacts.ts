/**
 * Bounded read-only job output access, confined to owned project artifacts.
 *
 * @file
 */
import { Buffer } from 'node:buffer';
import { open, realpath } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { rpc } from '../client.ts';
import { MeshError } from '../protocol.ts';

import type { MeshConfig } from '../config.ts';

/** Maximum live output chunk. */
const CHUNK_BYTES = 65_536;
/** Longest valid UTF-8 code point, in bytes. */
const UTF8_BYTES = 4;
/** Three-byte UTF-8 sequence width. */
const THREE_BYTES = 3;
/** Two-byte UTF-8 sequence width. */
const TWO_BYTES = 2;
/** Four-byte leading prefix threshold. */
const FOUR_BYTE_LEAD = 0xf0;
/** Three-byte leading prefix threshold. */
const THREE_BYTE_LEAD = 0xe0;
/** Exclusive upper bound of UTF-8 continuation bytes. */
const CONTINUATION_END = 0xc0;
/** UTF-8 continuation-byte prefix. */
const CONTINUATION_PREFIX = 0x80;
/** Validate only the known job metadata needed for artifact ownership. */
const artifactJobSchema = z.object({ id: z.string(), artifact: z.string() });
/** Validate the bounded job list returned by the broker. */
const jobListSchema = z.object({ jobs: z.array(artifactJobSchema) });
/** Fixed files which may be inspected; launch descriptors and credentials are excluded. */
export const artifactQuerySchema = z.object({
  job: z.string().uuid(),
  file: z
    .enum([
      'stdout.log',
      'stderr.log',
      'completion.json',
      'assignment.json',
      'prompt.md',
      'prepare-evidence.json',
      'test-evidence.json',
      'end-to-end-evidence.json',
    ])
    .default('stdout.log'),
  after: z.coerce.number().int().nonnegative().safe().default(0),
});

/**
 * Locate and read one bounded chunk without granting arbitrary filesystem access.
 *
 * @param config - Explicit selected project.
 * @param raw - Untrusted file selector.
 * @returns Text and the next byte cursor.
 * @throws {MeshError} For a foreign, missing or unsafe job path.
 */
export async function readArtifact(config: MeshConfig, raw: unknown): Promise<unknown> {
  const query = artifactQuerySchema.parse(raw);
  const state = jobListSchema.parse(await rpc(config, 'factory_status', {}));
  const job = state.jobs.find((candidate) => candidate.id === query.job);
  if (job === undefined) {
    throw new MeshError('NOT_FOUND', 'This project has no visible job with that ID.');
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Canonicalize the fixed project-local job root before applying containment.
  const root = await realpath(path.join(config.directory, 'factory', 'jobs'));
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- The job belongs to this project and the file selector is a fixed enum.
  const file = await realpath(path.join(job.artifact, query.file));
  const relative = path.relative(root, file);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new MeshError('WRONG_PROJECT', 'Artifact path is outside this project.');
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- The canonical file has passed project-root containment and a fixed filename allowlist.
  await using handle = await open(file, 'r');
  const stat = await handle.stat();
  const start = Math.min(query.after, stat.size);
  const buffer = Buffer.alloc(CHUNK_BYTES);
  const { bytesRead } = await handle.read(buffer, 0, CHUNK_BYTES, start);
  if (bytesRead > 0 && isContinuation(buffer[0] ?? 0)) {
    throw new MeshError('INVALID_INPUT', 'The artifact cursor must start at a complete UTF-8 character.');
  }
  const complete = completePrefix(buffer, bytesRead);
  return {
    text: buffer.subarray(0, complete).toString('utf8'),
    nextCursor: start + complete,
    size: stat.size,
    file: query.file,
  };
}

/**
 * Retain incomplete trailing characters for the next durable byte-cursor read.
 *
 * @param bytes - Native UTF-8 log buffer.
 * @param length - Actual bytes read, excluding buffer padding.
 * @returns Complete UTF-8 prefix length.
 */
function completePrefix(bytes: Buffer, length: number): number {
  let start = length - 1;
  while (start >= 0 && start >= length - UTF8_BYTES && isContinuation(bytes[start] ?? 0)) {
    start -= 1;
  }
  const lead = bytes[start] ?? 0;
  let required = 1;
  if (lead >= FOUR_BYTE_LEAD) {
    required = UTF8_BYTES;
  } else if (lead >= THREE_BYTE_LEAD) {
    required = THREE_BYTES;
  } else if (lead >= CONTINUATION_END) {
    required = TWO_BYTES;
  }
  return start + required > length ? start : length;
}

/**
 * Recognize a UTF-8 continuation byte without decoding a partial character.
 *
 * @param value - Unsigned native buffer byte.
 * @returns Whether it continues a preceding UTF-8 sequence.
 */
function isContinuation(value: number): boolean {
  return value >= CONTINUATION_PREFIX && value < CONTINUATION_END;
}
