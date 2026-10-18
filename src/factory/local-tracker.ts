/**
 * Project-private issue and pull-request ledger for GitHub-free delivery.
 * Records live in one validated JSON document under `.malt/local`; every
 * mutation is serialized per file and replaced atomically, so a crash leaves
 * either the previous or the next complete ledger, never a partial one.
 * Validation is hand-written: this ledger adds no runtime dependency.
 *
 * @file
 */

import { mkdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { hasErrorCode } from '../errors.ts';
import { MeshError } from '../protocol.ts';
import { writeAtomic } from '../summary.ts';

/** Current ledger format. */
const LEDGER_VERSION = 1;
/** Bounded comment history per issue keeps the ledger small and readable. */
const COMMENT_LIMIT = 500;
/** Longest stored text field. */
const TEXT_LIMIT = 64_000;
/** Workflow values accepted for issues, matching the GitHub board columns. */
export const LOCAL_STATUSES = [
  'Backlog',
  'Ready',
  'Development',
  'QA / Review',
  'Merge Ready',
  'Final Verification',
  'Done',
  'Blocked',
] as const;
/** One board column. */
export type LocalStatus = (typeof LOCAL_STATUSES)[number];

/** A durable comment, deduplicated by its outbox identity. */
export interface LocalComment {
  /** Stable effect or operator identity. */
  readonly id: string;
  /** Rendered Markdown text. */
  readonly body: string;
  /** Creation time in epoch milliseconds. */
  readonly at: number;
}
/** A feature parent or atomic delivery issue. */
export interface LocalIssue {
  /** Ledger-wide number shared with pull requests, as on GitHub. */
  readonly number: number;
  /** Parent feature or atomic delivery. */
  readonly kind: 'feature' | 'delivery';
  /** Short public title. */
  readonly title: string;
  /** Observable scope and boundaries. */
  readonly body: string;
  /** Verifiable completion criteria. */
  readonly acceptanceCriteria: readonly string[];
  /** Feature parent of a delivery. */
  readonly parent: number | null;
  /** Blocking prerequisite issue numbers. */
  readonly dependencies: readonly number[];
  /** Workflow column. */
  readonly status: LocalStatus;
  /** Column requested at creation, kept so a retried request can be compared with it. */
  readonly initialStatus: LocalStatus;
  /** Open or closed lifecycle. */
  readonly state: 'open' | 'closed';
  /** Closure reason, absent while open. */
  readonly stateReason: 'completed' | 'not_planned' | null;
  /** Retained discussion. */
  readonly comments: readonly LocalComment[];
  /** Creation time. */
  readonly createdAt: number;
  /** Last mutation time. */
  readonly updatedAt: number;
}
/** A reviewed branch proposed for the protected base. */
export interface LocalPull {
  /** Ledger-wide number. */
  readonly number: number;
  /** Delivery issue this proposal implements. */
  readonly issue: number;
  /** Public title. */
  readonly title: string;
  /** Description and acceptance criteria. */
  readonly body: string;
  /** Source branch in the hub. */
  readonly head: string;
  /** Target branch in the hub. */
  readonly base: string;
  /** GitHub-compatible lifecycle state. */
  readonly state: 'OPEN' | 'CLOSED' | 'MERGED';
  /** Hub commit created by the merge. */
  readonly mergeCommit: string | null;
  /** Exact head merged, retained after the branch is retired. */
  readonly mergedHead: string | null;
  /** Retained discussion and review notes. */
  readonly comments: readonly LocalComment[];
  /** Creation time. */
  readonly createdAt: number;
  /** Last mutation time. */
  readonly updatedAt: number;
}
/** Complete ledger document. */
export interface LocalLedger {
  /** Format version. */
  readonly version: typeof LEDGER_VERSION;
  /** Next shared issue/PR number. */
  readonly next: number;
  /** Issues keyed by number. */
  readonly issues: readonly LocalIssue[];
  /** Pull requests keyed by number. */
  readonly pulls: readonly LocalPull[];
  /** Idempotent creation identities mapped to their issue number. */
  readonly requests: Readonly<Record<string, number>>;
}
/** Issue creation intent. */
export interface IssueDraft {
  /** Retry-safe identity; reuse returns the original issue. */
  readonly requestId: string;
  /** Feature or delivery. */
  readonly kind: 'feature' | 'delivery';
  /** Short public title. */
  readonly title: string;
  /** Scope description. */
  readonly body: string;
  /** Verifiable criteria. */
  readonly acceptanceCriteria: readonly string[];
  /** Parent feature number for deliveries. */
  readonly parent: number | null;
  /** Initial workflow column. */
  readonly status?: LocalStatus;
}

/**
 * Decide whether a retried creation request matches the issue it created.
 * Status is mutable after creation, so a retry is compared with the status it was created in.
 *
 * @param original - Issue the request identity already created.
 * @param draft - Retried creation intent.
 * @returns Whether every part of the creation intent is unchanged.
 */
function isSameRequest(original: LocalIssue, draft: IssueDraft): boolean {
  return (
    original.title === draft.title &&
    original.kind === draft.kind &&
    original.initialStatus === (draft.status ?? 'Backlog') &&
    original.body === draft.body &&
    original.parent === draft.parent &&
    original.acceptanceCriteria.length === draft.acceptanceCriteria.length &&
    original.acceptanceCriteria.every((criterion, index) => criterion === draft.acceptanceCriteria[index])
  );
}

/** Serialized mutation chains, one per ledger file in this process. */
const chains = new Map<string, Promise<unknown>>();

/**
 * Narrow an unknown value to a plain object.
 *
 * @param value - Decoded JSON.
 * @returns Whether the value is a non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Require a bounded string field.
 *
 * @param record - Source object.
 * @param key - Field name.
 * @returns Validated text.
 * @throws {MeshError} For a missing or oversized value.
 */
function text(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length > TEXT_LIMIT) {
    throw new MeshError('INTERNAL', `The local delivery ledger has an invalid ${key}.`);
  }
  return value;
}

