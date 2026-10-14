/**
 * Job-fenced immutable Git source inspection, without arbitrary shell or files.
 *
 * @file
 */
import { z } from 'zod';

import { run, selectOne } from '../database.ts';
import { MeshError } from '../protocol.ts';
import { SecretRedactor } from '../secrets.ts';

import { command } from './commands.ts';
import { factorySchemas } from './schema.ts';

import type { FactoryContext } from './context.ts';
import type { FactoryRepository } from './repository.ts';
import type { FactoryJob } from './schema.ts';
import type { SourceSnapshot } from './workspaces.ts';

/** Source inspection pages remain bounded independently of full Git history. */
const PAGE = 100;
/** Avoid loading an entire large artifact into a model context. */
const FILE_BYTES = 32_000;
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
 * Read only a live authenticated managed role's exact committed source.
 *
 * @param context - Project Git and durable claims.
 * @param input - Relative file or listing cursor.
 * @param actorId - Session-authenticated peer, never browser authority.
 * @returns Bounded immutable source with explicit head and truncation.
 * @throws {MeshError} For missing claims, private paths or unavailable snapshots.
 */
export async function readSource(context: FactoryContext, input: unknown, actorId: string | null): Promise<unknown> {
  if (actorId === null) {
    throw new MeshError('FACTORY_GATED', 'Immutable inspection requires a live managed assignment.');
  }
  const request = factorySchemas.factory_read_source.parse(input);
  const actor = context.repository.store.execute('whoami', {}, actorId);
  const job = context.repository
    .jobs()
    .find((candidate) => candidate.state === 'running' && `factory-${candidate.role}` === actor.name);
  if (job === undefined || actor.runtime !== 'factory-managed' || job.expiresAt <= context.repository.store.now()) {
    throw new MeshError('FACTORY_GATED', 'No current managed source claim is owned by this session.');
  }
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
  const object = `${source.head}:${file}`;
  const bytes = Number(await context.workspaces.git(['cat-file', '-s', object]));
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > FILE_BYTES) {
    return {
      jobId: job.id,
      head: source.head,
      path: file,
      truncated: true,
      reason: 'File exceeds the source inspection limit.',
    };
  }
  const content = await command('git', ['cat-file', 'blob', object], context.mesh.root, false);
  const redactor = new SecretRedactor([context.mesh.token]);
  return {
    jobId: job.id,
    head: source.head,
    path: file,
    truncated: false,
    content: redactor.redact(content),
  };
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
