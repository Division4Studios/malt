/**
 * Meaningful progress signals for assignment liveness. Only completed tool
 * and check calls, tracked edits, commits and explicit check-ins count.
 * Thinking, assistant prose, heartbeats, repeated identical output and raw
 * log growth do not. A provider that stops to wait for a permission or an
 * answer is reported as awaiting input, never as progressing.
 *
 * The provider stream is decoded incrementally with the same decoders the
 * transcript viewer uses. Reads are bounded per sample, partial lines are
 * carried to the next read, and oversized lines are skipped without being
 * held in memory.
 *
 * @file
 */
import { createHash } from 'node:crypto';

import { LIVENESS_TEXT_MAX } from './liveness-schema.ts';

import type { TranscriptSink } from './transcript-events.ts';

/** Most stream bytes decoded in one sample. */
export const SAMPLE_BYTES_MAX = 4_194_304;
/** Longest stream line decoded; longer lines are skipped. */
export const LINE_BYTES_MAX = 1_048_576;
/** Most tool identities remembered for pairing and de-duplication. */
const TRACKED_MAX = 10_000;

/**
 * Bound a signal label.
 *
 * @param text - Signal or wait description, possibly long.
 * @returns Label of at most the recorded length.
 */
function label(text: string): string {
  return text.length <= LIVENESS_TEXT_MAX ? text : `${text.slice(0, LIVENESS_TEXT_MAX - 1)}…`;
}

/**
 * Forget the oldest entry once a bounded map or set is full.
 *
 * @param collection - Insertion-ordered collection.
 */
function evict(collection: Map<string, unknown> | Set<string>): void {
  if (collection.size <= TRACKED_MAX) {
    return;
  }
  const oldest = collection.keys().next();
  if (oldest.done !== true) {
    collection.delete(oldest.value);
  }
}

/** Counts meaningful decoded events; transcript-only events are ignored. */
export class ProgressSink implements TranscriptSink {
  /** Meaningful events so far. */
  public meaningful = 0;
  /** Label of the newest meaningful event. */
  public lastSignal: string | null = null;
  /** What the provider currently waits on, if anything. */
  public awaiting: string | null = null;
  /** Open tool calls: identity to name and input digest. */
  private readonly tools = new Map<string, { name: string; input: string }>();
  /** Tool calls already completed, so duplicate completions count once. */
  private readonly closed = new Set<string>();
  /** Tool calls whose result is a wait for input, not progress. */
  private readonly waiting = new Set<string>();
  /** Digest of the previous completion, so repeated identical output counts once. */
  private previous = '';

  /**
   * Remember a tool call so its completion can be paired and de-duplicated.
   *
   * @param id - Provider call identity.
   * @param name - Tool identifier shown in the signal.
   * @param input - Untrusted arguments.
   */
  public openTool(id: string, name: string, input: unknown): void {
    if (this.tools.has(id)) {
      return;
    }
    this.tools.set(id, { name, input: JSON.stringify(input) });
    evict(this.tools);
  }

  /**
   * Count a completed tool or check call once.
   *
   * @param id - Provider call identity.
   * @param output - Result text.
   */
  public closeTool(id: string, output: string): void {
    if (this.closed.has(id) || this.waiting.has(id)) {
      return;
    }
    this.closed.add(id);
    evict(this.closed);
    const tool = this.tools.get(id);
    const name = tool?.name ?? 'tool';
    this.count(`tool ${name}`, `${name}\0${tool?.input ?? ''}\0${output}`);
  }

  /**
   * Count a provider-reported file change. The provider item identity keeps
   * consecutive patches to the same file distinct.
   *
   * @param changes - Changed paths.
   * @param id - Provider item identity.
   */
  public fileChange(changes: readonly { path: string; kind: string }[], id: string): void {
    const first = changes[0];
    if (first !== undefined) {
      this.count(`edit ${first.path}`, `edit\0${id}\0${JSON.stringify(changes)}`);
    }
  }

  /**
   * Record a wait for a permission or an answer.
   *
   * @param reason - What it waits on.
   * @param id - Waiting tool call, if any.
   */
  public awaitInput(reason: string, id: string | null): void {
    if (id !== null) {
      this.waiting.add(id);
      evict(this.waiting);
    }
    this.awaiting = label(reason);
  }

  /** Clear a wait once other progress shows the provider moved on. */
  public resume(): void {
    this.awaiting = null;
  }

  /** Assistant, thinking, result and status text is not progress. */
  public text(): void {
    // Prose and thinking never refresh liveness.
  }

  /** Edit intent is counted when its tool call completes, not when it starts. */
  public touch(): void {
    // Counted on completion.
  }

  /** Usage is accounting, not progress. */
  public addUsage(): void {
    // Not progress.
  }

  /** Final reports are accounting, not progress. */
  public report(): void {
    // Not progress.
  }

  /** Turn boundaries are not progress. */
  public addTurn(): void {
    // Not progress.
  }

  /** The model name is not progress. */
  public setModel(): void {
    // Not progress.
  }

  /** Malformed lines are not progress. */
  public countMalformed(): void {
    // Not progress.
  }

  /** Unknown events are not progress. */
  public countUnknown(): void {
    // Not progress.
  }

  /** Provider errors are not progress. */
  public markProviderError(): void {
    // Not progress.
  }

  /**
   * Count one meaningful event unless it repeats the previous one exactly.
   *
   * @param signal - Label shown to the operator.
   * @param identity - Content identity used to drop identical repeats.
   */
  private count(signal: string, identity: string): void {
    const digest = createHash('sha256').update(identity).digest('hex');
    if (digest === this.previous) {
      return;
    }
    this.previous = digest;
    this.meaningful += 1;
    this.lastSignal = label(signal);
    this.awaiting = null;
  }
}
