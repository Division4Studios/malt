/** @file Backpressured native SSE reads; no offline mutation queue or provider credentials. */
import { hasTerminalEnded, terminalPage } from './terminal-contract.ts';

import type { TerminalPage } from './terminal-contract.ts';

/** Bound one browser-delivered byte chunk and incomplete SSE frame. */
const LIMIT = {
  chunk: 1_048_576,
  frame: 524_288,
  failures: 6,
  backoff: 1000,
  delay: 16_000,
  deadline: 135_000,
  unauthorized: 401,
} as const;
/** Operator-visible stream state, distinct from the native session lifecycle. */
export type TerminalConnectionState = 'connecting' | 'live' | 'disconnected' | 'ended' | 'expired';
/** Selected project and model/render callbacks. */
export interface TerminalStreamOptions {
  /** Public project scope, never a bearer token. */
  readonly project: string;
  /** Backend-created session identity. */
  readonly id: string;
  /** Wait for bounded model/render work before reading more network data. */
  readonly page: (page: TerminalPage, signal: AbortSignal) => Promise<void>;
  /** Truthful connection feedback without raw output in errors. */
  readonly state: (state: TerminalConnectionState) => void;
}
/** A single decoded terminal event. */
interface TerminalEvent {
  /** Server cursor from the SSE envelope. */
  readonly id: string;
  /** Still untrusted decoded JSON. */
  readonly value: unknown;
}

/** Incremental, bounded SSE framing independent of native network chunk boundaries. */
export class TerminalEventDecoder {
  /** Incomplete frame only, never a transcript. */
  private pending = '';
  /** Chunk-safe wire decoder. */
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });

  /**
   * Decode complete terminal events without retaining processed frames.
   *
   * @param bytes - One bounded native fetch chunk.
   * @returns Completed terminal events.
   * @throws {Error} For invalid, disconnected or oversized frames.
   */
  public push(bytes: Uint8Array): TerminalEvent[] {
    if (bytes.byteLength > LIMIT.chunk) {
      throw new Error('Terminal network chunk exceeded its bound.');
    }
    this.pending += this.decoder.decode(bytes, { stream: true });
    const output: TerminalEvent[] = [];
    let boundary = this.pending.indexOf('\n\n');
    while (boundary !== -1) {
      if (boundary > LIMIT.frame) {
        throw new Error('Terminal frame exceeded its bound.');
      }
      const frame = this.pending.slice(0, boundary);
      this.pending = this.pending.slice(boundary + '\n\n'.length);
      const event = this.event(frame);
      if (event !== null) {
        output.push(event);
      }
      boundary = this.pending.indexOf('\n\n');
    }
    if (this.pending.length > LIMIT.frame) {
      throw new Error('Incomplete terminal frame exceeded its bound.');
    }
    return output;
  }

  /**
   * Accept only the broker's explicit terminal event envelope.
   *
   * @param frame - Complete bounded SSE frame.
   * @returns Untrusted event for schema validation, or an ignored heartbeat.
   * @throws {Error} For ambiguous event fields or backend disconnection.
   */
  private event(frame: string): TerminalEvent | null {
    const lines = frame.split('\n');
    const kinds = lines.filter((line) => line.startsWith('event:')).map((line) => line.slice('event:'.length).trim());
    if (kinds.length === 0) {
      return null;
    }
    if (kinds.length !== 1 || kinds[0] !== 'terminal') {
      throw new Error('Terminal backend disconnected.');
    }
    const ids = lines.filter((line) => line.startsWith('id:')).map((line) => line.slice('id:'.length).trim());
    const bodies = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice('data:'.length).trim());
    const id = ids[0];
    const body = bodies[0];
    if (id === undefined || body === undefined || ids.length !== 1 || bodies.length !== 1 || !/^\d{1,16}$/v.test(id)) {
      throw new Error('Invalid terminal event envelope.');
    }
    return { id, value: JSON.parse(body) };
  }
}

/**
 * Wait between read-only reconnects, releasing the timer on view cancellation.
 *
 * @param ms - Bounded backoff.
 * @param signal - Owned view lifetime.
 * @returns A settled delay, including cancellation.
 */
async function delay(ms: number, signal: AbortSignal): Promise<void> {
  const pending = Promise.withResolvers<undefined>();
  const wake = (): void => {
    pending.resolve(undefined);
  };
  const timer = setTimeout(wake, ms);
  signal.addEventListener('abort', wake, { once: true });
  if (signal.aborted) {
    wake();
  }
  try {
    await pending.promise;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', wake);
  }
}

/** One selected view owns its fetch, cursor, backoff and cancellation. */
export class TerminalStream {
  /** Immutable selected project/session callbacks. */
  private readonly options: TerminalStreamOptions;
  /** Idempotent view shutdown. */
  private readonly controller = new AbortController();
  /** Cursor advances only after the caller applied the whole page. */
  private after = 0;
  /** A view can own at most one read/reconnect loop. */
  private running: Promise<void> | null = null;

  /**
   * Prepare a stream without creating or attaching any native process.
   *
   * @param options - Captured operator selection.
   */
  public constructor(options: TerminalStreamOptions) {
    this.options = Object.freeze({ ...options });
  }

  /** Stop only this view's reads and reconnects. */
  public close(): void {
    this.controller.abort();
  }

