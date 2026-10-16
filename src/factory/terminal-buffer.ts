/**
 * In-memory, byte-bounded terminal replay with streaming secret redaction.
 *
 * @file
 */
import { Buffer } from 'node:buffer';
import { StringDecoder } from 'node:string_decoder';

import { SecretRedactor } from '../secrets.ts';

import { credentialValues } from './authentication.ts';

/** Bound transient decoding and redaction work even for one oversized write. */
const DECODE_BYTES = 4096;
/** Tiny writes cannot turn a small text ring into unbounded object/iteration overhead. */
const MAX_CHUNKS = 4096;
/** UTF-8 continuation bytes start with these two high bits. */
const CONTINUATION_MIN = 128;
/** First byte after the UTF-8 continuation range. */
const CONTINUATION_END = 192;

/** Redacted output committed to the replay ring. */
export interface TerminalChunk {
  /** Discriminator for output content. */
  readonly type: 'data';
  /** Monotonic cursor assigned only when safe output is committed. */
  readonly sequence: number;
  /** UTF-8 decoded and redacted terminal text. */
  readonly text: string;
}

/** Replay gap marker; its cursor precedes any retained data. */
export interface TerminalTruncation {
  /** Discriminator for an evicted replay start. */
  readonly type: 'truncated';
  /** Last sequence whose content was wholly or partially evicted. */
  readonly sequence: number;
}

/** Replay content or an explicit gap marker. */
export type TerminalOutput = TerminalChunk | TerminalTruncation;

/**
 * Validate materialization limits before touching the retained ring.
 *
 * @param limits - Requested page bounds.
 * @param capacity - Configured text retention ceiling.
 * @returns Bounds permitting a gap marker and one decoding chunk.
 * @throws {RangeError} For an impossible page.
 */
function replayLimits(
  limits: { bytes?: number; entries?: number },
  capacity: number,
): { bytes: number; entries: number } {
  const entries = limits.entries ?? MAX_CHUNKS + 1;
  const bytes = limits.bytes ?? capacity;
  if (
    !Number.isSafeInteger(entries) ||
    entries < 2 ||
    entries > MAX_CHUNKS + 1 ||
    !Number.isSafeInteger(bytes) ||
    bytes < Math.min(capacity, DECODE_BYTES)
  ) {
    throw new RangeError('Terminal replay limits must permit one bounded native entry and a gap marker.');
  }
  return { bytes, entries };
}

/**
 * Retain only redacted text, never disk content, input or transport state.
 * Decoder state is at most one incomplete UTF-8 character; redactor state is
 * bounded by the longest supplied credential. The byte cap covers replay text.
 * Call finish on stream exit to release the redactor's withheld suffix.
 */
export class TerminalBuffer {
  /** Configured replay content byte ceiling. */
  private readonly maxBytes: number;
  /** Ordered entries; positive byte sizes also bound the entry count. */
  private readonly chunks = new Map<number, TerminalChunk>();
  /** Chunk-safe native byte decoder. */
  private readonly decoder = new StringDecoder('utf8');
  /** Per-stream credential boundary protection. */
  private readonly redactor: SecretRedactor;
  /** Current replay content bytes. */
  private retainedBytes = 0;
  /** Last allocated safe-output cursor, including discarded oversized output. */
  private sequence = 0;
  /** Last cursor with any lost bytes. */
  private evictedThrough = 0;
  /** Terminal exit closes this stream permanently. */
  private finished = false;

