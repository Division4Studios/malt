/**
 * Durable record of the persistent delivery manager: its session generations,
 * the operator conversation with explicit delivery states, batched role
 * reports and the decisions it asks the operator to make. Process handles are
 * memory-only; this ledger is what survives restarts. Every transition is
 * fenced by session generation, so a late event from a replaced process can
 * never acknowledge or answer a message in the current one.
 *
 * @file
 */
import { randomUUID } from 'node:crypto';

import { z } from 'zod/v3';

import { run, selectAll, selectOne } from '../database.ts';
import { MeshError } from '../protocol.ts';

import type { Store } from '../store.ts';

/** Longest stored message body. */
const BODY_MAX = 64_000;
/** Longest stored reason or note. */
const NOTE_MAX = 2000;
/** Default page size for conversation reads. */
const PAGE_DEFAULT = 100;
/** Largest conversation page. */
const PAGE_MAX = 500;

/** Lifecycle of one manager process generation. */
export const SESSION_STATES = ['starting', 'waiting', 'working', 'stopping', 'stopped', 'failed'] as const;
/** One lifecycle state. */
export type SessionState = (typeof SESSION_STATES)[number];
/** Who authored a conversation entry. */
export const AUTHORS = ['operator', 'manager', 'report', 'digest', 'system'] as const;
/** Conversation author. */
export type Author = (typeof AUTHORS)[number];
/** Delivery state of a conversation entry. */
export const MESSAGE_STATES = [
  'queued',
  'sent',
  'acknowledged',
  'answered',
  'failed',
  'pending',
  'delivered',
  'final',
] as const;
/** One delivery state. */
export type MessageState = (typeof MESSAGE_STATES)[number];

/** Stored session generation. */
const sessionSchema = z.object({
  generation: z.number().int().positive(),
  provider: z.enum(['claude', 'codex']),
  native_session: z.string().nullable(),
  model: z.string().nullable(),
  state: z.enum(SESSION_STATES),
  pid: z.number().int().nullable(),
  started_at: z.number(),
  updated_at: z.number(),
  ended_at: z.number().nullable(),
  reason: z.string().nullable(),
});
/** One manager session generation. */
export type ManagerSession = z.output<typeof sessionSchema>;
/** Stored conversation entry. */
const messageSchema = z.object({
  seq: z.number().int().positive(),
  id: z.string(),
  generation: z.number().int().nullable(),
  author: z.enum(AUTHORS),
  body: z.string(),
  state: z.enum(MESSAGE_STATES),
  reply_to: z.string().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
  note: z.string().nullable(),
});
/** One conversation entry. */
export type ManagerMessage = z.output<typeof messageSchema>;
/** Stored decision request. */
const decisionSchema = z.object({
  id: z.string(),
  question: z.string(),
  options: z.string(),
  evidence: z.string(),
  state: z.enum(['open', 'answered', 'withdrawn']),
  answer: z.string().nullable(),
  created_at: z.number(),
  answered_at: z.number().nullable(),
});
/** One decision the manager asked the operator to make. */
export interface ManagerDecision {
  /** Stable identity. */
  readonly id: string;
  /** Question for the operator. */
  readonly question: string;
  /** Offered answers; free text is always also accepted. */
  readonly options: readonly string[];
  /** Exact supporting evidence. */
  readonly evidence: string;
  /** Lifecycle. */
  readonly state: 'open' | 'answered' | 'withdrawn';
  /** Operator answer once given. */
  readonly answer: string | null;
  /** Creation time. */
  readonly createdAt: number;
  /** Answer time. */
  readonly answeredAt: number | null;
}
/** Cursor row. */
const cursorSchema = z.object({ value: z.number().int().nonnegative() });

/**
 * Bound stored text.
 *
 * @param text - Input text.
 * @param max - Maximum length.
 * @returns Bounded text.
 */
function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Durable manager state for one project. */
export class ManagerLedger {
  /** Project store and transaction boundary. */
  private readonly store: Store;

