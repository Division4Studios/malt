/** @file Project-fenced, metadata-only terminal session persistence. */
import { z } from 'zod/v3';

import { run, selectAll, selectOne } from '../database.ts';
import { MeshError } from '../protocol.ts';

import { MAX_COLUMNS, MAX_ROWS, MIN_COLUMNS, MIN_ROWS } from './terminal-frames.ts';

import type { Store } from '../store.ts';

/** Bounded filesystem metadata, never terminal content. */
const PATH_LIMIT = 4096;
/** Bounded diagnostic category, never raw exception/output text. */
const REASON_LIMIT = 200;
/** All durable terminal lifecycle states. */
const STATES = ['requested', 'starting', 'running', 'closing', 'exited', 'failed', 'cancelled', 'timed_out'] as const;
/** Session states which need recovery after the owning broker stops. */
const ACTIVE: ReadonlySet<string> = new Set(['requested', 'starting', 'running', 'closing']);
/** Metadata schema doubles as the SQL row boundary. Strictness rejects content fields. */
export const terminalSessionSchema = z
  .object({
    id: z.string().uuid(),
    project: z.string().min(1),
    provider: z.enum(['codex', 'claude']),
    worktree: z.string().min(1).max(PATH_LIMIT),
    branch: z.string().min(1).max(REASON_LIMIT),
    base: z.string().regex(/^(?:[\da-f]{40}|[\da-f]{64})$/v),
    baseBranch: z.string().min(1).max(REASON_LIMIT),
    state: z.enum(STATES),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    columns: z.number().int().min(MIN_COLUMNS).max(MAX_COLUMNS),
    rows: z.number().int().min(MIN_ROWS).max(MAX_ROWS),
    inputBytes: z.number().int().nonnegative().safe(),
    outputBytes: z.number().int().nonnegative().safe(),
    exitCode: z.number().int().nullable(),
    reason: z.string().max(REASON_LIMIT),
  })
  .strict();
/** One validated metadata snapshot. */
export type TerminalSession = z.infer<typeof terminalSessionSchema>;
/** Legal transitions; terminal states cannot be reopened. */
const EDGES: Record<TerminalSession['state'], readonly TerminalSession['state'][]> = {
  requested: ['starting', 'failed', 'cancelled'],
  starting: ['running', 'closing', 'failed', 'cancelled', 'timed_out'],
  running: ['closing', 'exited', 'failed', 'cancelled', 'timed_out'],
  closing: ['exited', 'failed', 'cancelled', 'timed_out'],
  exited: [],
  failed: [],
  cancelled: [],
  timed_out: [],
};
/** Only explicitly allowed metadata fields can be updated. */
const patchSchema = terminalSessionSchema
  .pick({ columns: true, rows: true, inputBytes: true, outputBytes: true, exitCode: true, reason: true })
  .partial()
  .strict();
/** Columns are explicit: input, output and credentials have nowhere to persist. */
const COLUMNS =
  'id, project, provider, worktree, branch, base, baseBranch, state, createdAt, updatedAt, columns, rows, inputBytes, outputBytes, exitCode, reason';

/** A ledger instance is permanently bound to the verified store identity. */
export class TerminalSessions {
  /** Transaction owner. */
  private readonly store: Store;
  /** Verified identity, never accepted from an API caller. */
  private readonly project: string;

  /**
   * Add the metadata table without changing existing tables or rows.
   *
   * @param store - Initialized project store.
   */
  public constructor(store: Store) {
    this.store = store;
    const identitySchema = z.object({ value: z.string().min(1) });
    const identity = selectOne(store.db, identitySchema, "SELECT value FROM metadata WHERE key = 'project_id'");
    this.project = identitySchema.parse(identity).value;
    store.db.exec(`CREATE TABLE IF NOT EXISTS terminal_sessions (
      id TEXT NOT NULL, project TEXT NOT NULL, provider TEXT NOT NULL,
      worktree TEXT NOT NULL, branch TEXT NOT NULL, base TEXT NOT NULL, baseBranch TEXT NOT NULL,
      state TEXT NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
      columns INTEGER NOT NULL, rows INTEGER NOT NULL, inputBytes INTEGER NOT NULL,
      outputBytes INTEGER NOT NULL, exitCode INTEGER, reason TEXT NOT NULL,
      PRIMARY KEY(project, id));`);
  }

