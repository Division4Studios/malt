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
   * @returns Independent replay entries in emission order.
   * @throws {RangeError} When the cursor is not a nonnegative safe integer.
   */
  public readAfter(sequence: number): TerminalOutput[] {
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      throw new RangeError('Terminal replay cursor must be a nonnegative safe integer.');
    }
    const output: TerminalOutput[] = [];
    if (sequence < this.evictedThrough) {
      output.push({ type: 'truncated', sequence: this.evictedThrough });
    }
    for (const chunk of this.chunks.values()) {
      if (chunk.sequence > sequence) {
        output.push({ ...chunk });
      }
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
    this.sequence += 1;
    const bytes = Buffer.from(text);
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
    while (this.retainedBytes + retained.length > this.maxBytes) {
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
