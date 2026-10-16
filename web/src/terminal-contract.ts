/** @file Native browser validation for secret-free terminal metadata and replay. */
import { data } from './api.ts';

/** Exact durable terminal states. */
const STATES = ['requested', 'starting', 'running', 'closing', 'exited', 'failed', 'cancelled', 'timed_out'] as const;
/** Runtime vocabulary check accepts unknown strings without unsafe type assertions. */
const VALID_STATES: ReadonlySet<string> = new Set(STATES);
/** Active states are distinct from an open browser stream. */
const ACTIVE: ReadonlySet<string> = new Set(['requested', 'starting', 'running', 'closing']);
/** Bounded browser transport dimensions. */
const LIMIT = { columns: 500, rows: 200, path: 4096, reason: 200, entries: 128, bytes: 65_536, uuid: 36 } as const;
/** Metadata consumed by the operator UI, never a native launch descriptor. */
export interface TerminalView {
  /** Opaque project-fenced session identity. */
  readonly id: string;
  /** Verified configured provider selection. */
  readonly provider: 'codex' | 'claude';
  /** Actual backend lifecycle state. */
  readonly state: (typeof STATES)[number];
  /** Native columns. */
  readonly columns: number;
  /** Native rows. */
  readonly rows: number;
  /** Server-selected scratch location, displayed as plain text only. */
  readonly worktree: string;
  /** Fixed backend reason, not raw output. */
  readonly reason: string;
}
/** Bounded replay envelope. */
export interface TerminalPage {
  /** Current actual session metadata. */
  readonly session: TerminalView;
  /** Decoded/redacted terminal text or explicit replay gap. */
  readonly output: readonly (
    { type: 'data'; sequence: number; text: string } | { type: 'truncated'; sequence: number }
  )[];
  /** Last fully delivered safe sequence. */
  readonly nextCursor: number;
  /** Metadata survived but transient output is no longer available. */
  readonly unavailable: boolean;
}

/**
 * Validate a nonnegative safe numeric boundary.
 *
 * @param value - Untrusted JSON field.
 * @param maximum - Ceiling for allocation/cursor use.
 * @returns Validated integer.
 * @throws {TypeError} For invalid input.
 */
function natural(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new TypeError('Invalid terminal number.');
  }
  return value;
}

/**
 * Validate a bounded string without coercing hostile objects.
 *
 * @param value - Untrusted JSON field.
 * @param maximum - Character ceiling.
 * @returns Literal validated text.
 * @throws {TypeError} For invalid input.
 */
function bounded(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || value.length > maximum) {
    throw new TypeError('Invalid terminal text.');
  }
  return value;
}

/**
 * Narrow the exact backend lifecycle vocabulary.
 *
 * @param value - Untrusted state text.
 * @returns Whether the state is recognized.
 */
function isState(value: string): value is TerminalView['state'] {
  return VALID_STATES.has(value);
}

/**
 * Validate terminal metadata before any view or stream association.
 *
 * @param value - Untrusted backend response.
 * @returns Bounded public metadata.
 * @throws {TypeError} For inconsistent identity or dimensions.
 */
export function terminalView(value: unknown): TerminalView {
  const record = data(value);
  const id = bounded(record['id'], LIMIT.uuid);
  const { provider } = record;
  const state = bounded(record['state'], LIMIT.reason);
  const columns = natural(record['columns'], LIMIT.columns);
  const rows = natural(record['rows'], LIMIT.rows);
  if (columns === 0 || rows === 0) {
    throw new TypeError('Invalid terminal dimensions.');
  }
  if (provider !== 'codex' && provider !== 'claude') {
    throw new TypeError('Invalid terminal provider.');
  }
  if (!isState(state) || !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iv.test(id)) {
    throw new TypeError('Invalid terminal identity/state.');
  }
  return {
    id,
    provider,
    state,
    columns,
    rows,
    worktree: bounded(record['worktree'], LIMIT.path),
    reason: bounded(record['reason'], LIMIT.reason),
  };
}

/**
 * Validate one bounded replay page and its monotonic cursor envelope.
 *
 * @param value - Untrusted decoded SSE payload.
 * @param expected - Captured owned session/cursor selection.
 * @returns Validated bounded replay page.
 * @throws {TypeError} For a foreign session, malformed data or cursor regression.
 */
export function terminalPage(value: unknown, expected: { id: string; after: number }): TerminalPage {
  const record = data(value);
  const session = terminalView(record['session']);
  const nextCursor = natural(record['nextCursor']);
  if (
    session.id !== expected.id ||
    nextCursor < expected.after ||
    typeof record['unavailable'] !== 'boolean' ||
    !Array.isArray(record['output']) ||
    record['output'].length > LIMIT.entries
  ) {
    throw new TypeError('Invalid terminal replay scope.');
  }
  let cursor = expected.after;
  let bytes = 0;
  let wasGap = false;
  const encoder = new TextEncoder();
  const output = record['output'].map((raw: unknown) => {
    const chunk = data(raw);
    const sequence = natural(chunk['sequence']);
    const isGap = chunk['type'] === 'truncated';
    if (
      sequence <= expected.after ||
      sequence < cursor ||
      sequence > nextCursor ||
      (sequence === cursor && (isGap || !wasGap))
    ) {
      throw new TypeError('Invalid terminal replay cursor.');
    }
    cursor = sequence;
    wasGap = isGap;
    if (isGap) {
      return { type: 'truncated' as const, sequence };
    }
    if (chunk['type'] !== 'data') {
      throw new TypeError('Invalid terminal output kind.');
    }
    const text = bounded(chunk['text'], LIMIT.bytes);
    bytes += encoder.encode(text).byteLength;
    if (bytes > LIMIT.bytes) {
      throw new TypeError('Terminal replay exceeds its byte ceiling.');
    }
    return { type: 'data' as const, sequence, text };
  });
  if (cursor !== nextCursor) {
    throw new TypeError('Terminal cursor skipped unreceived output.');
  }
  return { session, output, nextCursor, unavailable: record['unavailable'] };
}

/**
 * Determine whether replay can produce more live output.
 *
 * @param page - Validated replay envelope.
 * @returns Whether the session or its transient buffer has ended.
 */
export function hasTerminalEnded(page: TerminalPage): boolean {
  return page.unavailable || !ACTIVE.has(page.session.state);
}