  /**
   * Read with bounded consecutive retries; never replay input or native controls.
   *
   * @returns The single owned read loop, safe to await repeatedly.
   */
  public async run(): Promise<void> {
    this.running ??= this.reconnect();
    return this.running;
  }

  /**
   * Recheck cancellation afresh across asynchronous callbacks.
   *
   * @returns Whether this view has permanently closed.
   */
  private isClosed(): boolean {
    return this.controller.signal.aborted;
  }

  /**
   * Convert a single network/protocol attempt into bounded reconnect state.
   *
   * @returns Actual connection outcome or a fixed failure category.
   */
  private async attempt(): Promise<'ended' | 'expired' | 'healthy' | 'empty' | 'failed'> {
    try {
      return await this.read();
    } catch {
      return 'failed';
    }
  }

  /** Read-only reconnects never replay native controls. */
  private async reconnect(): Promise<void> {
    const { signal } = this.controller;
    let failures = 0;
    while (!this.isClosed() && failures < LIMIT.failures) {
      this.options.state('connecting');
      // eslint-disable-next-line no-await-in-loop -- One fetch at a time preserves cursor and backpressure ownership.
      const result = await this.attempt();
      if (this.isClosed()) {
        return;
      }
      if (result === 'ended') {
        this.options.state('ended');
        return;
      }
      if (result === 'expired') {
        this.options.state('expired');
        return;
      }
      failures = result === 'healthy' ? 0 : failures + 1;
      this.options.state('disconnected');
      // eslint-disable-next-line no-await-in-loop -- A cancelled or failed reader must back off before reconnecting.
      await delay(Math.min(LIMIT.delay, LIMIT.backoff * 2 ** failures), signal);
    }
  }

  /**
   * Consume one finite server connection, waiting for rendering before more reads.
   *
   * @returns Final session state or whether a healthy connection needs renewal.
   * @throws {Error} For failed authentication/protocol/network boundaries.
   */
  private async read(): Promise<'ended' | 'expired' | 'healthy' | 'empty'> {
    const { signal } = this.controller;
    const query = new URLSearchParams({ project: this.options.project, id: this.options.id });
    const response = await fetch(`/api/terminal-stream?${query.toString()}`, {
      cache: 'no-store',
      redirect: 'error',
      headers: { 'Last-Event-ID': String(this.after) },
      signal: AbortSignal.any([signal, AbortSignal.timeout(LIMIT.deadline)]),
    });
    if (response.status === LIMIT.unauthorized) {
      await response.body?.cancel();
      return 'expired';
    }
    if (
      !response.ok ||
      response.body === null ||
      response.headers.get('content-type')?.startsWith('text/event-stream') !== true
    ) {
      await response.body?.cancel();
      throw new Error('Terminal stream unavailable.');
    }
    this.options.state('live');
    return this.consume(response.body, signal);
  }

  /**
   * Decode bounded pages and acknowledge only completed model/render work.
   *
   * @param body - Native fetch stream.
   * @param signal - Owned view lifetime.
   * @returns Whether the session ended or its healthy connection needs renewal.
   */
  private async consume(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<'ended' | 'healthy' | 'empty'> {
    const reader = body.getReader();
    try {
      return await this.pump(reader, signal);
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* A failed owned fetch may already be cancelled. */
      }
      reader.releaseLock();
    }
  }

  /**
   * Read one bounded chunk only after preceding pages are applied.
   *
   * @param reader - Owned native stream reader.
   * @param signal - View lifetime passed to rendering callbacks.
   * @returns Session completion or healthy renewal state.
   */
  private async pump(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    signal: AbortSignal,
  ): Promise<'ended' | 'healthy' | 'empty'> {
    const decoder = new TerminalEventDecoder();
    let hasPage = false;
    let hasEnded = false;
    while (!this.isClosed()) {
      // eslint-disable-next-line no-await-in-loop -- Backpressure begins at the native reader rather than an unbounded event queue.
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      const events = decoder.push(chunk.value);
      for (const event of events) {
        // eslint-disable-next-line no-await-in-loop -- Acknowledge one complete page before applying another.
        const result = await this.apply(event, signal);
        if (result === null) {
          return 'empty';
        }
        hasPage = true;
        hasEnded = result;
      }
    }
    if (hasEnded) {
      return 'ended';
    }
    return hasPage ? 'healthy' : 'empty';
  }

  /**
   * Acknowledge output only after completed rendering; renderer faults park the view.
   *
   * @param event - Decoded untrusted event envelope.
   * @param signal - Owned view lifetime.
   * @returns Whether the native session ended, or null after cancellation.
   * @throws {Error} For invalid scopes, cursors or rendering failures.
   */
  private async apply(event: TerminalEvent, signal: AbortSignal): Promise<boolean | null> {
    if (this.isClosed()) {
      return null;
    }
    const page = terminalPage(event.value, { id: this.options.id, after: this.after });
    if (String(page.nextCursor) !== event.id) {
      throw new Error('Terminal event cursor mismatch.');
    }
    try {
      await this.options.page(page, signal);
    } catch (error) {
      this.options.state('disconnected');
      this.close();
      throw error;
    }
    if (this.isClosed()) {
      return null;
    }
    this.after = page.nextCursor;
    return hasTerminalEnded(page);
  }
}
