/**
 * Turn a pull request's failed CI checks into bounded, redacted findings.
 *
 * Check states are normalized from GitHub check runs and legacy commit
 * statuses. A repair is considered only once every check has finished, and
 * cancelled, skipped or neutral checks never count as failures, so a run
 * cancelled because a newer one superseded it cannot start a repair. Logs are
 * stripped of terminal control codes and Actions timestamps, redacted for
 * known secrets, tokens and URL credentials, and cut to a window around the
 * first error plus the final lines.
 *
 * @file
 */
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';

import { trustedExecutable } from '../executables.ts';
import { SecretRedactor } from '../secrets.ts';

import { REPAIR_FINDING_MAX } from './repair-schema.ts';

/** Longest log text retained from one job; the rolling tail keeps the end. */
const LOG_MAX_BYTES = 1_048_576;
/** Deadline for one log download. */
const LOG_TIMEOUT_MS = 30_000;
/** Lines kept before the first error. */
const BEFORE_ERROR = 15;
/** Lines kept from the first error on. */
const AFTER_ERROR = 60;
/** Final lines always kept, where the failing summary usually is. */
const TAIL_LINES = 25;
/** Longest single log line kept. */
const LINE_MAX = 400;
/** Most failed checks whose logs are downloaded per round. */
export const MAX_LOGGED_CHECKS = 5;

