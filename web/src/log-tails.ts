/**
 * Bounded read-only tails of owned worker artifacts, fetched by byte cursor.
 * Captured output stays in memory only and is rendered through textContent.
 *
 * @file
 */
import { data, request, scoped, text } from './api.js';

/** Captured output histories retained in memory only. */
const MAX_LOGS = 8;
/** Bounded read-only stdout cache, never persisted in browser storage. */
const LOG_LIMIT = 20_000;

/** Owned job artifact selection. */
export interface LogEntry {
  /** Owned job identity. */
  readonly id: string;
  /** Allowlisted artifact name. */
  readonly file: string;
}

/** In-memory artifact tails with single-flight cursor reads. */
export class LogTails {
  /** Rendered tails keyed by job and artifact. */
  public readonly logs = new Map<string, string>();
  /** Durable byte cursor per captured output. */
  private readonly cursors = new Map<string, number>();
  /** Prevent overlapping reads from duplicating a captured output chunk. */
  private readonly pending = new Set<string>();

  /** Forget every tail, for project changes and sign-out. */
  public clear(): void {
    this.logs.clear();
    this.cursors.clear();
  }

  /**
   * Read the selected artifacts, then keep only the most recent tails.
   *
   * @param projectId - Scope captured before the reads.
   * @param entries - Owned artifacts to read.
   * @param isCurrent - Whether the scope is still selected.
   */
  public async readAll(projectId: string, entries: readonly LogEntry[], isCurrent: () => boolean): Promise<void> {
    await Promise.all(entries.map(async (entry) => this.read(projectId, entry, isCurrent)));
    const oldest = this.logs
      .keys()
      .toArray()
      .slice(0, Math.max(0, this.logs.size - MAX_LOGS));
    for (const first of oldest) {
      this.logs.delete(first);
      this.cursors.delete(first);
    }
  }

  /**
   * Fetch one owned log tail with a single-flight cursor and a project fence.
   *
   * @param projectId - Scope captured before the read.
   * @param entry - Actual owned job identity and allowlisted artifact.
   * @param isCurrent - Whether the scope is still selected.
   */
  private async read(projectId: string, entry: LogEntry, isCurrent: () => boolean): Promise<void> {
    const artifactKey = `${entry.id}:${entry.file}`;
    const key = `${projectId}:${artifactKey}`;
    if (this.pending.has(key)) {
      return;
    }
    this.pending.add(key);
    const after = entry.file.endsWith('.log') ? (this.cursors.get(artifactKey) ?? 0) : 0;
    const route = `${scoped(projectId, '/api/artifact')}&job=${encodeURIComponent(entry.id)}&file=${encodeURIComponent(entry.file)}&after=${String(after)}`;
    try {
      const response = await request(route);
      if (isCurrent()) {
        this.apply(artifactKey, data(response));
      }
    } catch {
      /* A log may not yet exist; the last observed tail remains available. */
    } finally {
      this.pending.delete(key);
    }
  }

  /**
   * Apply actual captured output once, rendering project text through textContent.
   *
   * @param id - Owned job and allowlisted artifact cache key.
   * @param value - Validated log response.
   * @throws {TypeError} When the captured output cursor is invalid.
   */
  private apply(id: string, value: ReturnType<typeof data>): void {
    const cursor = value['nextCursor'];
    if (typeof cursor !== 'number' || !Number.isSafeInteger(cursor) || cursor < 0) {
      throw new TypeError('Invalid captured output cursor.');
    }
    this.cursors.set(id, cursor);
    const file = text(value, 'file');
    const prior = file.endsWith('.log') ? (this.logs.get(id) ?? '') : '';
    const tail = `${prior}${text(value, 'text')}`.slice(-LOG_LIMIT);
    this.logs.set(id, tail);
    for (const pre of document.querySelectorAll<HTMLPreElement>('pre[data-job]')) {
      if (`${pre.dataset['job'] ?? ''}:${pre.dataset['file'] ?? ''}` === id) {
        pre.textContent = tail === '' ? 'This artifact has not emitted data yet.' : tail;
      }
    }
  }
}