/**
 * Require a non-negative safe integer field.
 *
 * @param record - Source object.
 * @param key - Field name.
 * @returns Validated integer.
 * @throws {MeshError} For a missing or fractional value.
 */
function integer(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new MeshError('INTERNAL', `The local delivery ledger has an invalid ${key}.`);
  }
  return value;
}

/**
 * Read a nullable bounded string field.
 *
 * @param record - Source object.
 * @param key - Field name.
 * @returns Validated text or null.
 */
function optionalText(record: Record<string, unknown>, key: string): string | null {
  return record[key] === null ? null : text(record, key);
}

/**
 * Read a nullable non-negative integer field.
 *
 * @param record - Source object.
 * @param key - Field name.
 * @returns Validated integer or null.
 */
function optionalInteger(record: Record<string, unknown>, key: string): number | null {
  return record[key] === null ? null : integer(record, key);
}

/**
 * Require one of a fixed set of literals.
 *
 * @param record - Source object.
 * @param key - Field name.
 * @param allowed - Accepted literals.
 * @returns The validated literal.
 * @throws {MeshError} For any other value.
 */
function literal<T extends string>(record: Record<string, unknown>, key: string, allowed: readonly T[]): T {
  const value = record[key];
  const match = allowed.find((candidate) => candidate === value);
  if (match === undefined) {
    throw new MeshError('INTERNAL', `The local delivery ledger has an invalid ${key}.`);
  }
  return match;
}

/**
 * Require an array and validate every element.
 *
 * @param record - Source object.
 * @param key - Field name.
 * @param read - Element validator.
 * @returns Validated elements.
 * @throws {MeshError} When the field is not an array.
 */
function list<T>(record: Record<string, unknown>, key: string, read: (value: unknown) => T): T[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    throw new MeshError('INTERNAL', `The local delivery ledger has an invalid ${key}.`);
  }
  return value.map((entry) => read(entry));
}

/**
 * Validate a comment.
 *
 * @param value - Decoded entry.
 * @returns Typed comment.
 * @throws {MeshError} For malformed entries.
 */
