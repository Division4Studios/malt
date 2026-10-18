/**
 * Meaningful progress signals for assignment liveness. Only completed tool
 * and check calls, tracked edits, commits and explicit check-ins count.
 * Thinking, assistant prose, heartbeats, repeated identical output and raw
 * log growth do not. A provider that stops to wait for a permission or an
 * answer is reported as awaiting input, never as progressing.
 *
 * The provider stream is decoded incrementally with the same decoders the
 * transcript viewer uses. Reads are bounded per sample, partial lines are
 * carried to the next read, and oversized lines are skipped without being
 * held in memory.
 *
 * @file
 */
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod/v3';

import { selectAll } from '../database.ts';
import { hasErrorCode } from '../errors.ts';

import { LIVENESS_TEXT_MAX } from './liveness-schema.ts';
import { claudeLine, codexLine } from './transcript-events.ts';

import type { Store } from '../store.ts';
import type { ProgressObservation } from './liveness.ts';
import type { Provider } from './schema.ts';
import type { TranscriptSink } from './transcript-events.ts';
import type { FileHandle } from 'node:fs/promises';

/** Most stream bytes decoded in one sample. */
export const SAMPLE_BYTES_MAX = 4_194_304;
/** Longest stream line decoded; longer lines are skipped. */
export const LINE_BYTES_MAX = 1_048_576;
/** Most tool identities remembered for pairing and de-duplication. */
const TRACKED_MAX = 10_000;
/** Bytes read per file system call. */
const CHUNK_BYTES = 262_144;
/** Newline byte. */
const NEWLINE = 0x0a;
/** Longest wait for one Git fingerprint command. */
const GIT_TIMEOUT_MS = 15_000;
/** The supervisor's own start notice is not developer progress. */
const START_KEY = 'started';
/** One check-in key. */
const checkInSchema = z.object({ key: z.string() });

/**
 * Bound a signal label.
 *
 * @param text - Signal or wait description, possibly long.
 * @returns Label of at most the recorded length.
 */
function label(text: string): string {
  return text.length <= LIVENESS_TEXT_MAX ? text : `${text.slice(0, LIVENESS_TEXT_MAX - 1)}…`;
}

/**
 * Forget the oldest entry once a bounded map or set is full.
 *
 * @param collection - Insertion-ordered collection.
 */
function evict(collection: Map<string, unknown> | Set<string>): void {
  if (collection.size <= TRACKED_MAX) {
    return;
  }
  const oldest = collection.keys().next();
  if (oldest.done !== true) {
    collection.delete(oldest.value);
  }
}

/** Counts meaningful decoded events; transcript-only events are ignored. */
export class ProgressSink implements TranscriptSink {
  /** Meaningful events so far. */
  public meaningful = 0;
  /** Label of the newest meaningful event. */
  public lastSignal: string | null = null;
  /** What the provider currently waits on, if anything. */
  public awaiting: string | null = null;
  /** Open tool calls: identity to name and input digest. */
  private readonly tools = new Map<string, { name: string; input: string }>();
  /** Tool calls already completed, so duplicate completions count once. */
  private readonly closed = new Set<string>();
  /** Tool calls whose result is a wait for input, not progress. */
  private readonly waiting = new Set<string>();
  /** Digest of the previous completion, so repeated identical output counts once. */
  private previous = '';

  /**
   * Remember a tool call so its completion can be paired and de-duplicated.
   *
   * @param id - Provider call identity.
   * @param name - Tool identifier shown in the signal.
   * @param input - Untrusted arguments.
   */
  public openTool(id: string, name: string, input: unknown): void {
    if (this.tools.has(id)) {
      return;
    }
    this.tools.set(id, { name, input: JSON.stringify(input) });
    evict(this.tools);
  }

