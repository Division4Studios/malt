/**
 * Unified Git diff parsing for local pull request review. Pure text handling
 * with no DOM access, so it can be verified directly.
 *
 * @file
 */

/** Leading fields of a hunk header: marker, old range, new range. */
const HUNK_FIELDS = 3;
/** Git extended header lines that describe a change even when it has no hunk. */
const METADATA_PREFIXES = [
  'new file mode ',
  'deleted file mode ',
  'old mode ',
  'new mode ',
  'similarity index ',
  'dissimilarity index ',
  'rename from ',
  'rename to ',
  'copy from ',
  'copy to ',
  'Binary files ',
  'GIT binary patch',
];
/** Octal escape digits in a Git C-quoted path. */
const OCTAL_DIGITS = 3;
/** Radix of Git's octal path escapes. */
const OCTAL = 8;
/** Single-character escapes in Git C-quoted paths. */
const ESCAPES: Readonly<Record<string, number>> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  '\\': 92,
};

/** One parsed file section of a unified diff. */
export interface DiffFile {
  /** Display path; a rename or copy shows `old → new`. */
  path: string;
  /** Extended header facts such as mode changes, renames and binary changes. */
  readonly notes: string[];
  /** Added line count. */
  added: number;
  /** Removed line count. */
  removed: number;
  /** Rendered rows. */
  readonly rows: DiffRow[];
}
/** One rendered diff row. */
export interface DiffRow {
  /** Row kind for styling. */
  readonly kind: 'add' | 'del' | 'ctx' | 'hunk';
  /** Old line number, empty for additions and hunks. */
  readonly old: string;
  /** New line number, empty for deletions and hunks. */
  readonly new: string;
  /** Line text without the diff marker. */
  readonly text: string;
}

/**
 * Parse a hunk header's starting line numbers.
 *
 * @param header - `@@ -a,b +c,d @@` line.
 * @returns Old and new starting lines.
 */
function hunkStart(header: string): { old: number; new: number } {
  const [, removed = '-0', added = '+0'] = header.split(' ', HUNK_FIELDS);
  return { old: rangeStart(removed), new: rangeStart(added) };
}

/**
 * Read the first line number of a hunk range such as `-12,5`.
 *
 * @param range - Signed range from a hunk header.
 * @returns Starting line, zero when unreadable.
 */
function rangeStart(range: string): number {
  const value = Number(range.slice(1).split(',', 1)[0]);
  return Number.isSafeInteger(value) ? value : 0;
}

/**
 * Decode one Git path token, which Git C-quotes when it holds special or non-ASCII bytes.
 *
 * @param token - Raw path token, quoted or not.
 * @returns Decoded path.
 */
export function gitPath(token: string): string {
  if (!token.startsWith('"') || !token.endsWith('"') || token.length < 2) {
    return token;
  }
  const bytes: number[] = [];
  const body = token.slice(1, -1);
  const encoder = new TextEncoder();
  for (let index = 0; index < body.length; index += 1) {
    const character = body.charAt(index);
    if (character !== '\\') {
      bytes.push(...encoder.encode(character));
      continue;
    }
    const next = body.charAt(index + 1);
    const octal = body.slice(index + 1, index + 1 + OCTAL_DIGITS);
    if (/^[0-7]{3}$/v.test(octal)) {
      bytes.push(Number.parseInt(octal, OCTAL));
      index += OCTAL_DIGITS;
    } else {
      bytes.push(ESCAPES[next] ?? next.codePointAt(0) ?? 0);
      index += 1;
    }
  }
  const decoder = new TextDecoder();
  return decoder.decode(new Uint8Array(bytes));
}

/**
 * Remove Git's `a/` or `b/` side prefix from a decoded path.
 *
 * @param value - Decoded path.
 * @returns Repository path.
 */
function unprefixed(value: string): string {
  return /^[ab]\//v.test(value) ? value.slice(2) : value;
}

/**
 * Read the path from a `diff --git` line. An unquoted unrenamed pair is split
 * by symmetry, so a path containing ` b/` still resolves correctly; a rename
 * is resolved later from its `rename to` or `+++` header.
 *
 * @param raw - `diff --git` line.
 * @returns Best display path until a more specific header is seen.
 */