  /**
   * Create tables additively; existing project state is untouched.
   *
   * @param store - Selected project's store.
   */
  public constructor(store: Store) {
    this.store = store;
    store.db.exec(`CREATE TABLE IF NOT EXISTS factory_manager_sessions (
      generation INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, native_session TEXT, model TEXT,
      state TEXT NOT NULL, pid INTEGER, started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      ended_at INTEGER, reason TEXT);`);
    store.db.exec(`CREATE TABLE IF NOT EXISTS factory_manager_messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, generation INTEGER, author TEXT NOT NULL,
      body TEXT NOT NULL, state TEXT NOT NULL, reply_to TEXT, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, note TEXT);`);
    store.db.exec(`CREATE TABLE IF NOT EXISTS factory_manager_decisions (
      id TEXT PRIMARY KEY, question TEXT NOT NULL, options TEXT NOT NULL, evidence TEXT NOT NULL,
      state TEXT NOT NULL, answer TEXT, created_at INTEGER NOT NULL, answered_at INTEGER);`);
    store.db.exec('CREATE TABLE IF NOT EXISTS factory_manager_cursor (name TEXT PRIMARY KEY, value INTEGER NOT NULL);');
  }

  /**
   * Latest session generation, live or ended.
   *
   * @returns The newest generation, or null before the first start.
   */
  public current(): ManagerSession | null {
    return (
      selectOne(
        this.store.db,
        sessionSchema,
        'SELECT * FROM factory_manager_sessions ORDER BY generation DESC LIMIT 1',
      ) ?? null
    );
  }

  /**
   * Native session identity to resume, from the newest generation that reported one.
   *
   * @param provider - Provider that owns the native session.
   * @returns Native session identity, or null.
   */
  public resumable(provider: 'claude' | 'codex'): string | null {
    const row = selectOne(
      this.store.db,
      sessionSchema,
      'SELECT * FROM factory_manager_sessions WHERE provider=? AND native_session IS NOT NULL ORDER BY generation DESC LIMIT 1',
      provider,
    );
    return row?.native_session ?? null;
  }

  /**
   * Begin a new generation; any previous live generation must already be ended.
   *
   * @param provider - Provider family.
   * @param model - Requested model, if configured.
   * @returns The new generation.
   * @throws {MeshError} When a previous generation is still live.
   */
  public begin(provider: 'claude' | 'codex', model: string | null): ManagerSession {
    return this.store.transaction(() => {
      const previous = this.current();
      if (previous !== null && previous.ended_at === null) {
        throw new MeshError('FACTORY_GATED', 'End the current manager session before starting another.');
      }
      const now = this.store.now();
      run(
        this.store.db,
        'INSERT INTO factory_manager_sessions(provider,native_session,model,state,pid,started_at,updated_at,ended_at,reason) VALUES(?,?,?,?,?,?,?,?,?)',
        provider,
        null,
        model,
        'starting',
        null,
        now,
        now,
        null,
        null,
      );
      const created = this.current();
      if (created === null) {
        throw new MeshError('INTERNAL', 'The manager session was not recorded.');
      }
      this.store.event('FACTORY_MANAGER_SESSION', null, { generation: created.generation, state: 'starting' });
      return created;
    });
  }

  /**
   * Update a live generation; ended or replaced generations are never revived.
   *
   * @param generation - Fenced generation.
   * @param change - Fields to update.
   * @returns Whether the generation was live and updated.
   */
  public update(
    generation: number,
    change: { state?: SessionState; pid?: number; nativeSession?: string; model?: string; reason?: string },
  ): boolean {
    return this.store.transaction(() => {
      const current = this.current();
      if (current?.generation !== generation || current.ended_at !== null) {
        return false;
      }
      const state = change.state ?? current.state;
      const isEnded = state === 'stopped' || state === 'failed';
      const now = this.store.now();
      run(
        this.store.db,
        'UPDATE factory_manager_sessions SET state=?,pid=?,native_session=?,model=?,updated_at=?,ended_at=?,reason=? WHERE generation=?',
        state,
        change.pid ?? current.pid,
        change.nativeSession ?? current.native_session,
        change.model ?? current.model,
        now,
        isEnded ? now : null,
        change.reason === undefined ? current.reason : clip(change.reason, NOTE_MAX),
        generation,
      );
      if (state !== current.state) {
        this.store.event('FACTORY_MANAGER_SESSION', null, { generation, state });
      }
      if (isEnded) {
        this.settleUnfinished(
          generation,
          state === 'failed' ? 'The manager process ended before replying.' : undefined,
        );
      }
      return true;
    });
  }

