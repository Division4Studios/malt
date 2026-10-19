/**
 * A delivery's source diff for the console: the changed files of its exact
 * recorded head against the merge base with its recorded base, and one file's
 * unified patch on demand. Git runs with argument arrays only, the requested
 * path must be one the summary lists, private runtime and credential paths are
 * never shown, and output is bounded with explicit truncation.
 *
 * @file
 */
import { Buffer } from 'node:buffer';

import { SecretRedactor } from '../secrets.ts';

import { command, CommandFailureError } from './commands.ts';
import { DIFF_FILES_MAX, PATCH_BYTES_MAX, PATCH_LINES_MAX, deliveryDiffInputSchema } from './diff-schema.ts';
import { hasPrivatePath } from './source-reader.ts';

import type { FactoryContext } from './context.ts';
import type { DiffFileSummary, DiffPatch, DiffSummary } from './diff-schema.ts';
import type { FactoryTask } from './schema.ts';

/** Full Git object name. */
const COMMIT = /^(?:[\da-f]{40}|[\da-f]{64})$/v;
/** Mode of a side that does not exist. */
const NO_MODE = '000000';
/** Tokens a rename or copy occupies in `-z` output: header or counts, then both paths. */
const PAIR_TOKENS = 3;
/** Tokens any other change occupies: header, then its path. */
const SINGLE_TOKENS = 2;
/** Fields of a `--raw` header: two modes, two object names and the status. */
const RAW_FIELDS = 5;
/** Settings that keep diff output in the standard, parseable shape regardless of user configuration. */
const DIFF_OPTIONS = [
  '-c',
  'core.quotepath=true',
  'diff',
  '--no-color',
  '--no-ext-diff',
  '--no-textconv',
  '--src-prefix=a/',
  '--dst-prefix=b/',
  '-M',
] as const;
/** Status letters from `git diff --raw`. */
const STATUS_LETTERS: Readonly<Record<string, DiffFileSummary['status']>> = {
  A: 'added',
  D: 'deleted',
  M: 'modified',
  R: 'renamed',
  C: 'copied',
  T: 'type_changed',
};

/** The exact source pair a delivery's diff is read for. */
interface SourcePair {
  /** Recorded base. */
  readonly base: string;
  /** Recorded head. */
  readonly head: string;
  /** Repository directory that holds both commits. */
  readonly cwd: string;
}

/** One `--raw` entry before its line counts are joined. */
interface RawEntry {
  /** Change kind. */
  readonly status: DiffFileSummary['status'];
  /** Current path. */
  readonly path: string;
  /** Source path of a rename or copy. */
  readonly oldPath: string | null;
  /** Old octal mode. */
  readonly baseMode: string;
  /** New octal mode. */
  readonly headMode: string;
  /** Rename or copy similarity. */
  readonly similarity: number | null;
}

/**
 * Read a delivery's changed-file summary or one file's patch.
 *
 * @param context - Project Git boundary and ledger.
 * @param input - Untrusted `{ taskId, path? }`.
 * @returns Summary, patch, or the reason none is available.
 * @throws {MeshError} For an unknown delivery or a path the summary does not list.
 */
export async function deliveryDiff(context: FactoryContext, input: unknown): Promise<DiffSummary | DiffPatch> {
  const request = deliveryDiffInputSchema.parse(input);
  const task = context.repository.task(request.taskId);
  const source = await sourcePair(context, task);
  if (typeof source === 'string') {
    return { taskId: task.id, state: 'unavailable', reason: source };
  }
  const changed = await changedFiles(source);
  if (request.path === undefined) {
    return summary(task.id, source, changed);
  }
  const file = changed.find((candidate) => candidate.path === request.path && !isPrivate(candidate));
  if (file === undefined) {
    return {
      taskId: task.id,
      state: 'unavailable',
      reason: 'That path is not a changed public file of this delivery.',
    };
  }
  return patch(context, { taskId: task.id, source, file });
}

/**
 * Resolve the recorded head and base to commits present in the repository.
 *
 * @param context - Project Git boundary.
 * @param task - Delivery whose source is shown.
 * @returns Source pair, or the reason there is none yet.
 */
