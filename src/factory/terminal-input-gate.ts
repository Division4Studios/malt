/** @file Per-session token buckets; keystroke content never enters accounting. */
import { MeshError } from '../protocol.ts';

/** Native write payload ceiling in UTF-8 bytes. */
export const TERMINAL_INPUT_BYTES = 16_384;
/** Per-second input throughput; burst capacity is four payloads. */
const INPUT_RATE = TERMINAL_INPUT_BYTES;
/** Four bounded writes permit a short operator paste burst. */
const BURST_MULTIPLIER = 4;
/** Resize events are debounced by clients and limited again at the backend. */
const RESIZE_RATE = 20;
/** Clock conversion. */
const SECOND_MS = 1000;
/** Numeric accounting only. */
interface Bucket {
  /** Current token balance. */
  tokens: number;
  /** Last monotonic effective refill time. */
  updatedAt: number;
}

/** Bounded traffic allowance for exactly one admitted terminal. */
export class TerminalInputGate {
  /** Input token balance, never content. */
  private readonly input: Bucket;
  /** Independent resize allowance. */
  private readonly resize: Bucket;

  /**
   * Initialize a fresh owned session's allowance.
   *
   * @param now - Owning clock in milliseconds.
   */
  public constructor(now: number) {
    this.input = { tokens: INPUT_RATE * BURST_MULTIPLIER, updatedAt: now };
    this.resize = { tokens: RESIZE_RATE, updatedAt: now };
  }

  /**
   * Reserve a validated input or resize frame before touching the PTY.
   *
   * @param kind - Independent operation bucket.
   * @param bytes - UTF-8 byte size, ignored for resize.
   * @param now - Owning clock.
   * @throws {MeshError} For a payload or traffic limit.
   */
  public take(kind: 'input' | 'resize', bytes: number, now: number): void {
    if (kind === 'input' && (bytes <= 0 || bytes > TERMINAL_INPUT_BYTES)) {
      throw new MeshError('TOO_LARGE', 'Terminal input exceeds its UTF-8 payload limit.');
    }
    const bucket = kind === 'input' ? this.input : this.resize;
    const rate = kind === 'input' ? INPUT_RATE : RESIZE_RATE;
    const capacity = kind === 'input' ? INPUT_RATE * BURST_MULTIPLIER : RESIZE_RATE;
    const cost = kind === 'input' ? bytes : 1;
    const at = Math.max(now, bucket.updatedAt);
    const tokens = Math.min(capacity, bucket.tokens + ((at - bucket.updatedAt) / SECOND_MS) * rate);
    if (tokens < cost) {
      throw new MeshError('FACTORY_GATED', 'Terminal traffic limit reached; wait before sending more.');
    }
    bucket.tokens = tokens - cost;
    bucket.updatedAt = at;
  }
}