function headerPath(raw: string): string {
  const rest = raw.slice('diff --git '.length);
  if (rest.startsWith('"')) {
    const end = rest.indexOf('" ', 1);
    return unprefixed(gitPath(end === -1 ? rest : rest.slice(0, end + 1)));
  }
  const length = (rest.length - ' b/'.length - 'a/'.length) / 2;
  if (Number.isSafeInteger(length) && length > 0) {
    const old = rest.slice('a/'.length, 'a/'.length + length);
    if (rest === `a/${old} b/${old}`) {
      return old;
    }
  }
  return unprefixed(rest.split(' ', 1)[0] ?? rest);
}

/**
 * Read the path from a `---` or `+++` line. Git ends the name with a tab when
 * it contains a space, so the tab is a delimiter, not part of the path.
 *
 * @param raw - Side header line.
 * @returns Raw path token.
 */
function sidePath(raw: string): string {
  const name = raw.slice('+++ '.length);
  return name.endsWith('\t') ? name.slice(0, -1) : name;
}

/**
 * Apply one extended header line to the file before its first hunk.
 *
 * @param file - File section being described.
 * @param raw - Header line.
 */
function applyHeader(file: DiffFile, raw: string): void {
  const target = file;
  const isMoved = target.notes.some((note) => note.startsWith('rename to ') || note.startsWith('copy to '));
  const isDeleted = target.notes.some((note) => note.startsWith('deleted file mode '));
  // The new side names the file, except after a rename or for a deletion, whose new side is /dev/null.
  const isNamingSide = (!isMoved && raw.startsWith('+++ ')) || (isDeleted && raw.startsWith('--- '));
  if (isNamingSide && sidePath(raw) !== '/dev/null') {
    target.path = unprefixed(gitPath(sidePath(raw)));
  }
  if (METADATA_PREFIXES.every((prefix) => !raw.startsWith(prefix))) {
    return;
  }
  if (raw.startsWith('rename to ') || raw.startsWith('copy to ')) {
    const from = target.notes.find((note) => note.startsWith('rename from ') || note.startsWith('copy from '));
    const source = from === undefined ? '' : gitPath(from.slice(from.indexOf(' from ') + ' from '.length));
    const destination = gitPath(raw.slice(raw.indexOf(' to ') + ' to '.length));
    target.path = source === '' ? destination : `${source} → ${destination}`;
  }
  target.notes.push(raw);
}

/**
 * Split a unified Git diff into files and numbered rows.
 *
 * @param diff - Unified diff text.
 * @returns Parsed files.
 */
export function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  let line = { old: 0, new: 0 };
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      current = { path: headerPath(raw), notes: [], added: 0, removed: 0, rows: [] };
      files.push(current);
    } else if (current !== null && raw.startsWith('@@')) {
      line = hunkStart(raw);
      current.rows.push({ kind: 'hunk', old: '', new: '', text: raw });
    } else if (current !== null && current.rows.length > 0) {
      appendRow(current, raw, line);
    } else if (current !== null) {
      applyHeader(current, raw);
    }
  }
  return files;
}

/**
 * Append one content row and advance line counters.
 *
 * @param file - File section receiving the row.
 * @param raw - Diff line.
 * @param line - Mutable line counters.
 */
function appendRow(file: DiffFile, raw: string, line: { old: number; new: number }): void {
  const counters = line;
  const target = file;
  if (raw.startsWith('+')) {
    target.added += 1;
    target.rows.push({ kind: 'add', old: '', new: String(counters.new), text: raw.slice(1) });
    counters.new += 1;
  } else if (raw.startsWith('-')) {
    target.removed += 1;
    target.rows.push({ kind: 'del', old: String(counters.old), new: '', text: raw.slice(1) });
    counters.old += 1;
  } else if (raw.startsWith(' ')) {
    target.rows.push({ kind: 'ctx', old: String(counters.old), new: String(counters.new), text: raw.slice(1) });
    counters.old += 1;
    counters.new += 1;
  }
}
