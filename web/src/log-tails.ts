/**
 * Bounded tails of captured worker output. Each artifact is read by a byte
 * cursor so a refresh fetches only new output, reads are single-flight per
 * artifact, a project switch fences late responses, and only a few small
 * tails are kept in memory.
 *
 * @file
 */
import { data, request, scoped, text } from './api.js';

/** Most artifact tails kept in memory. */
const MAX_LOGS = 8;
/** Characters kept per tail. */
const LOG_LIMIT = 20_000;

/** One owned job artifact to read. */
export interface LogEntry {
  /** Owned job id. */
  readonly id: string;
  /** Allowlisted artifact file name. */
  readonly file: string;
}

/** Captured output tails for the worker view. */
export class LogTails {
  /** Tail text by `job:file`. */
  public readonly logs = new Map<string, string>();
  /** Next byte cursor by `job:file`. */
  private readonly cursors = new Map<string, number>();
  /** Reads in flight by `project:job:file`. */
  private readonly pending = new Set<string>();

  /**
   * Read new output for several artifacts, then drop the oldest tails.
   *
   * @param projectId - Project captured before the reads.
   * @param entries - Artifacts to read.
   * @param current - Reads the selected project, to discard late responses.
   */
  public async read(projectId: string, entries: readonly LogEntry[], current: () => string): Promise<void> {
    await Promise.all(entries.map(async (entry) => this.readOne(projectId, entry, current)));
    const oldest = this.logs
      .keys()
      .toArray()
      .slice(0, Math.max(0, this.logs.size - MAX_LOGS));
    for (const key of oldest) {
      this.logs.delete(key);
      this.cursors.delete(key);
    }
  }

  /** Forget every tail, after a project change or sign-out. */
  public clear(): void {
    this.logs.clear();
    this.cursors.clear();
  }

  /**
   * Fetch one owned log tail with a single-flight cursor and a project fence.
   *
   * @param projectId - Scope captured before the read.
   * @param entry - Actual owned job identity and allowlisted artifact.
   * @param current - Reads the selected project.
   */
  private async readOne(projectId: string, entry: LogEntry, current: () => string): Promise<void> {
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
      if (current() === projectId) {
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