  /**
   * Count a completed tool or check call once.
   *
   * @param id - Provider call identity.
   * @param output - Result text.
   */
  public closeTool(id: string, output: string): void {
    if (this.closed.has(id) || this.waiting.has(id)) {
      return;
    }
    this.closed.add(id);
    evict(this.closed);
    const tool = this.tools.get(id);
    const name = tool?.name ?? 'tool';
    this.count(`tool ${name}`, `${name}\0${tool?.input ?? ''}\0${output}`);
  }

  /**
   * Count a provider-reported file change. The provider item identity keeps
   * consecutive patches to the same file distinct.
   *
   * @param changes - Changed paths.
   * @param id - Provider item identity.
   */
  public fileChange(changes: readonly { path: string; kind: string }[], id: string): void {
    const first = changes[0];
    if (first !== undefined) {
      this.count(`edit ${first.path}`, `edit\0${id}\0${JSON.stringify(changes)}`);
    }
  }

  /**
   * Record a wait for a permission or an answer.
   *
   * @param reason - What it waits on.
   * @param id - Waiting tool call, if any.
   */
  public awaitInput(reason: string, id: string | null): void {
    if (id !== null) {
      this.waiting.add(id);
      evict(this.waiting);
    }
    this.awaiting = label(reason);
  }

  /** Clear a wait once other progress shows the provider moved on. */
  public resume(): void {
    this.awaiting = null;
  }

  /** Assistant, thinking, result and status text is not progress. */
  public text(): void {
    // Prose and thinking never refresh liveness.
  }

  /** Edit intent is counted when its tool call completes, not when it starts. */
  public touch(): void {
    // Counted on completion.
  }

  /** Usage is accounting, not progress. */
  public addUsage(): void {
    // Not progress.
  }

  /** Final reports are accounting, not progress. */
  public report(): void {
    // Not progress.
  }

  /** Turn boundaries are not progress. */
  public addTurn(): void {
    // Not progress.
  }

  /** The model name is not progress. */
  public setModel(): void {
    // Not progress.
  }

  /** Malformed lines are not progress. */
  public countMalformed(): void {
    // Not progress.
  }

  /** Unknown events are not progress. */
  public countUnknown(): void {
    // Not progress.
  }

  /** Provider errors are not progress. */
  public markProviderError(): void {
    // Not progress.
  }

  /**
   * Count one meaningful event unless it repeats the previous one exactly.
   *
   * @param signal - Label shown to the operator.
   * @param identity - Content identity used to drop identical repeats.
   */
  private count(signal: string, identity: string): void {
    const digest = createHash('sha256').update(identity).digest('hex');
    if (digest === this.previous) {
      return;
    }
    this.previous = digest;
    this.meaningful += 1;
    this.lastSignal = label(signal);
    this.awaiting = null;
  }
}

/** Reads a growing log from where the previous read stopped, one bounded chunk at a time. */
export class StreamTail {
  /** Lines too long to decode, skipped so far. */
  public oversized = 0;
  /** Log file. */
  private readonly file: string;
  /** Receiver of complete lines. */
  private readonly onLine: (line: string) => void;
  /** Next byte to read. */
  private offset = 0;
  /** Bytes of an unfinished line. */
  private carry: Buffer[] = [];
  /** Length of `carry`. */
  private carried = 0;
  /** Whether the current line is being skipped for its size. */
  private isSkipping = false;

  /**
   * Prepare a tail of one log.
   *
   * @param file - Owned log path.
   * @param onLine - Receiver of complete lines.
   */
  public constructor(file: string, onLine: (line: string) => void) {
    this.file = file;
    this.onLine = onLine;
  }