async function sourcePair(context: FactoryContext, task: FactoryTask): Promise<SourcePair | string> {
  if (task.head === null || task.base === null) {
    return 'This delivery has no published source yet.';
  }
  if (!COMMIT.test(task.head) || !COMMIT.test(task.base)) {
    return 'This delivery does not record exact source commits.';
  }
  // Owned worktrees share the repository's objects; a separate checkout is tried only as a fallback.
  const candidates = [context.mesh.root, ...(task.worktree === null ? [] : [task.worktree])];
  for (const cwd of candidates) {
    // eslint-disable-next-line no-await-in-loop -- The fallback directory is consulted only when the first lacks the commits.
    if (await hasCommits(cwd, [task.base, task.head])) {
      return { base: task.base, head: task.head, cwd };
    }
  }
  return 'The recorded source commits are not available locally. Fetch the delivery branch, then try again.';
}

/**
 * Whether every commit exists in a repository.
 *
 * @param cwd - Repository directory.
 * @param commits - Full object names.
 * @returns True when all of them are present commits.
 */
async function hasCommits(cwd: string, commits: readonly string[]): Promise<boolean> {
  try {
    const types = await Promise.all(commits.map(async (commit) => command('git', ['cat-file', '-t', commit], cwd)));
    return types.every((type) => type === 'commit');
  } catch {
    return false;
  }
}

/**
 * List every changed file with its kind, modes and line counts.
 *
 * @param source - Exact source pair.
 * @returns Changed files in Git order, including private ones.
 */
async function changedFiles(source: SourcePair): Promise<DiffFileSummary[]> {
  const output = await command(
    'git',
    [...DIFF_OPTIONS, '-z', '--raw', '--numstat', `${source.base}...${source.head}`, '--'],
    source.cwd,
    false,
  );
  const tokens = output.split('\0');
  const raw: RawEntry[] = [];
  const counts: { additions: number | null; deletions: number | null }[] = [];
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index] ?? '';
    if (token.startsWith(':')) {
      const entry = rawEntry(token, tokens, index);
      raw.push(entry.entry);
      index = entry.next;
    } else if (token.length === 0) {
      index += 1;
    } else {
      const { added, deleted, path } = numstatEntry(token);
      counts.push({ additions: count(added), deletions: count(deleted) });
      // A rename's numstat names both paths in the following tokens.
      index += path.length === 0 ? PAIR_TOKENS : 1;
    }
  }
  return raw.map((entry, position) => {
    const lines = counts[position] ?? { additions: null, deletions: null };
    return { ...entry, ...lines, isBinary: lines.additions === null };
  });
}

/**
 * Decode one `--raw -z` entry.
 *
 * @param header - `:oldmode newmode oldsha newsha status` token.
 * @param tokens - All output tokens.
 * @param index - Position of the header.
 * @returns The entry and the position after its paths.
 */
function rawEntry(header: string, tokens: readonly string[], index: number): { entry: RawEntry; next: number } {
  const fields = header.slice(1).split(' ', RAW_FIELDS);
  const baseMode = fields[0] ?? NO_MODE;
  const headMode = fields[1] ?? NO_MODE;
  const code = fields.at(-1) ?? 'M';
  const letter = code.slice(0, 1);
  const status = STATUS_LETTERS[letter] ?? 'modified';
  const isPair = letter === 'R' || letter === 'C';
  const first = tokens[index + 1] ?? '';
  const second = isPair ? (tokens[index + 2] ?? '') : null;
  const digits = code.slice(1);
  const score = digits.length === 0 ? NaN : Math.trunc(Number(digits));
  return {
    entry: {
      status,
      path: second ?? first,
      oldPath: isPair ? first : null,
      baseMode,
      headMode,
      similarity: isPair && Number.isSafeInteger(score) ? score : null,
    },
    next: index + (isPair ? PAIR_TOKENS : SINGLE_TOKENS),
  };
}

/**
 * Split a `--numstat -z` entry at its first two tabs only, so a path that
 * itself starts with or contains a tab is kept whole.
 *
 * @param token - `added<TAB>deleted<TAB>path` token; the path is empty for a rename.
 * @returns Both counts as text and the path.
 */