/** Check run conclusions and status states that mean the check failed. */
const FAILED: ReadonlySet<string> = new Set(['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE', 'ACTION_REQUIRED', 'ERROR']);
/** Conclusions that finish a check without counting for or against it. */
const IGNORED: ReadonlySet<string> = new Set(['CANCELLED', 'SKIPPED', 'NEUTRAL', 'STALE']);
/** Outcomes that mean a check has not finished. */
const UNFINISHED: ReadonlySet<string> = new Set(['', 'PENDING', 'EXPECTED']);
/** Lines that usually start the real failure in a CI log. */
const ERROR_LINE = /##\[error\]|\b(?:error|exception|fail|failed|failure|panicked|traceback)\b|^\s*not ok\b|\u{2716}/iv;
/** GitHub Actions line timestamps. */
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T[\d.:]+Z ?/gmv;
/** Token shapes redacted even when they are not known local values. */
const TOKENS: readonly RegExp[] = [
  /\bgh[opr-u]_[\dA-Za-z]{20,}\b/gv,
  /\bgithub_pat_\w{20,}\b/gv,
  /\b[kprs]k-[\w\-]{20,}\b/gv,
  /\bxox[abprs]-[\w\-]{10,}\b/gv,
  /\bAKIA[\dA-Z]{16}\b/gv,
];
/** URL credentials: the scheme survives, the user and password do not. */
const URL_CREDENTIALS = /\b(?<scheme>[a-z][\d+\-.a-z]*:\/\/)[^\s\/:@]+:[^\s\/@]+@/giv;
/** An authorization value: the label survives, the scheme and every credential after it do not. */
const AUTHORIZATION = /\b(?<label>authorization["']?[:=] ?["']?)[^\n"']+/giv;
/** A labelled secret value: the label survives, the value does not. */
const LABELLED_SECRET = /\b(?<label>(?:api[\-_]?key|password|secret|token)["']?\s*[:=]\s*["']?)[^\s"',]+/giv;
/** A bearer credential: the scheme word survives, the credential does not. */
const BEARER = /\b(?<label>bearer\s+)[^\s"',]+/giv;
/** Replacement shown for redacted text, matching the literal-secret redactor. */
const REDACTED = '[REDACTED]';

/** One check as the repair policy sees it. */
export interface CheckState {
  /** Check or status context name. */
  readonly name: string;
  /** Normalized state. */
  readonly state: 'pending' | 'success' | 'failed' | 'ignored';
  /** Link to the run, when GitHub reports one. */
  readonly url: string | null;
}

/** Fields GitHub reports for a check run or a legacy commit status. */
export interface RawCheck {
  /** Check run name. */
  readonly name?: string | undefined;
  /** Commit status context. */
  readonly context?: string | undefined;
  /** Check run lifecycle status. */
  readonly status?: string | undefined;
  /** Check run conclusion once completed. */
  readonly conclusion?: string | null | undefined;
  /** Commit status state. */
  readonly state?: string | undefined;
  /** Check run link. */
  readonly detailsUrl?: string | null | undefined;
  /** Commit status link. */
  readonly targetUrl?: string | null | undefined;
}

/** A downloaded log for one failed check. */
export interface CheckLog {
  /** Check name. */
  readonly name: string;
  /** Raw log text, or `null` when no log could be read. */
  readonly text: string | null;
}

/**
 * The single outcome of a check run or commit status, upper-cased.
 *
 * @param check - Raw rollup entry.
 * @returns Outcome, or an empty string while a check run has not completed.
 */
function outcomeOf(check: RawCheck): string {
  const status = (check.status ?? '').toUpperCase();
  if (status !== '' && status !== 'COMPLETED') {
    return '';
  }
  const conclusion = (check.conclusion ?? '').toUpperCase();
  return conclusion === '' ? (check.state ?? '').toUpperCase() : conclusion;
}

/**
 * Normalize one GitHub check run or commit status.
 *
 * @param check - Raw rollup entry.
 * @returns Name, state and run link.
 */
export function checkState(check: RawCheck): CheckState {
  const name = check.name ?? check.context ?? '';
  const url = check.detailsUrl ?? check.targetUrl ?? null;
  const outcome = outcomeOf(check);
  if (UNFINISHED.has(outcome)) {
    return { name, state: 'pending', url };
  }
  if (FAILED.has(outcome)) {
    return { name, state: 'failed', url };
  }
  return { name, state: IGNORED.has(outcome) ? 'ignored' : 'success', url };
}

/**
 * The failed checks a repair round should address.
 *
 * @param rollup - The PR's status check rollup.
 * @returns Failed checks by name once every check has finished; `null` while any is pending.
 */
export function failedChecks(rollup: readonly RawCheck[] | null): CheckState[] | null {
  const checks = (rollup ?? []).map((check) => checkState(check));
  if (checks.some((check) => check.state === 'pending')) {
    return null;
  }
  const failed = new Map(checks.filter((check) => check.state === 'failed').map((check) => [check.name, check]));
  return failed
    .values()
    .toArray()
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

/**
 * The GitHub Actions job id in a check run's details link.
 *
 * @param url - Check run link.
 * @returns Job id, or `null` for other CI providers.
 */
export function actionsJobId(url: string | null): string | null {
  return url === null ? null : (/\/actions\/runs\/\d+\/jobs?\/(?<job>\d+)/v.exec(url)?.groups?.['job'] ?? null);
}

/**
 * Remove control codes and timestamps, then redact known values and token shapes.
 *
 * @param text - Raw CI log.
 * @param secrets - Known local credentials, such as the mesh token.
 * @returns Log text safe to persist and show the code owner.
 */
export function redactLog(text: string, secrets: readonly string[]): string {
  const redactor = new SecretRedactor(secrets);
  let clean = redactor.redact(stripVTControlCharacters(text).replaceAll('\r', '').replaceAll(TIMESTAMP, ''));
  for (const pattern of TOKENS) {
    clean = clean.replaceAll(pattern, () => REDACTED);
  }
  return clean
    .replaceAll(URL_CREDENTIALS, (_match, scheme: string) => `${scheme}${REDACTED}@`)
    .replaceAll(AUTHORIZATION, (_match, label: string) => `${label}${REDACTED}`)
    .replaceAll(BEARER, (_match, label: string) => `${label}${REDACTED}`)
    .replaceAll(LABELLED_SECRET, (_match, label: string) => `${label}${REDACTED}`);
}

/** The two parts of an excerpt, as line indexes. */
interface KeptLines {
  /** Index of the first error line, or -1. */
  readonly first: number;
  /** Lines around the first error that come before the tail. */
  readonly window: readonly number[];
  /** The final lines. */
  readonly tail: readonly number[];
}

/**
 * Line indexes an excerpt keeps: a window around the first error and the final lines.
 *
 * @param lines - Log lines.
 * @returns Sorted indexes of each part; the window stops where the tail starts.
 */
function keptLines(lines: readonly string[]): KeptLines {
  const tailStart = Math.max(0, lines.length - TAIL_LINES);
  const window: number[] = [];
  const first = lines.findIndex((line) => ERROR_LINE.test(line));
  if (first !== -1) {
    const end = Math.min(tailStart, first + AFTER_ERROR);
    for (let index = Math.max(0, first - BEFORE_ERROR); index < end; index += 1) {
      window.push(index);
    }
  }
  return {
    first,
    window,
    tail: Array.from({ length: lines.length - tailStart }, (_value, offset) => tailStart + offset),
  };
}

/**
 * Render kept lines, marking each elided range.
 *
 * @param lines - Log lines.
 * @param indexes - Sorted indexes to render.
 * @param previous - Index of the line rendered before these, or -1.
 * @returns Rendered lines.
 */
function rendered(lines: readonly string[], indexes: readonly number[], previous: number): string[] {
  const kept: string[] = [];
  let last = previous;
  for (const index of indexes) {
    if (index !== last + 1) {
      kept.push(`… ${String(index - last - 1)} lines omitted …`);
    }
    kept.push(lines[index] ?? '');
    last = index;
  }
  return kept;
}

/**
 * Cut a log to the window around its first error plus its final lines.
 *
 * @param text - Redacted log.
 * @param limit - Longest excerpt in characters.
 * @returns Bounded excerpt with elided ranges marked.
 */
export function excerptLog(text: string, limit = REPAIR_FINDING_MAX): string {
  const lines = text
    .split('\n')
    .map((line) => (line.length > LINE_MAX ? `${line.slice(0, LINE_MAX)}…` : line))
    .filter((line) => line.trim() !== '');
  const { first, window, tail } = keptLines(lines);
  const diagnostic = rendered(lines, window, -1).join('\n');
  const ending = rendered(lines, tail, window.at(-1) ?? -1).join('\n');
  const excerpt = diagnostic === '' ? ending : `${diagnostic}\n${ending}`;
  if (excerpt.length <= limit) {
    return excerpt;
  }
  // Over the bound, the window starts at the first error and keeps up to half the budget; the tail keeps its end.
  const focused = rendered(
    lines,
    window.filter((index) => index >= first),
    -1,
  ).join('\n');
  const share = Math.min(focused.length, Math.floor(limit / 2));
  const start = share < focused.length ? `${focused.slice(0, share - 1)}…` : focused;
  const room = limit - start.length - (start === '' ? 0 : 1);
  const end = ending.length <= room ? ending : `…${ending.slice(ending.length - room + 1)}`;
  return start === '' ? end : `${start}\n${end}`;
}

/**
 * One finding for a failed check, bound to the head it failed on.
 *
 * @param check - Failed check.
 * @param log - Its redacted log, if one was read.
 * @param head - Exact source the check ran on.
 * @returns Finding text within the recorded bound.
 */
export function ciFinding(check: CheckState, log: string | null, head: string): string {
  const where = check.url === null ? '' : ` (${check.url})`;
  const header = `[P1] CI check "${check.name}" failed on ${head}${where}.`;
  return log === null || log.trim() === ''
    ? `${header} No log was available; reproduce the check locally.`.slice(0, REPAIR_FINDING_MAX)
    : `${header}\n${excerptLog(log, REPAIR_FINDING_MAX - header.length - 1)}`;
}

/**
 * Read a text endpoint through the GitHub CLI, keeping only the final bytes.
 *
 * @param root - Directory the CLI runs in.
 * @returns Runner returning the endpoint's text, or `null` when it fails.
 */
export function githubTextRunner(root: string): (args: readonly string[]) => Promise<string | null> {
  return async (args) => {
    return new Promise<string | null>((resolve) => {
      const child = spawn(trustedExecutable('gh'), [...args], {
        cwd: root,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: LOG_TIMEOUT_MS,
        env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_HOST: 'github.com' },
      });
      let chunks: Buffer[] = [];
      let size = 0;
      const tail = (): Buffer => {
        const joined = Buffer.concat(chunks);
        return joined.subarray(Math.max(0, joined.length - LOG_MAX_BYTES));
      };
      child.stdout.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        size += chunk.length;
        if (size <= LOG_MAX_BYTES * 2) {
          return;
        }
        chunks = [tail()];
        size = LOG_MAX_BYTES;
      });
      child.on('error', () => {
        resolve(null);
      });
      child.on('close', (code) => {
        resolve(code === 0 ? tail().toString('utf8') : null);
      });
    });
  };
}