  /**
   * After a broker restart no process survives: end any generation still marked live.
   *
   * @returns The generation that was ended, if any.
   */
  public recoverAfterRestart(): number | null {
    const current = this.current();
    if (current?.ended_at !== null) {
      return null;
    }
    this.update(current.generation, {
      state: 'stopped',
      reason: 'The broker restarted; the manager process did not survive.',
    });
    return current.generation;
  }

  /**
   * Queue an operator message or digest for delivery.
   *
   * @param author - Operator or digest.
   * @param body - Text to deliver.
   * @returns The queued entry.
   */
  public enqueue(author: 'operator' | 'digest', body: string): ManagerMessage {
    return this.append(author, body, 'queued', null);
  }

  /**
   * Record a non-delivered entry: manager text, a pending report or a lifecycle note.
   *
   * @param author - Entry author.
   * @param body - Text.
   * @param replyTo - Message this answers, if known.
   * @returns The stored entry.
   */
  public record(author: 'manager' | 'report' | 'system', body: string, replyTo: string | null = null): ManagerMessage {
    return this.append(author, body, author === 'report' ? 'pending' : 'final', replyTo);
  }

  /**
   * Oldest message waiting for delivery.
   *
   * @returns The next queued entry, or null.
   */
  public nextQueued(): ManagerMessage | null {
    return (
      selectOne(
        this.store.db,
        messageSchema,
        "SELECT * FROM factory_manager_messages WHERE state='queued' ORDER BY seq LIMIT 1",
      ) ?? null
    );
  }

  /**
   * The message currently in flight in a generation, sent or acknowledged but unanswered.
   *
   * @param generation - Fenced generation.
   * @returns In-flight entry, or null.
   */
  public inFlight(generation: number): ManagerMessage | null {
    return (
      selectOne(
        this.store.db,
        messageSchema,
        "SELECT * FROM factory_manager_messages WHERE generation=? AND state IN ('sent','acknowledged') ORDER BY seq LIMIT 1",
        generation,
      ) ?? null
    );
  }

  /**
   * Move a message to a new delivery state within its generation.
   *
   * @param id - Message identity.
   * @param generation - Generation that must own the transition.
   * @param state - New state.
   * @param note - Optional explanation, for example a failure reason.
   * @returns Whether the transition applied.
   */
  public transition(id: string, generation: number, state: MessageState, note: string | null = null): boolean {
    return this.store.transaction(() => {
      const message = selectOne(this.store.db, messageSchema, 'SELECT * FROM factory_manager_messages WHERE id=?', id);
      if (message === undefined) {
        return false;
      }
      const isClaim = message.state === 'queued' && state === 'sent';
      if (!isClaim && message.generation !== generation) {
        return false;
      }
      const allowed: Record<string, readonly MessageState[]> = {
        queued: ['sent', 'failed'],
        sent: ['acknowledged', 'failed'],
        acknowledged: ['answered', 'failed'],
      };
      if (!(allowed[message.state] ?? []).includes(state)) {
        return false;
      }
      run(
        this.store.db,
        'UPDATE factory_manager_messages SET state=?,generation=?,updated_at=?,note=? WHERE id=?',
        state,
        generation,
        this.store.now(),
        note === null ? message.note : clip(note, NOTE_MAX),
        id,
      );
      this.store.event('FACTORY_MANAGER_MESSAGE', null, { id, state });
      return true;
    });
  }

  /**
   * Pending reports not yet delivered to the manager.
   *
   * @returns Pending report entries, oldest first.
   */
  public pendingReports(): ManagerMessage[] {
    return selectAll(
      this.store.db,
      messageSchema,
      "SELECT * FROM factory_manager_messages WHERE author='report' AND state='pending' ORDER BY seq",
    );
  }

