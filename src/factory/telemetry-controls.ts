/**
 * Broker-side handlers for attempt telemetry operations. The supervisor
 * delegates `factory_attempts`, `factory_transcript`, `factory_costs` and
 * `factory_prices` here; only `factory_prices` writes, and it is fenced by
 * the price table revision.
 *
 * @file
 */
import { attemptMetrics } from './attempt-metrics.ts';
import { attemptById, listAttempts } from './attempts.ts';
import { costSummary } from './costs.ts';
import { readPrices, savePrices } from './price-table.ts';
import { transcriptInputSchema } from './telemetry-schema.ts';
import { attemptTranscript } from './transcripts.ts';

import type { MeshConfig } from '../config.ts';
import type { FactoryRepository } from './repository.ts';
import type { AttemptPage, CostSummary, PriceTable, TranscriptPage } from './telemetry-schema.ts';

/**
 * Handle `factory_attempts`: list attempts with filters and a stable cursor.
 *
 * @param repository - Selected project ledger.
 * @param mesh - Selected project paths.
 * @param input - Untrusted filters.
 * @returns One page of attempt rows.
 */
export async function attempts(repository: FactoryRepository, mesh: MeshConfig, input: unknown): Promise<AttemptPage> {
  return listAttempts(repository, mesh, input);
}

/**
 * Handle `factory_transcript`: one page of an attempt's normalized transcript.
 *
 * @param repository - Selected project ledger.
 * @param mesh - Selected project paths.
 * @param input - Untrusted job id, node cursor and page size.
 * @returns Nodes from the cursor, attempt-wide touched files and metrics.
 * @throws {MeshError} When the project has no such attempt.
 */
export async function transcript(
  repository: FactoryRepository,
  mesh: MeshConfig,
  input: unknown,
): Promise<TranscriptPage> {
  const query = transcriptInputSchema.parse(input);
  const job = attemptById(repository, query.jobId);
  const { parse, read } = await attemptTranscript(mesh, job);
  const now = repository.store.now();
  const end = Math.min(parse.nodes.length, query.cursor + query.limit);
  return {
    jobId: job.id,
    provider: job.provider,
    live: job.state === 'running',
    nodes: parse.nodes.slice(query.cursor, end),
    totalNodes: parse.nodes.length,
    nextCursor: end < parse.nodes.length ? end : null,
    nodesTruncated: parse.nodesTruncated,
    filesTouched: parse.files,
    filesTruncated: parse.filesTruncated,
    metrics: attemptMetrics(job, { digest: parse.digest, read }, readPrices(repository.store), now),
  };
}

/**
 * Handle `factory_costs`: local cost summary for a calendar-day window.
 *
 * @param repository - Selected project ledger.
 * @param mesh - Selected project paths.
 * @param input - Untrusted window and time zone.
 * @returns Cost summary including the current price table.
 */
export async function costs(repository: FactoryRepository, mesh: MeshConfig, input: unknown): Promise<CostSummary> {
  return costSummary(repository, mesh, input);
}

/**
 * Handle `factory_prices`: replace the operator price table at an expected revision.
 *
 * @param repository - Selected project ledger.
 * @param input - Untrusted complete price list and expected revision.
 * @returns Saved price table.
 * @throws {MeshError} When the table changed since the caller read it.
 */
export function prices(repository: FactoryRepository, input: unknown): PriceTable {
  return savePrices(repository.store, input);
}
