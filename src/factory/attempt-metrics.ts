/**
 * Per-attempt metrics computed from the provider stream and the job record:
 * token split, provider-reported or locally estimated cost, turns, tool
 * calls, durations and touched files. Stream digests are cached per job and
 * stream version, so listing and cost views re-read only changed streams.
 *
 * @file
 */
import { streamVersion } from './attempt-stream.ts';
import { estimateCost } from './price-table.ts';
import { parseAttempt } from './transcripts.ts';

import type { MeshConfig } from '../config.ts';
import type { StreamRead } from './attempt-stream.ts';
import type { FactoryJob } from './schema.ts';
import type { AttemptMetrics, PriceTable, TokenSplit } from './telemetry-schema.ts';
import type { StreamDigest } from './transcript-builder.ts';

/** Stream digests retained in memory. */
const DIGEST_CACHE_MAX = 2048;

/** A digest with its read accounting. */
export interface DigestRead {
  /** Stream-derived metrics. */
  readonly digest: StreamDigest;
  /** Byte accounting and availability. */
  readonly read: StreamRead;
}

/** Cached digest keyed by stream version and job state. */
interface CachedDigest {
  /** Cache validity key. */
  readonly key: string;
  /** Cached result. */
  readonly value: DigestRead;
}

/** Bounded insertion-ordered digest cache keyed by project and job id. */
const digests = new Map<string, CachedDigest>();

/**
 * Read one attempt's stream digest, reusing the cache while its stream is unchanged.
 *
 * @param mesh - Selected project.
 * @param job - Attempt whose stream to summarize.
 * @returns Stream metrics and read accounting.
 */
export async function attemptDigest(mesh: MeshConfig, job: FactoryJob): Promise<DigestRead> {
  const version = await streamVersion(mesh, job.artifact);
  // Projects cloned from one another can share job ids, so the cache is scoped by stream file.
  const id = `${mesh.directory}:${job.id}`;
  const key = `${job.state}:${version?.file ?? ''}:${String(version?.size ?? -1)}:${String(version?.mtimeMs ?? -1)}`;
  const cached = digests.get(id);
  if (cached?.key === key) {
    return cached.value;
  }
  const { parse, read } = await parseAttempt(mesh, job, { isCollecting: false, version });
  const value = { digest: parse.digest, read };
  digests.delete(id);
  digests.set(id, { key, value });
  for (const stale of digests.keys()) {
    if (digests.size <= DIGEST_CACHE_MAX) {
      break;
    }
    digests.delete(stale);
  }
  return value;
}

/**
 * Express stream token counts as a split, falling back to the job's total.
 *
 * @param digest - Stream metrics.
 * @param job - Attempt record with the supervisor's settled usage.
 * @returns Token split with explicit unknown components.
 */
function tokenSplit(digest: StreamDigest, job: FactoryJob): TokenSplit {
  const { tokens } = digest;
  if (tokens === null) {
    return { input: null, cacheRead: null, cacheWrite: null, output: null, reasoning: null, total: job.usageTokens };
  }
  return {
    ...tokens,
    total: tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output,
  };
}

/**
 * Combine stream metrics, the job record and the price table into attempt metrics.
 *
 * @param job - Attempt record.
 * @param source - Stream digest and read accounting.
 * @param prices - Operator price table.
 * @param now - Current time, used for the elapsed time of running attempts.
 * @returns Validated-shape metrics; cost is reported, estimated or explicitly unpriced.
 */
export function attemptMetrics(job: FactoryJob, source: DigestRead, prices: PriceTable, now: number): AttemptMetrics {
  const { digest, read } = source;
  const tokens = tokenSplit(digest, job);
  const model = digest.model ?? job.routing?.model ?? null;
  const estimate = estimateCost(
    tokens,
    prices.prices.find((price) => price.model === model),
  );
  let cost: AttemptMetrics['cost'] = { usd: null, source: 'unpriced' };
  if (digest.reportedCostUsd !== null) {
    cost = { usd: digest.reportedCostUsd, source: 'reported' };
  } else if (estimate !== null) {
    cost = { usd: estimate, source: 'estimated' };
  }
  return {
    tokens,
    cost,
    model,
    turns: digest.turns,
    tools: digest.tools,
    durationMs: Math.max(0, (job.finishedAt ?? now) - job.startedAt),
    apiDurationMs: digest.apiDurationMs,
    filesTouched: digest.filesTouched,
    outcome: job.state,
    providerError: digest.providerError,
    stream: {
      available: read.available,
      bytes: read.bytes,
      truncated: read.truncated,
      malformedLines: digest.malformedLines,
      unknownEvents: digest.unknownEvents,
    },
  };
}

/**
 * Compute metrics for one attempt, reading its stream through the digest cache.
 *
 * @param mesh - Selected project.
 * @param job - Attempt record.
 * @param prices - Operator price table.
 * @param now - Current time.
 * @returns Attempt metrics.
 */
export async function metricsFor(
  mesh: MeshConfig,
  job: FactoryJob,
  prices: PriceTable,
  now: number,
): Promise<AttemptMetrics> {
  return attemptMetrics(job, await attemptDigest(mesh, job), prices, now);
}
