/**
 * Bounded, project-fenced Activity state, independent of the DOM and stream cursor.
 *
 * @file
 */
import type { Data } from './api.js';

/** Maximum retained live observations. */
const LIVE_LIMIT = 200;
/** Keep only one older page, never an accumulating transcript. */
export const HISTORY_PAGE_LIMIT = 50;
/** Scope survives asynchronous work without accepting A-to-B-to-A results. */
export interface HistoryScope {
  /** Public project identity. */
  readonly project: string;
  /** Monotonic selection revision. */
  readonly generation: number;
}
/** Validated backward page. */
interface Page {
  /** Strictly ascending immutable event identities. */
  readonly events: Data[];
  /** Actual server lookahead. */
  readonly hasMore: boolean;
  /** Exclusive cursor for the next page. */
  readonly oldestCursor: number;
}
/** Read-only state for rendering; contains no persistent browser data. */
export interface HistoryView {
  /** Current live window only, suitable for other views. */
  readonly recent: Data[];
  /** Current Activity page. */
  readonly visible: Data[];
  /** Whether older Activity is selected. */
  readonly isOlder: boolean;
  /** One read is in progress. */
  readonly isLoading: boolean;
  /** Server-confirmed older availability, unknown before the first request. */
  readonly hasMore: boolean | null;
  /** Retryable current-project error. */
  readonly error: string | null;
}
/** Injectable native HTTP boundary. */
export type HistoryReader = (project: string, before: number, limit: number) => Promise<unknown>;

/**
 * Validate event identities before any retained state changes.
 *
 * @param value - Untrusted collection.
 * @param limit - Maximum accepted collection size.
 * @returns Ascending, duplicate-free records.
 * @throws {TypeError} For invalid records, identities or order.
 */
function events(value: unknown, limit: number): Data[] {
  if (!Array.isArray(value) || value.length > limit) {
    throw new TypeError('Invalid Activity event collection.');
  }
  let previous = 0;
  return value.map((raw: unknown) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new TypeError('Invalid Activity event.');
    }
    const record: Data = Object.fromEntries(Object.entries(raw));
    const sequence = record['seq'];
    if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence <= previous) {
      throw new TypeError('Invalid Activity sequence or ordering.');
    }
    previous = sequence;
    return record;
  });
}

/**
 * Decode a page without trusting server cursors or coercing boolean fields.
 *
 * @param value - Untrusted HTTP response.
 * @param scope - Captured request project.
 * @param before - Exclusive requested boundary.
 * @returns Fully validated page.
 * @throws {TypeError} For malformed or nonprogressing pages.
 */
function page(value: unknown, scope: HistoryScope, before: number): Page {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Invalid Activity history response.');
  }
  const record = new Map<string, unknown>(Object.entries(value));
  const entries = events(record.get('events'), HISTORY_PAGE_LIMIT);
  const cursor = record.get('oldestCursor');
  const hasMore = record.get('hasMore');
  if (
    typeof hasMore !== 'boolean' ||
    typeof cursor !== 'number' ||
    !Number.isSafeInteger(cursor) ||
    cursor < 0 ||
    cursor !== (entries[0]?.['seq'] ?? before) ||
    entries.some((event) => Number(event['seq']) >= before) ||
    (hasMore && entries.length === 0) ||
    record.get('project') !== scope.project
  ) {
    throw new TypeError('Invalid Activity history cursor or project.');
  }
  return { events: entries, oldestCursor: cursor, hasMore };
}

/** One retained live window and at most one replaceable older page. */
export class ActivityHistory {
  /** Current public project. */
  private project = 'home';
  /** Selection generation fences reconnects and late finalizers. */
  private generation = 0;
  /** Bounded recent events; never includes fetched older pages. */
  private recent: Data[] = [];
  /** Only the currently displayed older page. */
  private older: Page | null = null;
  /** Exact currently owned request; null also invalidates a returning request. */
  private pending: HistoryScope | null = null;
  /** Last current-scope request failure. */
  private error: string | null = null;

  /**
   * Capture the current asynchronous authority.
   *
   * @returns Public project and monotonic generation.
   */
  public scope(): HistoryScope {
    return { project: this.project, generation: this.generation };
  }

  /**
   * Reject old observations even after returning to the same project.
   *
   * @param scope - Previously captured authority.
   * @returns Whether both identity and generation still match.
   */
  public isCurrent(scope: HistoryScope): boolean {
    return scope.project === this.project && scope.generation === this.generation;
  }

  /**
   * Reset immediately when selection changes, before a network response arrives.
   *
   * @param project - Newly selected public ID.
   */
  public select(project: string): void {
    if (project === this.project) {
      return;
    }
    this.project = project;
    this.reset();
  }

  /** Clear private browser memory and invalidate returning reads, including on logout. */
  public reset(): void {
    this.generation += 1;
    this.recent = [];
    this.returnRecent();
  }

  /**
   * Merge valid live frames without disturbing history or its backward cursor.
   *
   * @param value - Current-project snapshot events.
   * @throws {TypeError} For malformed events before changing state.
   */
  public observe(value: unknown): void {
    const incoming = events(value, LIVE_LIMIT);
    const merged = new Map([...this.recent, ...incoming].map((event) => [Number(event['seq']), event]));
    this.recent = merged
      .entries()
      .toArray()
      .toSorted(([left], [right]) => left - right)
      .slice(-LIVE_LIMIT)
      .map(([, event]) => event);
  }

  /**
   * Read one page, preserving the old page/cursor on failure and rejecting late results.
   *
   * @param read - Validated local read transport; no mutation or stream cursor.
   */
  public async load(read: HistoryReader): Promise<void> {
    const before = this.older?.oldestCursor ?? Number(this.recent[0]?.['seq'] ?? 0);
    if (before === 0 || this.pending !== null || this.older?.hasMore === false) {
      return;
    }
    const scope = this.scope();
    this.pending = scope;
    this.error = null;
    try {
      const value = await read(scope.project, before, HISTORY_PAGE_LIMIT);
      if (this.pending === scope) {
        this.older = page(value, scope, before);
      }
    } catch (error) {
      if (this.pending === scope) {
        this.error = error instanceof Error ? error.message : 'Activity history could not be read.';
      }
    } finally {
      if (this.pending === scope) {
        this.pending = null;
      }
    }
  }

  /** Return to current observations without allowing a pending page to reselect history. */
  public returnRecent(): void {
    this.older = null;
    this.pending = null;
    this.error = null;
  }

  /**
   * Expose display state without mixing history into other views.
   *
   * @returns Current bounded Activity view.
   */
  public view(): HistoryView {
    return {
      recent: [...this.recent],
      visible: [...(this.older?.events ?? this.recent)],
      isOlder: this.older !== null,
      isLoading: this.pending !== null,
      hasMore: this.older?.hasMore ?? null,
      error: this.error,
    };
  }
}
