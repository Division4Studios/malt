/**
 * Length-prefixed frames between the broker and the terminal host. Pure: no spawning and no PTY. A frame is a
 * four byte big-endian length (type byte plus body), a one byte type and the body. Terminal bytes travel raw;
 * control bodies are Zod-validated JSON. Malformed, oversized or unknown frames are a typed protocol error
 * that poisons the decoder, so the session must end instead of ignoring them.
 *
 * @file
 */

import { Buffer } from 'node:buffer';

import { z } from 'zod';

/** Bytes in a kibibyte. */
const KIB = 1024;
/** Largest accepted frame body in kibibytes. */
const MAX_FRAME_KIB = 64;
/** Largest accepted frame body in bytes; larger declarations are rejected before any body is buffered. */
export const MAX_FRAME_BODY = MAX_FRAME_KIB * KIB;
/** Smallest terminal width in columns. */
export const MIN_COLUMNS = 1;
/** Largest terminal width in columns. */
export const MAX_COLUMNS = 500;
/** Smallest terminal height in rows. */
export const MIN_ROWS = 1;
/** Largest terminal height in rows. */
export const MAX_ROWS = 200;
/** Longest error message carried by an error frame. */
const MAX_MESSAGE = 500;
/** Longest machine-readable error code or signal name. */
const MAX_CODE = 64;
/** Length prefix size in bytes. */
const LENGTH_BYTES = 4;
/** Length prefix plus the one byte frame type. */
const HEADER_BYTES = LENGTH_BYTES + 1;

/** Frame kinds; the wire type byte is the one-based position. */
const FRAME_TYPES = ['data', 'input', 'resize', 'close', 'exit', 'error'] as const;
/** Frame kinds. */
export type FrameType = (typeof FRAME_TYPES)[number];

/** Every valid frame. Data and input carry raw bytes. */
export const frameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('data'), data: z.instanceof(Uint8Array) }).strict(),
  z.object({ type: z.literal('input'), data: z.instanceof(Uint8Array) }).strict(),
  z
    .object({
      type: z.literal('resize'),
      columns: z.number().int().min(MIN_COLUMNS).max(MAX_COLUMNS),
      rows: z.number().int().min(MIN_ROWS).max(MAX_ROWS),
    })
    .strict(),
  z.object({ type: z.literal('close') }).strict(),
  z
    .object({
      type: z.literal('exit'),
      code: z.number().int().nullable(),
      signal: z.string().max(MAX_CODE).nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal('error'),
      code: z.string().min(1).max(MAX_CODE),
      message: z.string().max(MAX_MESSAGE),
    })
    .strict(),
]);

/** One decoded frame. */
export type Frame = z.infer<typeof frameSchema>;

/** Why a stream was rejected. */
export type ProtocolErrorCode = 'oversized' | 'unknown_type' | 'malformed' | 'invalid_frame' | 'after_error';

/** Fixed messages, so no frame content is ever echoed into an error. */
const MESSAGES: Record<ProtocolErrorCode, string> = {
  oversized: 'Terminal frame exceeds the size limit.',
  unknown_type: 'Terminal frame has an unknown type.',
  malformed: 'Terminal frame is malformed.',
  invalid_frame: 'Terminal frame failed validation.',
  after_error: 'Terminal frame decoder already failed.',
};

/** Typed protocol violation; the session must end. */
export class TerminalProtocolError extends Error {
  /** Violation class. */
  public readonly code: ProtocolErrorCode;

  /**
   * Create a protocol error.
   *
   * @param code - Violation class.
   * @param options - Optional standard error options.
   */
  public constructor(code: ProtocolErrorCode, options?: ErrorOptions) {
    super(MESSAGES[code], options);
    this.name = 'TerminalProtocolError';
    this.code = code;
  }
}

/**
 * Encode one frame, validating it first.
 *
 * @param frame - Frame to encode.
 * @returns Wire bytes.
 * @throws {TerminalProtocolError} When the frame is invalid or its body exceeds the limit.
 */
export function encodeFrame(frame: Frame): Buffer {
  const parsed = frameSchema.safeParse(frame);
  if (!parsed.success) {
    throw new TerminalProtocolError('invalid_frame');
  }
  const valid = parsed.data;
  const body =
    valid.type === 'data' || valid.type === 'input'
      ? valid.data
      : Buffer.from(JSON.stringify({ ...valid, type: undefined }), 'utf8');
  if (body.byteLength > MAX_FRAME_BODY) {
    throw new TerminalProtocolError('oversized');
  }
  const out = Buffer.alloc(HEADER_BYTES + body.byteLength);
  out.writeUInt32BE(1 + body.byteLength, 0);
  out.writeUInt8(FRAME_TYPES.indexOf(valid.type) + 1, LENGTH_BYTES);
  out.set(body, HEADER_BYTES);
  return out;
}