  /**
   * Decode at most `SAMPLE_BYTES_MAX` new bytes.
   *
   * @returns Once the bounded read is applied; a missing log reads as empty.
   * @throws {Error} For file system failures other than a missing log.
   */
  public async poll(): Promise<void> {
    let handle;
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Only the attempt's fixed private stream file is read.
      handle = await open(this.file, 'r');
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) {
        return;
      }
      throw error;
    }
    try {
      await this.read(handle);
    } finally {
      await handle.close();
    }
  }

  /**
   * Read new bytes from an open log within the per-sample budget.
   *
   * @param handle - Open log.
   */
  private async read(handle: FileHandle): Promise<void> {
    const { size } = await handle.stat();
    if (size < this.offset) {
      this.reset();
    }
    const buffer = Buffer.alloc(CHUNK_BYTES);
    let budget = SAMPLE_BYTES_MAX;
    while (budget > 0 && this.offset < size) {
      // eslint-disable-next-line no-await-in-loop -- Each read continues from the previous one.
      const { bytesRead } = await handle.read(buffer, 0, Math.min(CHUNK_BYTES, budget), this.offset);
      if (bytesRead === 0) {
        break;
      }
      this.offset += bytesRead;
      budget -= bytesRead;
      this.feed(buffer.subarray(0, bytesRead));
    }
  }

  /**
   * Split bytes into lines, carrying an unfinished line to the next read.
   *
   * @param bytes - Newly read bytes.
   */
  private feed(bytes: Buffer): void {
    let start = 0;
    for (let end = bytes.indexOf(NEWLINE); end !== -1; end = bytes.indexOf(NEWLINE, start)) {
      this.append(bytes.subarray(start, end));
      if (!this.isSkipping) {
        this.onLine(Buffer.concat(this.carry, this.carried).toString('utf8'));
      }
      this.carry = [];
      this.carried = 0;
      this.isSkipping = false;
      start = end + 1;
    }
    this.append(bytes.subarray(start));
  }

  /**
   * Keep part of an unfinished line, or start skipping it once it is too long.
   *
   * @param part - Line bytes.
   */
  private append(part: Buffer): void {
    if (this.isSkipping || part.length === 0) {
      return;
    }
    if (this.carried + part.length > LINE_BYTES_MAX) {
      this.isSkipping = true;
      this.oversized += 1;
      this.carry = [];
      this.carried = 0;
      return;
    }
    this.carry.push(Buffer.from(part));
    this.carried += part.length;
  }

  /** Start over after the log was replaced. */
  private reset(): void {
    this.offset = 0;
    this.carry = [];
    this.carried = 0;
    this.isSkipping = false;
  }
}

/**
 * Digest one Git command's output without holding it in memory.
 *
 * @param cwd - Worktree.
 * @param args - Git arguments.
 * @returns Hex digest; empty when Git failed or timed out.
 */
async function gitDigest(cwd: string, args: readonly string[]): Promise<string> {
  return await new Promise((resolve) => {
    const hash = createHash('sha256');
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- Shell-free Git, like the workspace manager, against an owned worktree.
    const child = spawn('git', ['--no-optional-locks', '-C', cwd, ...args], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: GIT_TIMEOUT_MS,
    });
    child.stdout.on('data', (chunk: Buffer) => {
      hash.update(chunk);
    });
    child.once('error', () => {
      resolve('');
    });
    child.once('close', (code) => {
      resolve(code === 0 ? hash.digest('hex') : '');
    });
  });
}

/** A worktree's commit and tracked-content identity. */
export interface WorktreeFingerprint {
  /** Digest of HEAD. */
  readonly head: string;
  /** Digest of status and the tracked diff against HEAD. */
  readonly tree: string;
}

/**
 * Fingerprint a worktree's HEAD, status and tracked diff. Optional locks are
 * disabled so sampling never contends with the agent's own Git commands.
 *
 * @param cwd - Owned worktree.
 * @returns Commit and content digests.
 */