  /**
   * Create an isolated output stream with backend-owned credential values.
   *
   * @param maxBytes - Positive safe integer byte ceiling for replay text.
   * @param environment - Owning environment; defaults to backend process.env.
   * @param secrets - Additional known credentials, such as auth-file values.
   * @throws {RangeError} When the byte ceiling is invalid.
   */
  public constructor(maxBytes: number, environment: NodeJS.ProcessEnv = process.env, secrets: readonly string[] = []) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new RangeError('Terminal buffer byte cap must be a positive safe integer.');
    }
    this.maxBytes = maxBytes;
    this.redactor = new SecretRedactor([...credentialValues(environment), ...secrets]);
  }

  /**
   * Report actual retained UTF-8 content bytes, excluding object metadata.
   *
   * @returns Current replay byte size.
   */
  public get byteLength(): number {
    return this.retainedBytes;
  }

  /**
   * Decode native bytes and commit safe prefixes without retaining raw chunks.
   *
   * @param bytes - Native UTF-8 output, possibly split inside a character.
   * @throws {Error} When output arrives after finish.
   */
  public write(bytes: Uint8Array): void {
    if (this.finished) {
      throw new Error('Terminal buffer is finished.');
    }
    for (let offset = 0; offset < bytes.length; offset += DECODE_BYTES) {
      const decoded = this.decoder.write(bytes.subarray(offset, offset + DECODE_BYTES));
      this.store(this.redactor.write(decoded));
    }
  }

  /** Flush the decoder and redactor on exit; repeated calls are harmless. */
  public finish(): void {
    if (this.finished) {
      return;
    }
    this.finished = true;
    this.store(this.redactor.write(this.decoder.end()));
    this.store(this.redactor.finish());
  }

  /**
   * Copy safe entries strictly after a reconnect cursor, with an explicit gap.
   * A partially retained oversized entry keeps its cursor and follows the gap
   * marker. Future cursors return no content. Reading never flushes raw state.
   *
   * @param sequence - Last received cursor, or zero for the stream start.
   * @param limits - Bounded materialization; enough byte room for one native decoding chunk.
   * @returns Independent replay entries in emission order, without scanning discarded history.
   * @throws {RangeError} When the cursor is not a nonnegative safe integer.
   */
  public readAfter(sequence: number, limits: { bytes?: number; entries?: number } = {}): TerminalOutput[] {
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      throw new RangeError('Terminal replay cursor must be a nonnegative safe integer.');
    }
    const output: TerminalOutput[] = [];
    const { entries: maxEntries, bytes: maxBytes } = replayLimits(limits, this.maxBytes);
    if (sequence < this.evictedThrough) {
      output.push({ type: 'truncated', sequence: this.evictedThrough });
    }
    const first = this.chunks.keys().next().value;
    if (first === undefined) {
      return output;
    }
    let bytes = 0;
    for (
      let cursor = Math.max(first, sequence + 1);
      cursor <= this.sequence && output.length < maxEntries;
      cursor += 1
    ) {
      const chunk = this.chunks.get(cursor);
      if (chunk === undefined) {
        continue;
      }
      const size = Buffer.byteLength(chunk.text);
      if (bytes + size > maxBytes) {
        break;
      }
      output.push({ ...chunk });
      bytes += size;
    }
    return output;
  }

  /**
   * Evict oldest entries and keep a valid UTF-8 tail of oversized safe output.
   *
   * @param text - Already redacted committed prefix.
   */
  private store(text: string): void {
    if (text === '') {
      return;
    }
    const bytes = Buffer.from(text);
    for (let start = 0; start < bytes.length;) {
      let end = Math.min(start + DECODE_BYTES, bytes.length);
      while (end < bytes.length && (bytes[end] ?? 0) >= CONTINUATION_MIN && (bytes[end] ?? 0) < CONTINUATION_END) {
        end -= 1;
      }
      this.storeChunk(bytes.subarray(start, end));
      start = end;
    }
  }

  /**
   * Store one already-redacted UTF-8 entry within both text and metadata bounds.
   *
   * @param bytes - At most one bounded native decoding chunk.
   */
  private storeChunk(bytes: Buffer): void {
    this.sequence += 1;
    let start = Math.max(0, bytes.length - this.maxBytes);
    while (start < bytes.length && (bytes[start] ?? 0) >= CONTINUATION_MIN && (bytes[start] ?? 0) < CONTINUATION_END) {
      start += 1;
    }
    const retained = bytes.subarray(start);
    if (start > 0) {
      // A gap inside this entry invalidates all earlier replay content.
      this.chunks.clear();
      this.retainedBytes = 0;
      this.evictedThrough = this.sequence;
    }
    while (this.retainedBytes + retained.length > this.maxBytes || this.chunks.size >= MAX_CHUNKS) {
      const oldest = this.chunks.values().next().value;
      if (oldest === undefined) {
        break;
      }
      this.chunks.delete(oldest.sequence);
      this.retainedBytes -= Buffer.byteLength(oldest.text);
      this.evictedThrough = Math.max(this.evictedThrough, oldest.sequence);
    }
    if (retained.length === 0) {
      return;
    }
    this.chunks.set(this.sequence, { type: 'data', sequence: this.sequence, text: retained.toString('utf8') });
    this.retainedBytes += retained.length;
  }
}