export function numstatEntry(token: string): { added: string; deleted: string; path: string } {
  const first = token.indexOf('\t');
  const second = first === -1 ? -1 : token.indexOf('\t', first + 1);
  return second === -1
    ? { added: '-', deleted: '-', path: '' }
    : { added: token.slice(0, first), deleted: token.slice(first + 1, second), path: token.slice(second + 1) };
}

/**
 * Parse a numstat count; `-` marks binary content.
 *
 * @param value - Count text.
 * @returns Count, or null for binary content.
 */
function count(value: string): number | null {
  const parsed = Number(value);
  return value === '-' || !Number.isSafeInteger(parsed) ? null : parsed;
}

/**
 * Whether a change touches a private runtime or credential path.
 *
 * @param file - Changed file.
 * @returns True when either side is private.
 */
function isPrivate(file: DiffFileSummary): boolean {
  return hasPrivatePath(file.path) || (file.oldPath !== null && hasPrivatePath(file.oldPath));
}

/**
 * Build the bounded public summary.
 *
 * @param taskId - Delivery id.
 * @param source - Exact source pair.
 * @param changed - Every changed file.
 * @returns Summary listing at most {@link DIFF_FILES_MAX} public files.
 */
function summary(taskId: string, source: SourcePair, changed: readonly DiffFileSummary[]): DiffSummary {
  const files = changed.filter((file) => !isPrivate(file));
  return {
    taskId,
    state: 'ready',
    base: source.base,
    head: source.head,
    files: files.slice(0, DIFF_FILES_MAX),
    totals: {
      files: files.length,
      additions: files.reduce((total, file) => total + (file.additions ?? 0), 0),
      deletions: files.reduce((total, file) => total + (file.deletions ?? 0), 0),
    },
    privateChanges: changed.length - files.length,
    isTruncated: files.length > DIFF_FILES_MAX,
  };
}

/**
 * Generate one listed file's patch, bounded and redacted.
 *
 * @param context - Project credentials to redact.
 * @param request - Delivery, source pair and the listed file.
 * @param request.taskId - Delivery id.
 * @param request.source - Exact source pair.
 * @param request.file - Listed public file.
 * @returns Patch text cut at a line boundary when it exceeds {@link PATCH_BYTES_MAX}.
 */
async function patch(
  context: FactoryContext,
  request: { taskId: string; source: SourcePair; file: DiffFileSummary },
): Promise<DiffPatch> {
  const { taskId, source, file } = request;
  const base = { taskId, state: 'ready', base: source.base, head: source.head, path: file.path } as const;
  if ((file.additions ?? 0) + (file.deletions ?? 0) > PATCH_LINES_MAX) {
    return { ...base, patch: '', isTruncated: true, bytes: null };
  }
  const sides = [file.oldPath, file.path].filter((value) => value !== null);
  // A literal pathspec also selects everything beneath a directory of the same name (a renamed-away file
  // replaced by a directory), which may hold private files; exclude those so only this file pair is read.
  const paths = [...sides.map((value) => `:(literal)${value}`), ...sides.map((value) => `:(exclude,literal)${value}/`)];
  let text: string;
  try {
    text = await command(
      'git',
      [...DIFF_OPTIONS, '--patch', `${source.base}...${source.head}`, '--', ...paths],
      source.cwd,
      false,
    );
  } catch (error) {
    if (error instanceof CommandFailureError) {
      // The output exceeded the command buffer; report it as too large rather than failing the view.
      return { ...base, patch: '', isTruncated: true, bytes: null };
    }
    throw error;
  }
  const redactor = new SecretRedactor([context.mesh.token]);
  const safe = Buffer.from(redactor.redact(text));
  if (safe.length <= PATCH_BYTES_MAX) {
    return { ...base, patch: safe.toString('utf8'), isTruncated: false, bytes: safe.length };
  }
  const cut = safe.lastIndexOf('\n', PATCH_BYTES_MAX - 1);
  return {
    ...base,
    patch: safe.subarray(0, cut === -1 ? 0 : cut + 1).toString('utf8'),
    isTruncated: true,
    bytes: safe.length,
  };
}