/**
 * Parse a JSON control body.
 *
 * @param body - Frame body.
 * @returns Parsed value.
 * @throws {TerminalProtocolError} When the body is not JSON.
 */
function parseJson(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch (error) {
    throw new TerminalProtocolError('malformed', { cause: error });
  }
}

/**
 * Decode one complete body into a validated frame.
 *
 * @param typeByte - Wire type.
 * @param body - Frame body.
 * @returns Validated frame.
 * @throws {TerminalProtocolError} When the type is unknown or the content invalid.
 */
function decodeBody(typeByte: number, body: Buffer): Frame {
  const type = FRAME_TYPES[typeByte - 1];
  if (type === undefined) {
    throw new TerminalProtocolError('unknown_type');
  }
  let candidate: unknown;
  if (type === 'data' || type === 'input') {
    candidate = { type, data: new Uint8Array(body) };
  } else {
    const json = parseJson(body);
    candidate = typeof json === 'object' && json !== null && !Array.isArray(json) ? { ...json, type } : json;
  }
  const parsed = frameSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new TerminalProtocolError('invalid_frame');
  }
  return parsed.data;
}

/** Incremental decoder; accepts arbitrary chunk boundaries and buffers at most one frame. */
export class FrameDecoder {
  /** Length and type bytes of the current frame. */
  private readonly header = Buffer.alloc(HEADER_BYTES);
  /** Header bytes received so far. */
  private headerFill = 0;
  /** Body of the current frame once its header is known. */
  private body: Buffer | null = null;
  /** Body bytes received so far. */
  private bodyFill = 0;
  /** Set after the first violation; the stream is unusable. */
  private failed = false;

  /**
   * Whether the stream is exactly on a frame boundary.
   *
   * @returns True when no partial frame is pending and no violation occurred.
   */
  public get idle(): boolean {
    return !this.failed && this.headerFill === 0 && this.body === null;
  }

  /**
   * Feed received bytes.
   *
   * @param chunk - Next bytes from the stream, any size.
   * @returns Frames completed by this chunk, in order.
   * @throws {TerminalProtocolError} On the first violation and on every later call.
   */
  public push(chunk: Uint8Array): Frame[] {
    if (this.failed) {
      throw new TerminalProtocolError('after_error');
    }
    try {
      return this.consume(chunk);
    } catch (error) {
      this.failed = true;
      this.body = null;
      throw error;
    }
  }

  /**
   * Split received bytes into completed frames.
   *
   * @param chunk - Received bytes.
   * @returns Completed frames.
   */
  private consume(chunk: Uint8Array): Frame[] {
    const frames: Frame[] = [];
    let offset = 0;
    while (offset < chunk.byteLength) {
      offset += this.body === null ? this.readHeader(chunk, offset) : this.readBody(chunk, offset);
      if (this.body !== null && this.bodyFill === this.body.length) {
        frames.push(this.finish());
      }
    }
    return frames;
  }

  /**
   * Copy header bytes and start the body once the header is complete.
   *
   * @param chunk - Received bytes.
   * @param offset - First unread byte.
   * @returns Bytes consumed.
   * @throws {TerminalProtocolError} When the declared length is empty or too large.
   */
  private readHeader(chunk: Uint8Array, offset: number): number {
    const taken = Math.min(HEADER_BYTES - this.headerFill, chunk.byteLength - offset);
    this.header.set(chunk.subarray(offset, offset + taken), this.headerFill);
    this.headerFill += taken;
    // The length is known after four bytes, so a bad length fails before any body is allocated.
    if (this.headerFill >= LENGTH_BYTES) {
      const length = this.header.readUInt32BE(0);
      if (length < 1) {
        throw new TerminalProtocolError('malformed');
      }
      if (length - 1 > MAX_FRAME_BODY) {
        throw new TerminalProtocolError('oversized');
      }
    }
    if (this.headerFill === HEADER_BYTES) {
      this.body = Buffer.alloc(this.header.readUInt32BE(0) - 1);
      this.bodyFill = 0;
    }
    return taken;
  }

  /**
   * Copy body bytes.
   *
   * @param chunk - Received bytes.
   * @param offset - First unread byte.
   * @returns Bytes consumed.
   */
  private readBody(chunk: Uint8Array, offset: number): number {
    const body = this.body ?? Buffer.alloc(0);
    const taken = Math.min(body.length - this.bodyFill, chunk.byteLength - offset);
    body.set(chunk.subarray(offset, offset + taken), this.bodyFill);
    this.bodyFill += taken;
    return taken;
  }

  /**
   * Validate the completed frame and reset for the next one.
   *
   * @returns The decoded frame.
   * @throws {TerminalProtocolError} When the frame is unknown or invalid.
   */
  private finish(): Frame {
    const body = this.body ?? Buffer.alloc(0);
    const type = this.header.readUInt8(LENGTH_BYTES);
    this.body = null;
    this.headerFill = 0;
    return decodeBody(type, body);
  }
}