  /**
   * Record an operator-requested session. Duplicate identities fail closed.
   *
   * @param input - Metadata without project authority or lifecycle fields.
   * @returns Created metadata.
   */
  public create(
    input: Pick<
      TerminalSession,
      'id' | 'provider' | 'worktree' | 'branch' | 'base' | 'baseBranch' | 'columns' | 'rows'
    >,
  ): TerminalSession {
    const record = terminalSessionSchema.parse({
      ...input,
      project: this.project,
      state: 'requested',
      createdAt: this.store.now(),
      updatedAt: this.store.now(),
      inputBytes: 0,
      outputBytes: 0,
      exitCode: null,
      reason: '',
    });
    this.store.transaction(() => {
      run(
        this.store.db,
        `INSERT INTO terminal_sessions (${COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ...Object.values(record),
      );
    });
    return record;
  }

  /**
   * Read only this project's session; foreign identities look absent.
   *
   * @param id - Session identity.
   * @returns Metadata or null.
   */
  public get(id: string): TerminalSession | null {
    return (
      selectOne(
        this.store.db,
        terminalSessionSchema,
        `SELECT ${COLUMNS} FROM terminal_sessions WHERE project = ? AND id = ?`,
        this.project,
        id,
      ) ?? null
    );
  }

  /**
   * Read a bounded page of recent metadata, without terminal content.
   *
   * @returns At most a hundred records, active sessions first, then recent history.
   */
  public list(): TerminalSession[] {
    return selectAll(
      this.store.db,
      terminalSessionSchema,
      `SELECT ${COLUMNS} FROM terminal_sessions WHERE project = ? ORDER BY state IN ('requested','starting','running','closing') DESC, createdAt DESC, id LIMIT 100`,
      this.project,
    );
  }

  /**
   * Compare state and update metadata atomically; late results cannot reopen it.
   *
   * @param id - Session identity.
   * @param expected - State observed by the owner.
   * @param next - Legal next state (or same state for counters/resize).
   * @param patch - Bounded metadata, never content.
   * @returns Committed metadata.
   */
  public change(
    id: string,
    expected: TerminalSession['state'],
    next: TerminalSession['state'],
    patch: z.input<typeof patchSchema> = {},
  ): TerminalSession {
    const update = patchSchema.parse(patch);
    return this.store.transaction(() => {
      const current = this.get(id);
      if (
        current?.state !== expected ||
        (next !== expected && !EDGES[expected].includes(next)) ||
        (next === expected && !ACTIVE.has(next))
      ) {
        throw new MeshError('FACTORY_GATED', 'Terminal session state changed or transition is not allowed.');
      }
      const record = terminalSessionSchema.parse({ ...current, ...update, state: next, updatedAt: this.store.now() });
      if (record.inputBytes < current.inputBytes || record.outputBytes < current.outputBytes) {
        throw new MeshError('FACTORY_GATED', 'Terminal byte counters cannot decrease.');
      }
      run(
        this.store.db,
        'UPDATE terminal_sessions SET state=?, updatedAt=?, columns=?, rows=?, inputBytes=?, outputBytes=?, exitCode=?, reason=? WHERE project=? AND id=? AND state=?',
        record.state,
        record.updatedAt,
        record.columns,
        record.rows,
        record.inputBytes,
        record.outputBytes,
        record.exitCode,
        record.reason,
        this.project,
        id,
        expected,
      );
      return record;
    });
  }

  /**
   * Called once after broker ownership is acquired, never by metadata readers.
   *
   * @param owned - Current live identities which must not be mistaken for old rows.
   * @returns Number of orphaned rows recovered.
   */
  public recover(owned: ReadonlySet<string> = new Set()): number {
    return this.store.transaction(() => {
      const rows = selectAll(
        this.store.db,
        terminalSessionSchema,
        `SELECT ${COLUMNS} FROM terminal_sessions WHERE project=? AND state IN ('requested','starting','running','closing')`,
        this.project,
      );
      const orphaned = rows.filter((row) => !owned.has(row.id));
      for (const row of orphaned) {
        this.change(row.id, row.state, 'failed', { reason: 'broker restarted' });
      }
      return orphaned.length;
    });
  }
}