  /**
   * Mark reports as included in a digest.
   *
   * @param ids - Report identities.
   * @param digest - Digest message that carries them.
   */
  public markDelivered(ids: readonly string[], digest: string): void {
    this.store.transaction(() => {
      for (const id of ids) {
        run(
          this.store.db,
          "UPDATE factory_manager_messages SET state='delivered',reply_to=?,updated_at=? WHERE id=? AND state='pending'",
          digest,
          this.store.now(),
          id,
        );
      }
    });
  }

  /**
   * Read a conversation page after a cursor.
   *
   * @param after - Exclusive sequence cursor.
   * @param limit - Requested page size.
   * @returns Entries in order.
   */
  public page(after = 0, limit = PAGE_DEFAULT): ManagerMessage[] {
    return selectAll(
      this.store.db,
      messageSchema,
      'SELECT * FROM factory_manager_messages WHERE seq>? ORDER BY seq LIMIT ?',
      after,
      Math.min(Math.max(1, limit), PAGE_MAX),
    );
  }

  /**
   * Most recent entries, oldest first, for context restore and previews.
   *
   * @param count - Number of entries.
   * @returns Recent entries.
   */
  public recent(count: number): ManagerMessage[] {
    return selectAll(
      this.store.db,
      messageSchema,
      'SELECT * FROM (SELECT * FROM factory_manager_messages ORDER BY seq DESC LIMIT ?) ORDER BY seq',
      count,
    );
  }

  /**
   * Highest conversation sequence.
   *
   * @returns Latest sequence, zero when empty.
   */
  public latestSeq(): number {
    return (
      selectOne(this.store.db, cursorSchema, 'SELECT COALESCE(MAX(seq),0) AS value FROM factory_manager_messages')
        ?.value ?? 0
    );
  }

  /**
   * Record a decision the manager needs from the operator.
   *
   * @param question - What the operator must decide, in plain words.
   * @param options - Offered answers.
   * @param evidence - Exact supporting evidence.
   * @returns The open decision.
   */
  public ask(question: string, options: readonly string[], evidence: string): ManagerDecision {
    const id = randomUUID();
    this.store.transaction(() => {
      run(
        this.store.db,
        'INSERT INTO factory_manager_decisions VALUES(?,?,?,?,?,?,?,?)',
        id,
        clip(question, NOTE_MAX),
        JSON.stringify(options.map((option) => clip(option, NOTE_MAX))),
        clip(evidence, BODY_MAX),
        'open',
        null,
        this.store.now(),
        null,
      );
      this.store.event('FACTORY_MANAGER_DECISION', null, { id, state: 'open' });
    });
    return this.decision(id);
  }

  /**
   * Answer an open decision exactly once.
   *
   * @param id - Decision identity.
   * @param answer - Operator answer.
   * @returns The answered decision.
   * @throws {MeshError} When the decision is unknown or no longer open.
   */
  public answer(id: string, answer: string): ManagerDecision {
    return this.store.transaction(() => {
      const current = this.decision(id);
      if (current.state !== 'open') {
        throw new MeshError('FACTORY_GATED', 'This decision was already answered or withdrawn.');
      }
      run(
        this.store.db,
        "UPDATE factory_manager_decisions SET state='answered',answer=?,answered_at=? WHERE id=?",
        clip(answer, NOTE_MAX),
        this.store.now(),
        id,
      );
      this.store.event('FACTORY_MANAGER_DECISION', null, { id, state: 'answered' });
      return this.decision(id);
    });
  }

  /**
   * All open decisions, oldest first.
   *
   * @returns Decisions still awaiting the operator.
   */
  public openDecisions(): ManagerDecision[] {
    return selectAll(
      this.store.db,
      decisionSchema,
      "SELECT * FROM factory_manager_decisions WHERE state='open' ORDER BY created_at",
    ).map((row) => this.toDecision(row));
  }