function comment(value: unknown): LocalComment {
  if (!isRecord(value)) {
    throw new MeshError('INTERNAL', 'The local delivery ledger has an invalid comment.');
  }
  return { id: text(value, 'id'), body: text(value, 'body'), at: integer(value, 'at') };
}

/**
 * Validate a string element.
 *
 * @param value - Decoded entry.
 * @returns The string.
 * @throws {MeshError} For non-strings.
 */
function element(value: unknown): string {
  if (typeof value !== 'string' || value.length > TEXT_LIMIT) {
    throw new MeshError('INTERNAL', 'The local delivery ledger has an invalid text entry.');
  }
  return value;
}

/**
 * Validate an issue number element.
 *
 * @param value - Decoded entry.
 * @returns Positive integer.
 * @throws {MeshError} For other values.
 */
function issueNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new MeshError('INTERNAL', 'The local delivery ledger has an invalid issue reference.');
  }
  return value;
}

/**
 * Validate an issue record.
 *
 * @param value - Decoded entry.
 * @returns Typed issue.
 * @throws {MeshError} For malformed entries.
 */
function issue(value: unknown): LocalIssue {
  if (!isRecord(value)) {
    throw new MeshError('INTERNAL', 'The local delivery ledger has an invalid issue.');
  }
  return {
    number: integer(value, 'number'),
    kind: literal(value, 'kind', ['feature', 'delivery'] as const),
    title: text(value, 'title'),
    body: text(value, 'body'),
    acceptanceCriteria: list(value, 'acceptanceCriteria', element),
    parent: optionalInteger(value, 'parent'),
    dependencies: list(value, 'dependencies', issueNumber),
    status: literal(value, 'status', LOCAL_STATUSES),
    initialStatus: literal(value, 'initialStatus', LOCAL_STATUSES),
    state: literal(value, 'state', ['open', 'closed'] as const),
    stateReason:
      value['stateReason'] === null ? null : literal(value, 'stateReason', ['completed', 'not_planned'] as const),
    comments: list(value, 'comments', comment),
    createdAt: integer(value, 'createdAt'),
    updatedAt: integer(value, 'updatedAt'),
  };
}

/**
 * Validate a pull-request record.
 *
 * @param value - Decoded entry.
 * @returns Typed pull request.
 * @throws {MeshError} For malformed entries.
 */
function pull(value: unknown): LocalPull {
  if (!isRecord(value)) {
    throw new MeshError('INTERNAL', 'The local delivery ledger has an invalid pull request.');
  }
  return {
    number: integer(value, 'number'),
    issue: integer(value, 'issue'),
    title: text(value, 'title'),
    body: text(value, 'body'),
    head: text(value, 'head'),
    base: text(value, 'base'),
    state: literal(value, 'state', ['OPEN', 'CLOSED', 'MERGED'] as const),
    mergeCommit: optionalText(value, 'mergeCommit'),
    mergedHead: optionalText(value, 'mergedHead'),
    comments: list(value, 'comments', comment),
    createdAt: integer(value, 'createdAt'),
    updatedAt: integer(value, 'updatedAt'),
  };
}

/**
 * Validate a complete decoded ledger.
 *
 * @param value - Decoded JSON document.
 * @returns Typed ledger.
 * @throws {MeshError} For unknown versions or malformed records.
 */
export function parseLedger(value: unknown): LocalLedger {
  if (!isRecord(value) || value['version'] !== LEDGER_VERSION || !isRecord(value['requests'])) {
    throw new MeshError('INTERNAL', 'The local delivery ledger has an unsupported format.');
  }
  const entries = Object.entries(value['requests']);
  const requests: Record<string, number> = {};
  for (const [key, number] of entries) {
    requests[key] = issueNumber(number);
  }
  return {
    version: LEDGER_VERSION,
    next: integer(value, 'next'),
    issues: list(value, 'issues', issue),
    pulls: list(value, 'pulls', pull),
    requests,
  };
}

/** An empty ledger whose first record is number one. */
const EMPTY: LocalLedger = { version: LEDGER_VERSION, next: 1, issues: [], pulls: [], requests: {} };

/** Validated, serialized access to one project's local ledger. */
export class LocalTracker {
  /** Ledger document path. */
  public readonly file: string;
  /** Injectable clock for deterministic tests. */
  private readonly now: () => number;

