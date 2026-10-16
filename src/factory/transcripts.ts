/**
 * Normalize one attempt's provider stream (`stdout.log`) into ordered,
 * bounded transcript nodes plus stream metrics. Parsing is cached per job
 * and stream version, so repeated page reads of a finished attempt are cheap.
 *
 * @file
 */
import { readPromptPrefix, readStreamLines, streamVersion } from './attempt-stream.ts';
import { TranscriptBuilder } from './transcript-builder.ts';
import { claudeLine, codexLine } from './transcript-events.ts';

import type { MeshConfig } from '../config.ts';
import type { StreamRead, StreamVersion } from './attempt-stream.ts';
import type { FactoryJob, Provider } from './schema.ts';
import type { TranscriptParse } from './transcript-builder.ts';

/** Fully parsed transcripts retained in memory. */
const TRANSCRIPT_CACHE_MAX = 4;

/** Normalized attempt together with how its stream was read. */
export interface AttemptParse {
  /** Nodes, touched files and stream metrics. */
  readonly parse: TranscriptParse;
  /** Byte accounting and availability of the stream. */
  readonly read: StreamRead;
}

/** One cached transcript and the stream version it was built from. */
interface CachedTranscript {
  /** Cache validity key. */
  readonly key: string;
  /** Parsed attempt. */
  readonly value: AttemptParse;
}

/** Small most-recently-used transcript cache keyed by job id. */
const transcripts = new Map<string, CachedTranscript>();

/**
 * Normalize provider stream lines held in memory.
 *
 * @param lines - Raw stream lines in order.
 * @param provider - Provider family that wrote the stream.
 * @param options - Whether to collect nodes, whether the attempt is live, and an optional prompt prefix.
 * @returns Nodes, touched files and stream metrics.
 */
export function normalizeLines(
  lines: Iterable<string>,
  provider: Provider,
  options: { isCollecting: boolean; isLive: boolean; prompt?: { text: string; truncated: boolean } | null },
): TranscriptParse {
  const builder = new TranscriptBuilder(options.isCollecting);
  if (options.prompt !== undefined && options.prompt !== null) {
    builder.input(options.prompt.text, options.prompt.truncated);
  }
  const decode = provider === 'claude' ? claudeLine : codexLine;
  for (const line of lines) {
    decode(builder, line);
  }
  return builder.finish(options.isLive);
}

/**
 * Read and normalize one attempt's stream from its confined artifact directory.
 *
 * @param mesh - Selected project.
 * @param job - Attempt whose stream to read.
 * @param options - Whether to collect transcript nodes and an already-resolved stream version.
 * @returns Parsed attempt and read accounting.
 */
export async function parseAttempt(
  mesh: MeshConfig,
  job: FactoryJob,
  options: { isCollecting: boolean; version?: StreamVersion | null },
): Promise<AttemptParse> {
  const version = options.version === undefined ? await streamVersion(mesh, job.artifact) : options.version;
  const builder = new TranscriptBuilder(options.isCollecting);
  if (options.isCollecting) {
    const prompt = await readPromptPrefix(mesh, job.artifact);
    if (prompt !== null) {
      builder.input(prompt.text, prompt.truncated);
    }
  }
  const decode = job.provider === 'claude' ? claudeLine : codexLine;
  const read = await readStreamLines(version, (line) => {
    decode(builder, line);
  });
  return { parse: builder.finish(job.state === 'running'), read };
}

/**
 * Read a full transcript, reusing the cached parse while the stream is unchanged.
 *
 * @param mesh - Selected project.
 * @param job - Attempt to show.
 * @returns Parsed attempt with transcript nodes.
 */
export async function attemptTranscript(mesh: MeshConfig, job: FactoryJob): Promise<AttemptParse> {
  const version = await streamVersion(mesh, job.artifact);
  const key = `${job.state}:${String(version?.size ?? -1)}:${String(version?.mtimeMs ?? -1)}`;
  const cached = transcripts.get(job.id);
  if (cached?.key === key) {
    transcripts.delete(job.id);
    transcripts.set(job.id, cached);
    return cached.value;
  }
  const value = await parseAttempt(mesh, job, { isCollecting: true, version });
  transcripts.delete(job.id);
  transcripts.set(job.id, { key, value });
  for (const stale of transcripts.keys()) {
    if (transcripts.size <= TRANSCRIPT_CACHE_MAX) {
      break;
    }
    transcripts.delete(stale);
  }
  return value;
}
