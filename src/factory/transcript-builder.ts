/**
 * Provider-neutral accumulator for one attempt's transcript and stream
 * metrics. Provider decoders call its methods in event order; it bounds node
 * count and every text field, pairs tool calls with results and records which
 * files were changed. Truncation is always reported, never silent.
 *
 * @file
 */

import type { FileTouch, TranscriptNode } from './telemetry-schema.ts';
/** Most transcript nodes kept for one attempt. */
export const NODES_MAX = 2000;
/** Longest one-line primary argument summary. */
const SUMMARY_MAX = 200;
/** JSON indentation for serialized tool input. */
const JSON_INDENT = 2;
/** Input keys that best describe a tool call, in priority order. */
const SUMMARY_KEYS = [
  'file_path',
  'notebook_path',
  'path',
  'command',
  'cmd',
  'pattern',
  'url',
  'query',
  'description',
  'prompt',
  'skill',
] as const;
/** Token counts accumulated from provider usage reports. */
export interface TokenCounts {
  /** Uncached input tokens. */
  input: number;
  /** Input tokens served from the provider cache. */
  cacheRead: number;
  /** Input tokens written to the provider cache. */
  cacheWrite: number;
  /** Output tokens, including reasoning where the provider counts it there. */
  output: number;
  /** Reasoning tokens, when the provider reports them separately. */
  reasoning: number | null;
}
/** Stream-derived metrics independent of the job record. */
export interface StreamDigest {
  /** Reported token split, null when the stream reported no usage. */
  readonly tokens: TokenCounts | null;
  /** Provider-reported cost in USD, null when not reported. */
  readonly reportedCostUsd: number | null;
  /** Reported or counted model turns. */
  readonly turns: number | null;
  /** Provider-reported API time in milliseconds. */
  readonly apiDurationMs: number | null;
  /** Model named by the stream, when it names one. */
  readonly model: string | null;
  /** Whether the provider reported an error result or failed turn. */
  readonly providerError: boolean;
  /** Tool call counts. */
  readonly tools: { total: number; failed: number; byName: { name: string; calls: number; failed: number }[] };
  /** Distinct files changed. */
  readonly filesTouched: number;
  /** Lines that were not JSON objects. */
  readonly malformedLines: number;
  /** JSON events of a type this version does not interpret. */
  readonly unknownEvents: number;
}
/** Complete normalized result of one stream. */
export interface TranscriptParse {
  /** Ordered bounded nodes (empty when nodes were not collected). */
  readonly nodes: TranscriptNode[];
  /** Whether the node cap dropped later nodes. */
  readonly nodesTruncated: boolean;
  /** Files changed, most touched first. */
  readonly files: FileTouch[];
  /** Whether the distinct-file cap dropped paths. */
  readonly filesTruncated: boolean;
  /** Stream metrics. */
  readonly digest: StreamDigest;
}
/** Text clipped to a bound with an explicit flag. */
export interface Clipped {
  /** Retained text. */
  readonly text: string;
  /** Whether characters were removed. */
  readonly truncated: boolean;
}

/**
 * Clip text to a character bound.
 *
 * @param value - Untrusted text.
 * @param max - Largest retained length.
 * @returns Retained prefix and whether anything was dropped.
 */
export function clip(value: string, max: number): Clipped {
  return value.length > max ? { text: value.slice(0, max), truncated: true } : { text: value, truncated: false };
}

/**
 * Serialize an arbitrary tool payload for display.
 *
 * @param value - Untrusted decoded JSON value.
 * @returns Plain string or indented JSON.
 */
export function display(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  return value === undefined ? '' : JSON.stringify(value, null, JSON_INDENT);
}

/**
 * Choose the argument that best identifies a tool call.
 *
 * @param input - Untrusted tool input.
 * @returns One-line bounded description, or an empty string.
 */
export function primaryArgument(input: unknown): string {
  if (typeof input === 'string') {
    return clip(input.replaceAll(/\s+/gv, ' ').trim(), SUMMARY_MAX).text;
  }
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return '';
  }
  const fields = new Map<string, unknown>(Object.entries(input));
  for (const key of SUMMARY_KEYS) {
    const value = fields.get(key);
    if (typeof value === 'string' && value.trim() !== '') {
      return clip(value.replaceAll(/\s+/gv, ' ').trim(), SUMMARY_MAX).text;
    }
  }
  return '';
}