  /**
   * Bind the ledger inside a project-private directory.
   *
   * @param directory - The project's `.malt/local` directory.
   * @param now - Clock.
   */
  public constructor(directory: string, now: () => number = Date.now) {
    this.file = path.join(directory, 'tracker.json');
    this.now = now;
  }

  /**
   * Read the current committed ledger.
   *
   * @returns Validated ledger, empty before the first write.
   * @throws {MeshError} For a malformed ledger; other read failures propagate.
   */
  public read(): LocalLedger {
    let raw: string;
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixed ledger file under the selected project's private state.
      raw = readFileSync(this.file, 'utf8');
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) {
        return EMPTY;
      }
      throw error;
    }
    return parseLedger(JSON.parse(raw));
  }

  /**
   * Read the current committed ledger without blocking the event loop.
   *
   * @returns Validated ledger, empty before the first write.
   * @throws {MeshError} For a malformed ledger; other read failures propagate.
   */
  public async load(): Promise<LocalLedger> {
    let raw: string;
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixed ledger file under the selected project's private state.
      raw = await readFile(this.file, 'utf8');
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) {
        return EMPTY;
      }
      throw error;
    }
    return parseLedger(JSON.parse(raw));
  }

  /**
   * Find one issue.
   *
   * @param number - Ledger number to look up.
   * @returns The validated issue record.
   * @throws {MeshError} When absent.
   */
  public issue(number: number): LocalIssue {
    const found = this.read().issues.find((entry) => entry.number === number);
    if (found === undefined) {
      throw new MeshError('NOT_FOUND', `Local issue #${String(number)} does not exist.`);
    }
    return found;
  }

  /**
   * Find one pull request.
   *
   * @param number - Ledger number of the pull request to read.
   * @returns The pull request.
   * @throws {MeshError} When absent.
   */
  public pull(number: number): LocalPull {
    const found = this.read().pulls.find((entry) => entry.number === number);
    if (found === undefined) {
      throw new MeshError('NOT_FOUND', `Local pull request #${String(number)} does not exist.`);
    }
    return found;
  }

  /**
   * Create an issue, or return the original for a repeated request identity.
   *
   * @param draft - Creation intent.
   * @returns The created or previously created issue.
   * @throws {MeshError} For a parent that does not match the kind, or a reused identity with other content.
   */
  public async createIssue(draft: IssueDraft): Promise<LocalIssue> {
    return this.mutate((ledger) => {
      const existing = ledger.requests[draft.requestId];
      if (existing !== undefined) {
        const original = ledger.issues.find((entry) => entry.number === existing);
        if (original === undefined || !isSameRequest(original, draft)) {
          throw new MeshError('INVALID_INPUT', 'This request ID already created a different local issue.');
        }
        return { ledger, value: original };
      }
      if (draft.kind === 'feature' && draft.parent !== null) {
        throw new MeshError('INVALID_INPUT', 'A feature must not specify a parent.');
      }
      if (
        draft.kind === 'delivery' &&
        ledger.issues.every((entry) => !(entry.number === draft.parent && entry.kind === 'feature'))
      ) {
        throw new MeshError('INVALID_INPUT', 'A delivery parent must be an existing local feature issue.');
      }
      const at = this.now();
      const created: LocalIssue = {
        number: ledger.next,
        kind: draft.kind,
        title: draft.title,
        body: draft.body,
        acceptanceCriteria: [...draft.acceptanceCriteria],
        parent: draft.parent,
        dependencies: [],
        status: draft.status ?? 'Backlog',
        initialStatus: draft.status ?? 'Backlog',
        state: 'open',
        stateReason: null,
        comments: [],
        createdAt: at,
        updatedAt: at,
      };
      return {
        ledger: {
          ...ledger,
          next: ledger.next + 1,
          issues: [...ledger.issues, created],
          requests: { ...ledger.requests, [draft.requestId]: created.number },
        },
        value: created,
      };
    });
  }

  /**
   * Replace an issue's blocking prerequisites.
   *
   * @param number - Dependent issue.
   * @param dependencies - Prerequisite issue numbers.
   * @returns Updated issue.
   * @throws {MeshError} For unknown or self references.
   */
  public async setDependencies(number: number, dependencies: readonly number[]): Promise<LocalIssue> {
    return this.updateIssue(number, (current, ledger) => {
      for (const dependency of dependencies) {
        if (dependency === number || ledger.issues.every((entry) => entry.number !== dependency)) {
          throw new MeshError('INVALID_INPUT', 'Dependencies must reference other existing local issues.');
        }
      }
      return { ...current, dependencies: [...new Set(dependencies)].toSorted((left, right) => left - right) };
    });
  }

  /**
   * Move an issue to a workflow column.
   *
   * @param number - Ledger number of the issue to change.
   * @param status - Requested column.
   * @returns Updated issue.
   * @throws {MeshError} For an unknown column.
   */
  public async setStatus(number: number, status: string): Promise<LocalIssue> {
    const column = LOCAL_STATUSES.find((candidate) => candidate === status);
    if (column === undefined) {
      throw new MeshError('INVALID_INPUT', `Unknown local workflow status: ${status}.`);
    }
    return this.updateIssue(number, (current) => ({ ...current, status: column }));
  }

  /**
   * Close an issue with an explicit reason; repeated closure is a no-op.
   *
   * @param number - Ledger number of the issue to change.
   * @param reason - Completed or not planned.
   * @returns Updated issue.
   */
  public async closeIssue(number: number, reason: 'completed' | 'not_planned'): Promise<LocalIssue> {
    return this.updateIssue(number, (current) =>
      current.state === 'closed' ? current : { ...current, state: 'closed', stateReason: reason },
    );
  }

  /**
   * Append a comment unless its identity was already recorded.
   *
   * @param target - Issue or pull-request number.
   * @param id - Stable comment identity.
   * @param body - Comment text.
   * @returns Whether a new comment was appended.
   * @throws {MeshError} When the number is unknown.
   */
  public async comment(target: number, id: string, body: string): Promise<boolean> {
    return this.mutate((ledger) => {
      const at = this.now();
      const entry: LocalComment = { id, body: body.slice(0, TEXT_LIMIT), at };
      const append = (comments: readonly LocalComment[]): LocalComment[] => [...comments, entry].slice(-COMMENT_LIMIT);
      const found = ledger.issues.find((candidate) => candidate.number === target);
      if (found !== undefined) {
        if (found.comments.some((existing) => existing.id === id)) {
          return { ledger, value: false };
        }
        const issues = ledger.issues.map((candidate) =>
          candidate === found ? { ...found, comments: append(found.comments), updatedAt: at } : candidate,
        );
        return { ledger: { ...ledger, issues }, value: true };
      }
      const proposal = ledger.pulls.find((candidate) => candidate.number === target);
      if (proposal === undefined) {
        throw new MeshError('NOT_FOUND', `Local record #${String(target)} does not exist.`);
      }
      if (proposal.comments.some((existing) => existing.id === id)) {
        return { ledger, value: false };
      }
      const pulls = ledger.pulls.map((candidate) =>
        candidate === proposal ? { ...proposal, comments: append(proposal.comments), updatedAt: at } : candidate,
      );
      return { ledger: { ...ledger, pulls }, value: true };
    });
  }

  /**
   * Return the open pull request for a branch, or create one.
   *
   * @param draft - Branch, issue and description.
   * @returns Existing or new pull request.
   */
  public async openPull(draft: Pick<LocalPull, 'issue' | 'title' | 'body' | 'head' | 'base'>): Promise<LocalPull> {
    return this.mutate((ledger) => {
      const existing = ledger.pulls.find((entry) => entry.head === draft.head && entry.state === 'OPEN');
      if (existing !== undefined) {
        return { ledger, value: existing };
      }
      const at = this.now();
      const created: LocalPull = {
        ...draft,
        number: ledger.next,
        state: 'OPEN',
        mergeCommit: null,
        mergedHead: null,
        comments: [],
        createdAt: at,
        updatedAt: at,
      };
      return { ledger: { ...ledger, next: ledger.next + 1, pulls: [...ledger.pulls, created] }, value: created };
    });
  }

  /**
   * Record a pull request's terminal state.
   *
   * @param number - Pull request.
   * @param outcome - Merged with its commit and head, or closed.
   * @returns Updated pull request.
   * @throws {MeshError} When it was already settled differently.
   */
  public async settlePull(
    number: number,
    outcome: { state: 'MERGED'; mergeCommit: string; mergedHead: string } | { state: 'CLOSED' },
  ): Promise<LocalPull> {
    return this.mutate((ledger) => {
      const current = ledger.pulls.find((entry) => entry.number === number);
      if (current === undefined) {
        throw new MeshError('NOT_FOUND', `Local pull request #${String(number)} does not exist.`);
      }
      if (current.state === outcome.state) {
        if (
          outcome.state === 'MERGED' &&
          (current.mergeCommit !== outcome.mergeCommit || current.mergedHead !== outcome.mergedHead)
        ) {
          throw new MeshError(
            'FACTORY_GATED',
            `Local pull request #${String(number)} was already merged as a different commit or head.`,
          );
        }
        return { ledger, value: current };
      }
      if (current.state !== 'OPEN') {
        throw new MeshError('FACTORY_GATED', `Local pull request #${String(number)} is already ${current.state}.`);
      }
      const updated: LocalPull = {
        ...current,
        ...outcome,
        updatedAt: this.now(),
      };
      return {
        ledger: { ...ledger, pulls: ledger.pulls.map((entry) => (entry === current ? updated : entry)) },
        value: updated,
      };
    });
  }

  /**
   * Apply a validated change to one issue.
   *
   * @param number - Ledger number of the issue to change.
   * @param change - Pure replacement function.
   * @returns Updated issue.
   * @throws {MeshError} When absent.
   */
  private async updateIssue(
    number: number,
    change: (current: LocalIssue, ledger: LocalLedger) => LocalIssue,
  ): Promise<LocalIssue> {
    return this.mutate((ledger) => {
      const current = ledger.issues.find((entry) => entry.number === number);
      if (current === undefined) {
        throw new MeshError('NOT_FOUND', `Local issue #${String(number)} does not exist.`);
      }
      const changed = change(current, ledger);
      if (changed === current) {
        return { ledger, value: current };
      }
      const updated = { ...changed, updatedAt: this.now() };
      return {
        ledger: { ...ledger, issues: ledger.issues.map((entry) => (entry === current ? updated : entry)) },
        value: updated,
      };
    });
  }

  /**
   * Serialize a read-modify-write and persist only changed ledgers.
   *
   * @param change - Pure transition returning the next ledger and a result.
   * @returns The transition's result after the ledger is durable.
   */
  private async mutate<T>(change: (ledger: LocalLedger) => { ledger: LocalLedger; value: T }): Promise<T> {
    const run = this.after(chains.get(this.file), change);
    chains.set(this.file, run);
    try {
      return await run;
    } finally {
      if (chains.get(this.file) === run) {
        chains.delete(this.file);
      }
    }
  }

  /**
   * Wait for the preceding write, whatever its outcome, then apply exactly once.
   *
   * @param previous - Preceding queued write in this process.
   * @param change - Pure transition.
   * @returns The transition's result.
   */
  private async after<T>(
    previous: Promise<unknown> | undefined,
    change: (ledger: LocalLedger) => { ledger: LocalLedger; value: T },
  ): Promise<T> {
    try {
      await previous;
    } catch {
      /* The earlier caller already received its failure; later writes still proceed. */
    }
    return this.apply(change);
  }

  /**
   * Apply one transition synchronously against the latest durable ledger.
   *
   * @param change - Pure transition.
   * @returns The transition's result.
   */
  private apply<T>(change: (ledger: LocalLedger) => { ledger: LocalLedger; value: T }): T {
    const current = this.read();
    const { ledger, value } = change(current);
    if (ledger !== current) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixed private ledger directory for the selected project.
      mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      writeAtomic(this.file, `${JSON.stringify(ledger, null, 2)}\n`);
    }
    return value;
  }
}
