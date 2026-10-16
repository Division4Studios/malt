/** @file Bounded native intake observations; no detector, scheduler or remote mutation. */
import { z } from 'zod/v3';

import { run, selectOne } from '../database.ts';
import { observedIssueSchema } from '../github-issues.ts';
import { MeshError } from '../protocol.ts';

import type { FactoryContext } from './context.ts';
import type { DeliveryRemote } from './remote.ts';
import type { FactoryRepository } from './repository.ts';
/** Maximum cached complete observation age. */
const CACHE_MS = 300_000;
/** Maximum retained observations. */
const ISSUE_MAX = 1000;
/** One native page per unpaid call. */
const PAGE_MAX = 100;
/** Private metadata wrapper. */
const rowSchema = z.object({ value: z.string() });
/** Native corpus progress is separate from human recommendation state. */
export const intakeCorpusSchema = z.object({
  items: z.array(observedIssueSchema).max(ISSUE_MAX),
  cursor: z.record(z.unknown()).nullable(),
  complete: z.boolean(),
  checkedAt: z.number(),
  repositoryId: z.string().nullable(),
});

/**
 * Read existing project-private intake metadata.
 *
 * @param repository - Authoritative selected project.
 * @param key - Fixed intake namespace.
 * @returns Parsed data or null, with validation at its consumer.
 */
export function readIntakeMetadata(repository: FactoryRepository, key: string): unknown {
  const row = selectOne(repository.store.db, rowSchema, 'SELECT value FROM metadata WHERE key=?', key);
  return row === undefined ? null : JSON.parse(row.value);
}

/**
 * Commit one derived intake checkpoint without rewriting unchanged content.
 *
 * @param repository - Transaction owner.
 * @param key - Project-owned intake key.
 * @param value - Validated finite checkpoint.
 */
export function saveIntakeMetadata(repository: FactoryRepository, key: string, value: unknown): void {
  const serialized = JSON.stringify(value);
  if (selectOne(repository.store.db, rowSchema, 'SELECT value FROM metadata WHERE key=?', key)?.value === serialized) {
    return;
  }
  repository.store.transaction(() => {
    run(
      repository.store.db,
      'INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      key,
      serialized,
    );
  });
}

/**
 * Advance at most one native page, retaining honest incomplete coverage across restart.
 *
 * @param context - Verified selected repository and unpaid broker context.
 * @returns Complete bounded corpus, or null while collection is incomplete.
 */
export async function intakeCorpus(
  context: Pick<FactoryContext, 'repository' | 'remote'>,
): Promise<z.output<typeof intakeCorpusSchema> | null> {
  const { repository } = context;
  const now = repository.store.now();
  const expectedRepository = currentRepository(context.remote);
  const prior = intakeCorpusSchema.nullable().parse(readIntakeMetadata(repository, 'pm_intake_corpus'));
  const current = startingCheckpoint(prior, now, expectedRepository);
  if (current.complete) {
    return current;
  }
  if (context.remote.issueCorpus === undefined || current.items.length >= ISSUE_MAX) {
    throw new MeshError(
      'FACTORY_GATED',
      'Intake requires complete bounded issue coverage; verify the selected repository connection.',
    );
  }
  const page = await context.remote.issueCorpus({
    limit: Math.min(PAGE_MAX, ISSUE_MAX - current.items.length),
    cursor: current.cursor,
  });
  if ((currentRepository(context.remote) ?? page.repositoryId) !== page.repositoryId) {
    throw new MeshError('FACTORY_GATED', 'The verified repository changed while its issue page was being inspected.');
  }
  if (current.repositoryId !== null && current.repositoryId !== page.repositoryId) {
    throw new MeshError(
      'FACTORY_GATED',
      'The issue corpus repository changed during intake. Reconnect the intended project.',
    );
  }
  const items = new Map(current.items.map((item) => [item.number, item]));
  for (const item of page.items) {
    items.set(item.number, observedIssueSchema.parse(item));
  }
  const next = intakeCorpusSchema.parse({
    items: items.values().toArray(),
    cursor: page.nextCursor,
    complete: page.complete && items.values().every((item) => item.complete),
    checkedAt: current.checkedAt,
    repositoryId: page.repositoryId,
  });
  saveIntakeMetadata(repository, 'pm_intake_corpus', next);
  if (!next.complete && next.cursor === null) {
    throw new MeshError(
      'FACTORY_GATED',
      'Native issue relationships are incomplete; inspect the affected source before planning.',
    );
  }
  return next.complete ? next : null;
}

/** Complete internal observations, not automatically loaded model context. */
export type IntakeCorpus = z.output<typeof intakeCorpusSchema>;

/**
 * Reuse only bounded-age progress for the still-selected verified repository.
 *
 * @param prior - Existing selected-project checkpoint.
 * @param now - Broker clock.
 * @param expected - Current verified source; null only for an injected fixture boundary.
 * @returns Reusable progress or a new empty scoped observation campaign.
 */
function startingCheckpoint(prior: IntakeCorpus | null, now: number, expected: string | null): IntakeCorpus {
  return prior !== null && prior.checkedAt + CACHE_MS > now && (expected === null || prior.repositoryId === expected)
    ? prior
    : { items: [], cursor: null, complete: false, checkedAt: now, repositoryId: expected };
}

/**
 * Read verified source identity without a native command.
 *
 * @param remote - Selected adapter; synthetic boundaries may omit this capability.
 * @returns Verified node identity or explicit unknown for an injected fixture.
 */
function currentRepository(remote: DeliveryRemote): string | null {
  return remote.issueRepositoryId?.() ?? null;
}
