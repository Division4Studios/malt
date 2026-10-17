/**
 * Job-fenced immutable Git source inspection, without arbitrary shell or files.
 *
 * @file
 */
import { Buffer } from 'node:buffer';

import { z } from 'zod/v3';

import { run, selectOne } from '../database.ts';
import { MeshError } from '../protocol.ts';
import { SecretRedactor } from '../secrets.ts';

import { command } from './commands.ts';
import { factorySchemas } from './schema.ts';

import type { FactoryContext } from './context.ts';
import type { Store } from '../store.ts';
import type { FactoryRepository } from './repository.ts';
import type { FactoryJob } from './schema.ts';
import type { SourceSnapshot } from './workspaces.ts';

/** Source inspection pages remain bounded independently of full Git history. */
const PAGE = 100;
/** Avoid loading an entire large artifact into a model context. */
const FILE_BYTES = 32_000;
/** Bound native blob memory while permitting ordinary large source modules. */
const SOURCE_BYTES = 1_048_576;
/** UTF-8 continuation bytes cannot begin a page. */
const CONTINUATION_MIN = 0x80;
/** Exclusive continuation-byte upper bound. */
const CONTINUATION_MAX = 0xc0;
/** Private operational state and common credential files are never source tools. */
const PRIVATE_SEGMENTS = new Set(['.git', '.malt', '.mlt', '.agentmesh', '.npmrc']);
/** Sealed native source identity, never model-provided data. */
const headSchema = z.object({ head: z.string().regex(/^(?:[\da-f]{40}|[\da-f]{64})$/v) });

/**
 * Seal the inspected source before a readonly model assignment starts.
 *
 * @param repository - Authoritative project ledger.
 * @param job - Current bounded claim.
 * @param snapshot - Native Git snapshot already prepared and validated.
 */
export function sealSource(repository: FactoryRepository, job: FactoryJob, snapshot: SourceSnapshot): void {
  repository.store.transaction(() => {
    run(
      repository.store.db,
      'INSERT OR REPLACE INTO factory_source_views(job_id,head) VALUES(?,?)',
      job.id,
      snapshot.head,
    );
  });
}

/**
 * The exact source commit one attempt was sealed to.
 *
 * @param store - Selected project's SQLite owner.
 * @param jobId - Attempt identity.
 * @returns Sealed commit, or `null` when the attempt read no sealed source.
 */
export function sealedHead(store: Store, jobId: string): string | null {
  return selectOne(store.db, headSchema, 'SELECT head FROM factory_source_views WHERE job_id=?', jobId)?.head ?? null;
}

/**
 * Read only a live authenticated managed role's exact committed source.
 *
 * @param context - Project Git and durable claims.
 * @param input - Relative file or listing cursor.
 * @param actorId - Session-authenticated peer, never browser authority.
 * @returns Bounded immutable source with explicit head and truncation.
 * @throws {MeshError} For missing claims, private paths or unavailable snapshots.
 */
export async function readSource(context: FactoryContext, input: unknown, actorId: string | null): Promise<unknown> {
  const job = managedSourceJob(context, actorId);
  const request = factorySchemas.factory_read_source.parse(input);
  const source = selectOne(
    context.repository.store.db,
    headSchema,
    'SELECT head FROM factory_source_views WHERE job_id=?',
    job.id,
  );
  if (source === undefined) {
    throw new MeshError('FACTORY_GATED', 'This assignment has no sealed read-only source view.');
  }
  if (request.revision === 'base') {
    if (job.base === null) {
      throw new MeshError('FACTORY_GATED', 'This assignment has no supplied base commit.');
    }
    source.head = headSchema.parse({ head: job.base }).head;
  }
  return readPinnedSource(context, request, job, source.head);
}

/**
 * Authenticate the current managed role against its live durable claim.
 *
 * @param context - Authoritative project ledger.
 * @param actorId - Broker-authenticated session identity.
 * @returns Current owned job, never a model-selected job.
 * @throws {MeshError} For absent, expired or unmanaged claims.
 */
export function managedSourceJob(context: FactoryContext, actorId: string | null): FactoryJob {
  if (actorId === null) {
    throw new MeshError('FACTORY_GATED', 'Immutable inspection requires a live managed assignment.');
  }
  const actor = context.repository.store.execute('whoami', {}, actorId);
  const job = context.repository
    .jobs()
    .find((candidate) => candidate.state === 'running' && `factory-${candidate.role}` === actor.name);
  if (job === undefined || actor.runtime !== 'factory-managed' || job.expiresAt <= context.repository.store.now()) {
    throw new MeshError('FACTORY_GATED', 'No current managed source claim is owned by this session.');
  }
  return job;
}

/**
 * Read only a validated immutable source identity after claim authentication.
 *
 * @param context - Native Git boundary.
 * @param request - Validated relative file or listing cursor.
 * @param job - Authenticated live job.
 * @param head - Sealed Git commit.
 * @returns Bounded immutable source.
 */
