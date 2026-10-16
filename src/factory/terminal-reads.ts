/** @file Bounded transient terminal replay and operator long polls. */
import { Buffer } from 'node:buffer';

import { z } from 'zod/v3';

import { MeshError } from '../protocol.ts';

import { terminalSessionSchema } from './terminal-sessions.ts';

import type { TerminalBuffer, TerminalOutput } from './terminal-buffer.ts';
import type { TerminalSessions } from './terminal-sessions.ts';

/** Raw content ceiling per page. */
const PAGE_BYTES = 65_536;
/** Per-entry JSON metadata must also obey the bounded SSE envelope. */
const PAGE_ENTRIES = 128;
/** Small bounded finished-output reconnect window. */
const RETAINED = 3;
/** Simultaneous polls per session. */
const SUBSCRIBERS = 2;
/** Ordered output discriminants have independent validated boundaries. */
const dataSchema = z
  .object({ type: z.literal('data'), sequence: z.number().int().nonnegative().safe(), text: z.string() })
  .strict();
/** An explicit eviction marker never contains raw output. */
const gapSchema = z.object({ type: z.literal('truncated'), sequence: z.number().int().nonnegative().safe() }).strict();
/** Bounded replay entries. */
const outputSchema = z.array(z.discriminatedUnion('type', [dataSchema, gapSchema]));
/** Validated operator response; never a saved transcript. */
export const terminalPageSchema = z
  .object({
    session: terminalSessionSchema,
    output: outputSchema,
    nextCursor: z.number().int().nonnegative().safe(),
    unavailable: z.boolean(),
  })
  .strict();
/** Validated replay envelope. */
export type TerminalPage = z.output<typeof terminalPageSchema>;

/** Per-project transient replay, never persisted across restart. */
export class TerminalReads {
  /** Project metadata authority. */
  private readonly sessions: TerminalSessions;
  /** Bounded live/finished buffer set. */
  private readonly buffers = new Map<string, { buffer: TerminalBuffer; active: boolean }>();
  /** Pending HTTP readers, bounded independently of output volume. */
  private readonly readers = new Map<string, Set<() => void>>();

  /**
   * Bind replay permanently to one project's ledger.
   *
   * @param sessions - Authoritative project-fenced metadata.
   */
  public constructor(sessions: TerminalSessions) {
    this.sessions = sessions;
  }

  /**
   * Register an admitted session; reads never create processes.
   *
   * @param id - Owned terminal identity.
   * @param buffer - Its redacted bounded buffer.
   */
  public attach(id: string, buffer: TerminalBuffer): void {
    this.buffers.set(id, { buffer, active: true });
  }

  /**
   * Wake readers after safe output or metadata changes.
   *
   * @param id - Owned session identity.
   */
  public notify(id: string): void {
    const readers = this.readers.get(id);
    if (readers === undefined) {
      return;
    }
    for (const wake of readers) {
      wake();
    }
  }

  /**
   * Retain bounded final replay and evict oldest closed buffers.
   *
   * @param id - Settled owned session.
   */
  public finish(id: string): void {
    const entry = this.buffers.get(id);
    if (entry !== undefined) {
      entry.active = false;
    }
    const finished = [...this.buffers].filter(([, item]) => !item.active);
    const evicted = finished.slice(0, Math.max(0, finished.length - RETAINED));
    for (const [old] of evicted) {
      this.buffers.delete(old);
    }
    this.notify(id);
  }

  /**
   * Read redacted output, optionally waiting without polling a model.
   *
   * @param id - Project terminal identity.
   * @param after - Last received sequence.
   * @param waitMs - Validated bounded wait.
   * @param signal - Owned HTTP request cancellation.
   * @returns Metadata and a resumable transient page.
   * @throws {MeshError} For foreign sessions or too many readers.
   */
  public async read(id: string, after: number, waitMs: number, signal?: AbortSignal): Promise<TerminalPage> {
    const initial = this.page(id, after);
    if (waitMs === 0 || initial.output.length > 0 || this.buffers.get(id)?.active !== true) {
      return initial;
    }
    const readers = this.readers.get(id) ?? new Set<() => void>();
    if (readers.size >= SUBSCRIBERS) {
      throw new MeshError('FACTORY_GATED', 'Terminal subscriber cap reached.');
    }
    this.readers.set(id, readers);
    const pending = Promise.withResolvers<undefined>();
    const wake = (): void => {
      pending.resolve(undefined);
    };
    const timer = setTimeout(wake, waitMs);
    readers.add(wake);
    signal?.addEventListener('abort', wake, { once: true });
    if (signal?.aborted === true) {
      wake();
    }
    try {
      await pending.promise;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', wake);
      readers.delete(wake);
      if (readers.size === 0) {
        this.readers.delete(id);
      }
    }
    if (signal?.aborted === true) {
      throw new MeshError('WAIT_CANCELLED', 'Terminal read cancelled.');
    }
    return this.page(id, after);
  }

  /**
   * Copy a bounded page with an explicit unavailable/gap signal.
   *
   * @param id - Project-fenced terminal.
   * @param after - Last received cursor.
   * @returns Safe replay page.
   * @throws {MeshError} If the identity belongs to another project or is absent.
   */
  private page(id: string, after: number): TerminalPage {
    const session = this.sessions.get(id);
    if (session === null) {
      throw new MeshError('NOT_FOUND', 'Terminal session not found in this project.');
    }
    const buffer = this.buffers.get(id)?.buffer;
    const output: TerminalOutput[] = [];
    let bytes = 0;
    let nextCursor = after;
    const chunks = buffer === undefined ? [] : buffer.readAfter(after, { bytes: PAGE_BYTES, entries: PAGE_ENTRIES });
    for (const chunk of chunks) {
      const size = chunk.type === 'data' ? Buffer.byteLength(chunk.text) : 0;
      if (output.length >= PAGE_ENTRIES || bytes + size > PAGE_BYTES) {
        break;
      }
      output.push(chunk);
      bytes += size;
      nextCursor = Math.max(nextCursor, chunk.sequence);
    }
    return { session, output, nextCursor, unavailable: buffer === undefined };
  }
}