export async function worktreeFingerprint(cwd: string): Promise<WorktreeFingerprint> {
  const [head, status, diff] = await Promise.all([
    gitDigest(cwd, ['rev-parse', 'HEAD']),
    gitDigest(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    gitDigest(cwd, ['diff', 'HEAD', '--no-ext-diff', '--no-color', '--binary']),
  ]);
  return { head, tree: `${status}:${diff}` };
}

/**
 * Developer check-ins recorded for an attempt, excluding the supervisor's start notice.
 *
 * @param store - Project database.
 * @param jobId - Attempt identity.
 * @returns Count and newest key.
 */
export function checkIns(store: Store, jobId: string): { count: number; latest: string | null } {
  const rows = selectAll(
    store.db,
    checkInSchema,
    'SELECT key FROM factory_progress WHERE job_id=? AND key<>? ORDER BY rowid',
    jobId,
    START_KEY,
  );
  return { count: rows.length, latest: rows.at(-1)?.key ?? null };
}

/** Where a sampler reads one attempt's signals. */
export interface SamplerSource {
  /** Project database, for check-ins. */
  readonly store: Store;
  /** Attempt identity. */
  readonly jobId: string;
  /** Provider family, which selects the stream decoder. */
  readonly provider: Provider;
  /** Attempt artifact directory holding `stdout.log`. */
  readonly artifact: string;
  /** Owned worktree once known, for code-editing steps only. */
  readonly worktree: () => string | null;
}

/** Samples all of one attempt's progress signals. */
export class ProgressSampler {
  /** Signal sources. */
  private readonly source: SamplerSource;
  /** Meaningful-event counter. */
  private readonly sink = new ProgressSink();
  /** Incremental stream reader. */
  private readonly tail: StreamTail;
  /** Previous worktree fingerprint. */
  private fingerprint: WorktreeFingerprint | null = null;
  /** Previous check-in count. */
  private checkInCount = 0;

  /**
   * Prepare a sampler.
   *
   * @param source - Attempt signal sources.
   */
  public constructor(source: SamplerSource) {
    this.source = source;
    const decode = source.provider === 'claude' ? claudeLine : codexLine;
    this.tail = new StreamTail(path.join(source.artifact, 'stdout.log'), (line) => {
      decode(this.sink, line);
    });
  }

  /**
   * Observe what changed since the previous sample.
   *
   * @returns Newest meaningful signal, if any, and any wait for input.
   */
  public async sample(): Promise<ProgressObservation> {
    const signals: string[] = [];
    const log = await this.pollLog();
    if (log.signal !== null) {
      signals.push(log.signal);
    }
    const cwd = this.source.worktree();
    if (cwd !== null) {
      const next = await worktreeFingerprint(cwd);
      const previous = this.fingerprint;
      this.fingerprint = next;
      if (previous !== null && next.head !== '' && previous.head !== next.head) {
        signals.push('commit');
      } else if (previous !== null && next.tree !== previous.tree) {
        signals.push('tracked edit');
      }
    }
    const recorded = checkIns(this.source.store, this.source.jobId);
    if (recorded.count > this.checkInCount) {
      signals.push(`check-in ${recorded.latest ?? ''}`.trim());
    }
    this.checkInCount = recorded.count;
    const progress = signals.at(-1) ?? null;
    if (progress !== null && !log.isWaitRaised) {
      this.sink.resume();
    }
    return { progress: progress === null ? null : label(progress), awaiting: this.sink.awaiting };
  }

  /**
   * Decode new log lines. Decoded progress already clears a wait in stream
   * order, so a wait that is still set after new progress, or a new wait, was
   * raised later in this poll and must survive out-of-band progress.
   *
   * @returns The newest decoded signal, if any, and whether a wait was raised in this poll.
   */
  private async pollLog(): Promise<{ signal: string | null; isWaitRaised: boolean }> {
    const before = this.sink.meaningful;
    const waitBefore = this.sink.awaiting;
    await this.tail.poll();
    const hasProgress = this.sink.meaningful > before;
    return {
      signal: hasProgress ? this.sink.lastSignal : null,
      isWaitRaised: this.sink.awaiting !== null && (hasProgress || this.sink.awaiting !== waitBefore),
    };
  }
}