async function readPinnedSource(
  context: FactoryContext,
  request: z.output<typeof factorySchemas.factory_read_source>,
  job: FactoryJob,
  head: string,
): Promise<unknown> {
  const source = { head };
  if (request.path === undefined) {
    const listing = await context.workspaces.git([
      '-c',
      'core.quotepath=false',
      'ls-tree',
      '-r',
      '--name-only',
      '-z',
      source.head,
    ]);
    const files = listing.split('\0').filter((candidate) => candidate !== '' && !hasPrivatePath(candidate));
    return {
      jobId: job.id,
      head: source.head,
      files: files.slice(request.cursor, request.cursor + PAGE),
      total: files.length,
      nextCursor: request.cursor + PAGE < files.length ? request.cursor + PAGE : null,
      changes: request.revision === 'head' ? await sourceChanges(context, job.base, source.head, request.cursor) : null,
    };
  }
  const file = request.path.replaceAll('\\', '/');
  if (isUnsafeSourcePath(file)) {
    throw new MeshError('INVALID_INPUT', 'Only nonprivate relative tracked source paths are available.');
  }
  return readBlob(context, { head: source.head, path: file, cursor: request.cursor, jobId: job.id });
}

/**
 * Page a verified immutable blob with bounded memory and complete UTF-8 characters.
 *
 * @param context - Project-owned native Git and redaction boundary.
 * @param request - Already authorized immutable file identity and cursor.
 * @returns Exact source page or an explicit size-limit result.
 * @throws {MeshError} When a cursor splits a character or exceeds the source.
 */
async function readBlob(
  context: FactoryContext,
  request: { head: string; path: string; cursor: number; jobId: string },
): Promise<unknown> {
  const object = `${request.head}:${request.path}`;
  const bytes = Number(await context.workspaces.git(['cat-file', '-s', object]));
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > SOURCE_BYTES) {
    return {
      jobId: request.jobId,
      head: request.head,
      path: request.path,
      truncated: true,
      reason: 'File exceeds the source inspection limit.',
    };
  }
  const content = await command('git', ['cat-file', 'blob', object], context.mesh.root, false);
  const redactor = new SecretRedactor([context.mesh.token]);
  const safe = Buffer.from(redactor.redact(content));
  if (request.cursor > safe.length || isContinuation(safe[request.cursor])) {
    throw new MeshError('INVALID_INPUT', 'Source cursor must identify a complete UTF-8 character within the file.');
  }
  let end = Math.min(request.cursor + FILE_BYTES, safe.length);
  while (isContinuation(safe[end])) {
    end -= 1;
  }
  return {
    jobId: request.jobId,
    head: request.head,
    path: request.path,
    truncated: end < safe.length,
    content: safe.subarray(request.cursor, end).toString('utf8'),
    ...((safe.length > FILE_BYTES || request.cursor > 0) && {
      cursor: request.cursor,
      nextCursor: end < safe.length ? end : null,
      totalBytes: safe.length,
      guidance: 'Read the next page using nextCursor as cursor with the same path and revision.',
    }),
  };
}

/**
 * Identify a UTF-8 continuation byte without splitting source code points.
 *
 * @param byte - Byte at a requested page boundary, absent at EOF.
 * @returns Whether the byte continues an earlier character.
 */
function isContinuation(byte: number | undefined): boolean {
  return byte !== undefined && byte >= CONTINUATION_MIN && byte < CONTINUATION_MAX;
}

/**
 * Provide exact-base changed paths without a reviewer shell or arbitrary refs.
 *
 * @param context - Verified project Git boundary.
 * @param base - Supervisor-supplied immutable base, if available.
 * @param head - Sealed assignment source.
 * @param cursor - Bounded path-page offset.
 * @returns Changed public paths and a count of excluded private changes.
 */
async function sourceChanges(
  context: FactoryContext,
  base: string | null,
  head: string,
  cursor: number,
): Promise<unknown> {
  if (base === null) {
    return null;
  }
  const verifiedBase = headSchema.parse({ head: base }).head;
  const listing = await context.workspaces.git(['diff', '--name-only', '--no-renames', '-z', verifiedBase, head, '--']);
  const changed = listing.split('\0').filter((file) => file !== '');
  const files = changed.filter((file) => !hasPrivatePath(file));
  return {
    base: verifiedBase,
    head,
    files: files.slice(cursor, cursor + PAGE),
    total: files.length,
    privateChanges: changed.length - files.length,
    nextCursor: cursor + PAGE < files.length ? cursor + PAGE : null,
  };
}

/**
 * Reject nonrelative or private Git paths before constructing an object name.
 *
 * @param file - Normalized requested path.
 * @returns Whether the path crosses the source inspection boundary.
 */
function isUnsafeSourcePath(file: string): boolean {
  return (
    file.startsWith('/') ||
    file.includes(':') ||
    file.split('/').some((part) => part === '..' || part === '.') ||
    hasPrivatePath(file)
  );
}

/**
 * Exclude private runtime and common credential segments without an unsafe regex.
 *
 * @param value - Git-relative path.
 * @returns Whether any path segment is private.
 */
function hasPrivatePath(value: string): boolean {
  return value.split('/').some((part) => {
    return (
      PRIVATE_SEGMENTS.has(part.toLowerCase()) ||
      part.toLowerCase() === '.env' ||
      part.toLowerCase().startsWith('.env.')
    );
  });
}
