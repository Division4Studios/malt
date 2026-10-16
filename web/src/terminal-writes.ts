/** @file Bounded single-flight input; uncertain writes are never retried or persisted. */
/** At most one native payload waits behind one in-flight payload. */
const MAX_BYTES = 16_384;
/** Native UTF-8 accounting includes non-ASCII operator input. */
const encoder = new TextEncoder();
/** Native UI callbacks freeze project/session scope before queue construction. */
export interface TerminalWriteHooks {
  /** Fresh connectivity and exact project/session ownership gate. */
  readonly isReady: () => boolean;
  /** Send once through the authenticated native terminal boundary. */
  readonly send: (text: string) => Promise<void>;
  /** Report uncertainty without echoing the operator's input. */
  readonly failed: () => void;
}

/** One pane/session lifetime owns a queue; focus changes do not discard admitted keys. */
export class TerminalWrites {
  /** Queued keystrokes stay transient and bounded. */
  private pending = '';
  /** UTF-8 count avoids re-encoding the entire queue on each key. */
  private bytes = 0;
  /** Only one request may be in flight. */
  private isSending = false;
  /** Cancellation or uncertainty fences every future queued key. */
  private isClosed = false;
  /** Frozen callback scope. */
  private readonly hooks: TerminalWriteHooks;

  /**
   * Create an empty queue without performing a request.
   *
   * @param hooks - Captured native control boundary and ownership checks.
   */
  public constructor(hooks: TerminalWriteHooks) {
    this.hooks = Object.freeze({ ...hooks });
  }

  /**
   * Admit explicit focus-scoped text, never allowing an unbounded keystroke backlog.
   *
   * @param text - Already encoded key or sanitized paste.
   * @returns Whether it entered this live queue.
   * @throws {RangeError} When pending input exceeds one native payload.
   */
  public append(text: string): boolean {
    if (text === '' || this.isClosed) {
      return false;
    }
    if (!this.hooks.isReady()) {
      this.close();
      return false;
    }
    const bytes = encoder.encode(text).byteLength;
    if (this.bytes + bytes > MAX_BYTES) {
      throw new RangeError('Terminal input queue is full. Wait for the current input to settle.');
    }
    this.pending += text;
    this.bytes += bytes;
    if (!this.isSending) {
      this.isSending = true;
      void this.drain();
    }
    return true;
  }

  /** Drop unsent text immediately; an already sent request cannot be recalled. */
  public close(): void {
    this.isClosed = true;
    this.pending = '';
    this.bytes = 0;
  }

  /**
   * Recheck scope after each asynchronous request, never relying on stale narrowing.
   *
   * @returns Whether this capture can still send its pending text.
   */
  private canSend(): boolean {
    return !this.isClosed && this.hooks.isReady() && this.pending !== '';
  }

  /** Drain serially with no retry, storage, hidden timer or offline replay. */
  private async drain(): Promise<void> {
    try {
      while (this.canSend()) {
        const text = this.pending;
        this.pending = '';
        this.bytes = 0;
        // eslint-disable-next-line no-await-in-loop -- Exactly one bounded native input request may be in flight.
        await this.hooks.send(text);
      }
    } catch {
      const shouldReport = !this.isClosed;
      this.close();
      if (shouldReport) {
        this.hooks.failed();
      }
    } finally {
      this.isSending = false;
      if (!this.hooks.isReady()) {
        this.close();
      }
    }
  }
}