  /**
   * Read a named cursor.
   *
   * @param name - Stable cursor key, such as the event stream.
   * @returns Value, zero when unset.
   */
  public cursor(name: string): number {
    return (
      selectOne(this.store.db, cursorSchema, 'SELECT value FROM factory_manager_cursor WHERE name=?', name)?.value ?? 0
    );
  }

  /**
   * Advance a named cursor monotonically.
   *
   * @param name - Cursor name.
   * @param value - New value.
   */
  public advance(name: string, value: number): void {
    run(
      this.store.db,
      'INSERT INTO factory_manager_cursor VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value=MAX(value,excluded.value)',
      name,
      value,
    );
  }

  /**
   * Set a named marker to an exact value, for per-record report deduplication.
   *
   * @param name - Marker key.
   * @param value - New value.
   */
  public mark(name: string, value: number): void {
    run(
      this.store.db,
      'INSERT INTO factory_manager_cursor VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value',
      name,
      value,
    );
  }

  /**
   * Messages waiting for delivery.
   *
   * @returns Number of messages not yet sent.
   */
  public queuedCount(): number {
    return (
      selectOne(
        this.store.db,
        cursorSchema,
        "SELECT COUNT(*) AS value FROM factory_manager_messages WHERE state='queued'",
      )?.value ?? 0
    );
  }

  /**
   * Read one decision.
   *
   * @param id - Decision identity.
   * @returns The stored decision in public form.
   * @throws {MeshError} When unknown.
   */
  private decision(id: string): ManagerDecision {
    const row = selectOne(this.store.db, decisionSchema, 'SELECT * FROM factory_manager_decisions WHERE id=?', id);
    if (row === undefined) {
      throw new MeshError('NOT_FOUND', 'Unknown manager decision.');
    }
    return this.toDecision(row);
  }

  /**
   * Convert a stored decision row.
   *
   * @param row - Stored row.
   * @returns Public decision.
   */
  private toDecision(row: z.output<typeof decisionSchema>): ManagerDecision {
    const options: unknown = JSON.parse(row.options);
    return {
      id: row.id,
      question: row.question,
      options: Array.isArray(options) ? options.filter((option): option is string => typeof option === 'string') : [],
      evidence: row.evidence,
      state: row.state,
      answer: row.answer,
      createdAt: row.created_at,
      answeredAt: row.answered_at,
    };
  }

  /**
   * Append one conversation entry.
   *
   * @param author - Entry author.
   * @param body - Text.
   * @param state - Initial state.
   * @param replyTo - Related entry.
   * @returns Stored entry.
   * @throws {MeshError} When the insert could not be read back.
   */
  private append(author: Author, body: string, state: MessageState, replyTo: string | null): ManagerMessage {
    const id = randomUUID();
    const now = this.store.now();
    this.store.transaction(() => {
      run(
        this.store.db,
        'INSERT INTO factory_manager_messages(id,generation,author,body,state,reply_to,created_at,updated_at,note) VALUES(?,?,?,?,?,?,?,?,?)',
        id,
        null,
        author,
        clip(body, BODY_MAX),
        state,
        replyTo,
        now,
        now,
        null,
      );
      this.store.event('FACTORY_MANAGER_MESSAGE', null, { id, author, state });
    });
    const stored = selectOne(this.store.db, messageSchema, 'SELECT * FROM factory_manager_messages WHERE id=?', id);
    if (stored === undefined) {
      throw new MeshError('INTERNAL', 'The manager message was not recorded.');
    }
    return stored;
  }

  /**
   * Fail every message a generation left unfinished; nothing is resent automatically.
   *
   * @param generation - Ended generation.
   * @param note - Explanation recorded on each unfinished message.
   */
  private settleUnfinished(
    generation: number,
    note = 'The manager stopped before replying. Nothing is resent automatically; send it again if it still matters.',
  ): void {
    run(
      this.store.db,
      "UPDATE factory_manager_messages SET state='failed',updated_at=?,note=? WHERE generation=? AND state IN ('sent','acknowledged')",
      this.store.now(),
      note,
      generation,
    );
  }
}
