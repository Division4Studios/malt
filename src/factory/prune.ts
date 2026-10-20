/**
 * Report, and on request remove, orphaned and prunable worktrees and review
 * snapshots. The report covers every worktree Git registers, every folder
 * under `.malt/worktrees` and every ownership-ledger entry, with the delivery,
 * attempt or terminal it belongs to and why it is kept or removable.
 *
 * Removable means Git reports it prunable, or the ledger lists it, no live
 * delivery, attempt, terminal or baseline measurement uses it, and it is not
 * locked. Uncommitted changes, and a detached commit that no ref holds, are
 * archived to `refs/malt/archive/prune/<id>` first, so no work is discarded.
 * Removal goes through the owned removal, which unlinks the `.malt` junction or
 * symlink non-recursively before Git deletes the folder, and then runs
 * `git worktree prune`. Branches are never deleted. Worktrees outside
 * `.malt/worktrees`, folders the ledger does not list, worktrees another
 * environment created and worktrees whose `.malt` is not this project's memory
 * link are kept; for a worktree whose folder is already gone, Git's prune drops
 * only the stale registration. A dry run is the default; removal needs `apply`,
 * a paused factory and this environment owning `.malt/worktrees`.
 *
 * @file
 */
import { existsSync, readdirSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import path from 'node:path';

import { MeshError } from '../protocol.ts';

import { isBaselineMeasuring } from './baseline.ts';
import { CommandFailureError, commandLabel } from './commands.ts';
import { factorySchemas } from './schema.ts';
import { ACTIVE_TERMINAL_STATES } from './terminal-sessions.ts';
import { currentEnvironment, readOwner } from './worktree-owner.ts';

import type { FactoryContext } from './context.ts';
import type { FactoryJob, FactoryTask } from './schema.ts';

/** Commit prefix shown in reasons. */
const SHORT_SHA = 12;

/** What prune would do, or did, with one worktree. */
export type PruneAction = 'keep' | 'remove' | 'archive' | 'prune' | 'removed' | 'archived' | 'pruned';

/** One worktree, snapshot or folder and what prune decided. */
export interface PruneEntry {
  /** Ledger id; the folder name or path when the ledger does not list it. */
  readonly id: string;
  /** Its directory. */
  readonly directory: string;
  /** A delivery worktree, an attempt's review snapshot, a main baseline snapshot, a scratch terminal, or none of MALT's. */
  readonly kind: 'delivery' | 'snapshot' | 'baseline' | 'terminal' | 'unowned';
  /** The delivery, attempt or terminal it belongs to, with that record's state; null when none is recorded. */
  readonly owner: string | null;
  /** What prune would do, or did. */
  readonly action: PruneAction;
  /** Why it is kept or removable. */
  readonly reason: string;
  /** Ref that keeps its uncommitted or unreferenced work. */
  readonly archive?: string | undefined;
}

/** The prune report. */
export interface PruneResult {
  /** Whether removal ran; false for a dry run. */
  readonly applied: boolean;
  /** Every registered worktree, folder and ledger entry. */
  readonly entries: readonly PruneEntry[];
}

/** What prune needs: the project, its ledger and its owned worktrees. */
type PruneContext = Pick<FactoryContext, 'mesh' | 'repository' | 'workspaces'>;

/** One worktree as `git worktree list --porcelain` reports it. */
interface Registration {
  /** Directory as Git recorded it. */
  directory: string;
  /** Whether HEAD is detached. */
  isDetached: boolean;
  /** Lock reason, empty when locked without one; null when unlocked. */
  locked: string | null;
  /** Why Git would prune it; null when it would not. */
  prunable: string | null;
}

/** A ledger entry. */
interface LedgerRecord {
  /** Worktree id. */
  readonly id: string;
  /** Its directory. */
  readonly directory: string;
}

/** Everything known about one directory before deciding. */
interface Candidate {
  /** Directory to report. */
  readonly directory: string;
  /** Canonical identity. */
  readonly key: string;
  /** Git's registration, when Git lists it. */
  registration?: Registration | undefined;
  /** Ledger entry, when the ledger lists it. */
  record?: LedgerRecord | undefined;
  /** Whether it is Git's primary checkout. */
  isPrimary: boolean;
}

/** A decision plus what removal needs to repeat its checks. */
interface Planned {
  /** Reported entry. */
  readonly entry: PruneEntry;
  /** Ledger entry inside this environment's root, the only kind ever retired. */
  readonly record: LedgerRecord | undefined;
  /** Canonical identity of its directory. */
  readonly key: string;
}

/** Who a worktree belongs to, and whether that owner still uses it. */
interface Owner {
  /** For example `delivery #12 (review)`. */
  readonly label: string;
  /** Whether it must be kept. */
  readonly isLive: boolean;
}

/** Live and recent ledger records, read once per decision. */
interface Holders {
  /** Deliveries by canonical worktree; an unfinished one wins over a finished one. */
  readonly tasks: ReadonlyMap<string, FactoryTask>;
  /** Running and recent attempts by id. */
  readonly jobs: ReadonlyMap<string, FactoryJob>;
}

/**
 * A failure in words, with Git's redacted stderr tail when Git failed.
 *
 * @param error - Caught failure.
 * @returns One message.
 */
function messageOf(error: unknown): string {
  if (error instanceof CommandFailureError) {
    return `the ${commandLabel(error.command)} command failed: ${error.diagnostics.trim()}`;
  }
  return Error.isError(error) ? error.message : String(error);
}

/**
 * Canonical identity of a directory that may no longer exist, using the host's case rules.
 *
 * @param directory - Ledger, Git or folder path.
 * @returns The real path of its nearest existing ancestor joined with the rest.
 */
async function identity(directory: string): Promise<string> {
  let existing = path.resolve(directory);
  const missing: string[] = [];
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Only resolves paths the ledger or Git recorded; nothing is read.
  while (!existsSync(existing) && path.dirname(existing) !== existing) {
    missing.push(path.basename(existing));
    existing = path.dirname(existing);
  }
  let canonical = path.resolve(directory);
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Resolves an existing ancestor only.
    canonical = path.join(await realpath(existing), ...missing.toReversed());
  } catch {
    /* An unreadable ancestor compares by its resolved path. */
  }
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

/**
 * Whether a canonical path is strictly inside a canonical root.
 *
 * @param root - Canonical root.
 * @param key - Canonical path.
 * @returns True for a descendant.
 */
function isInside(root: string, key: string): boolean {
  const relative = path.relative(root, key);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Parse `git worktree list --porcelain -z`.
 *
 * @param output - NUL-separated attributes, records ended by an empty one.
 * @returns Registrations, the primary checkout first.
 */
export function registrations(output: string): Registration[] {
  const result: Registration[] = [];
  let current: Registration | null = null;
  for (const field of output.split('\0')) {
    const [name = '', ...words] = field.split(' ');
    const value = words.join(' ');
    if (name === 'worktree') {
      current = { directory: value, isDetached: false, locked: null, prunable: null };
      result.push(current);
    } else if (current !== null && name === 'detached') {
      current.isDetached = true;
    } else if (current !== null && name === 'locked') {
      current.locked = value;
    } else if (current !== null && name === 'prunable') {
      current.prunable = value;
    }
  }
  return result;
}

/**
 * Read the deliveries and attempts that can own a worktree.
 *
 * @param context - Project ledger.
 * @returns Lookups by canonical worktree and by attempt id.
 */
async function holders(context: PruneContext): Promise<Holders> {
  const tasks = new Map<string, FactoryTask>();
  for (const task of context.repository.tasks()) {
    if (task.worktree === null) {
      continue;
    }
    // eslint-disable-next-line no-await-in-loop -- Path resolution is cheap and keeps the delivery order.
    const key = await identity(task.worktree);
    if (tasks.get(key)?.phase === 'done' || !tasks.has(key)) {
      tasks.set(key, task);
    }
  }
  return { tasks, jobs: new Map(context.repository.jobs().map((job) => [job.id, job])) };
}

/**
 * What a ledger id says the worktree is.
 *
 * @param id - Ledger id.
 * @returns Its kind.
 */
function kindOf(id: string): PruneEntry['kind'] {
  if (id.startsWith('snapshot-')) {
    return 'snapshot';
  }
  if (id.startsWith('baseline-')) {
    return 'baseline';
  }
  return id.startsWith('terminal-') ? 'terminal' : 'delivery';
}

/**
 * Who owns one ledger worktree, if anyone, and whether it is still in use.
 *
 * @param context - Project ledger and terminal sessions.
 * @param record - Ledger entry.
 * @param key - Canonical identity of its directory.
 * @param seen - Deliveries and attempts.
 * @returns The owner, or null when no record names it.
 */
function ownerOf(context: PruneContext, record: LedgerRecord, key: string, seen: Holders): Owner | null {
  const kind = kindOf(record.id);
  if (kind === 'snapshot') {
    const id = record.id.slice('snapshot-'.length);
    const job = seen.jobs.get(id);
    if (job === undefined) {
      return { label: `attempt ${id} (not running)`, isLive: false };
    }
    const served = job.taskId === null ? undefined : context.repository.tasks().find((item) => item.id === job.taskId);
    const delivery = served === undefined ? '' : ` for delivery #${String(served.issue)}`;
    return { label: `attempt ${id} (${job.kind}, ${job.state})${delivery}`, isLive: job.state === 'running' };
  }
  if (kind === 'terminal') {
    const id = record.id.slice('terminal-'.length);
    const session = context.repository.terminals.get(id);
    return {
      label: `terminal ${id} (${session?.state ?? 'no session record'})`,
      isLive: session !== null && ACTIVE_TERMINAL_STATES.has(session.state),
    };
  }
  if (kind === 'baseline') {
    return {
      label: `main baseline ${record.id.slice('baseline-'.length)}`,
      isLive: isBaselineMeasuring(context.repository.store),
    };
  }
  const task = seen.tasks.get(key);
  return task === undefined
    ? null
    : { label: `delivery #${String(task.issue)} (${task.phase})`, isLive: task.phase !== 'done' };
}

/**
 * Collect every registered worktree, ledger entry and folder under `.malt/worktrees`, keyed by canonical path.
 *
 * @param context - Project Git, ledger and configuration.
 * @param root - `.malt/worktrees`.
 * @returns Candidates in Git's order, then ledger-only, then folder-only ones.
 */
async function candidates(context: PruneContext, root: string): Promise<Candidate[]> {
  const found = new Map<string, Candidate>();
  const add = async (directory: string): Promise<Candidate> => {
    const key = await identity(directory);
    const existing = found.get(key) ?? { directory, key, isPrimary: false };
    found.set(key, existing);
    return existing;
  };
  const listed = registrations(await context.workspaces.git(['worktree', 'list', '--porcelain', '-z']));
  for (const [index, registration] of listed.entries()) {
    // eslint-disable-next-line no-await-in-loop -- Keeps Git's order.
    const candidate = await add(path.resolve(registration.directory));
    candidate.registration = registration;
    candidate.isPrimary = index === 0;
  }
  for (const record of context.workspaces.owned()) {
    // eslint-disable-next-line no-await-in-loop -- Keeps the ledger's order.
    const candidate = await add(record.directory);
    candidate.record = record;
  }
  let folders: string[] = [];
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- The project's fixed private worktree root.
    folders = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name);
  } catch {
    /* No worktree was ever created. */
  }
  for (const name of folders) {
    // eslint-disable-next-line no-await-in-loop -- Keeps the folder order.
    await add(path.join(root, name));
  }
  return found.values().toArray();
}

/**
 * What Git's own registration decides: a locked worktree is kept and a prunable one is pruned.
 *
 * @param registration - Git's registration, if any.
 * @returns The decision, or null when Git's state decides nothing.
 */
function gitVerdict(registration: Registration | undefined): Pick<PruneEntry, 'action' | 'reason'> | null {
  const locked = registration?.locked ?? null;
  if (locked !== null) {
    const why = locked === '' ? '' : ` (${locked})`;
    return { action: 'keep', reason: `Git has it locked${why}, so git worktree prune leaves it alone.` };
  }
  const prunable = registration?.prunable ?? null;
  if (prunable !== null) {
    return {
      action: 'prune',
      reason: `Git reports it prunable (${prunable}); git worktree prune drops only its stale registration.`,
    };
  }
  return null;
}

/**
 * Decide a directory outside `.malt/worktrees`, or one the ledger does not list.
 *
 * @param candidate - Directory facts.
 * @param isOwnedRoot - Whether it is inside this environment's `.malt/worktrees`.
 * @returns The decision; only Git's own stale registrations are removable.
 */
function decideUnlisted(candidate: Candidate, isOwnedRoot: boolean): PruneEntry {
  const { registration, record } = candidate;
  const verdict = gitVerdict(registration);
  const base = {
    id: record?.id ?? (isOwnedRoot ? path.basename(candidate.directory) : candidate.directory),
    directory: candidate.directory,
    kind: record === undefined ? ('unowned' as const) : kindOf(record.id),
    owner: null,
  };
  if (verdict?.action === 'prune') {
    return { ...base, ...verdict };
  }
  if (record !== undefined) {
    return {
      ...base,
      action: 'keep',
      reason: 'Another environment created it outside this .malt/worktrees; remove it from that environment.',
    };
  }
  if (candidate.isPrimary) {
    return { ...base, action: 'keep', reason: 'The primary checkout.' };
  }
  if (!isOwnedRoot) {
    return {
      ...base,
      action: 'keep',
      reason: 'Outside .malt/worktrees: another session or the operator owns it.',
    };
  }
  return {
    ...base,
    action: 'keep',
    reason:
      registration === undefined
        ? 'Neither Git nor the ownership ledger lists this folder; inspect it by hand.'
        : 'Git registers it, but the ownership ledger does not list it, so MALT did not create it.',
  };
}

/**
 * Read an existing worktree's state.
 *
 * @param context - Project Git.
 * @param directory - Registered worktree.
 * @param isDetached - Whether its HEAD is detached, so no branch holds its commit.
 * @returns Its status, its commit, whether any ref holds that commit and whether its `.malt` may be unlinked.
 */
async function inspect(
  context: PruneContext,
  directory: string,
  isDetached: boolean,
): Promise<{ status: string; head: string; isHeld: boolean; isLinkSafe: boolean }> {
  const { status, head } = await context.workspaces.snapshot(directory);
  const holding = isDetached
    ? await context.workspaces.git(['for-each-ref', '--count=1', '--contains', head, '--format=%(refname)'])
    : 'its branch';
  return { status, head, isHeld: holding !== '', isLinkSafe: await context.workspaces.isMemoryLinkSafe(directory) };
}

/**
 * Decide an existing, registered, unowned ledger worktree from its Git state.
 *
 * @param context - Project Git.
 * @param base - Entry identity and owner.
 * @param registration - Git's registration.
 * @returns Remove when clean, archive when it holds uncommitted or unreferenced work, keep when Git cannot read it or
 *   its `.malt` is not this project's memory link.
 */
async function decideOrphan(
  context: PruneContext,
  base: Omit<PruneEntry, 'action' | 'reason'>,
  registration: Registration,
): Promise<PruneEntry> {
  let state: Awaited<ReturnType<typeof inspect>>;
  try {
    state = await inspect(context, base.directory, registration.isDetached);
  } catch (error) {
    return { ...base, action: 'keep', reason: `Git cannot read it, so it is kept: ${messageOf(error)}` };
  }
  if (!state.isLinkSafe) {
    return {
      ...base,
      action: 'keep',
      reason:
        "Its .malt is not a link to this project's memory, so prune never follows or deletes it; inspect it by hand.",
    };
  }
  const archive = `refs/malt/archive/prune/${base.id}`;
  const unused = 'No live delivery, attempt or terminal uses it';
  if (state.status !== '') {
    return {
      ...base,
      action: 'archive',
      archive,
      reason: `${unused}; its uncommitted changes go to ${archive} first.`,
    };
  }
  if (!state.isHeld) {
    const commit = state.head.slice(0, SHORT_SHA);
    return {
      ...base,
      action: 'archive',
      archive,
      reason: `${unused}; no ref holds commit ${commit}, so it goes to ${archive} first.`,
    };
  }
  return { ...base, action: 'remove', reason: `${unused}, and it has no uncommitted changes.` };
}

/**
 * Decide one candidate.
 *
 * @param context - Project Git, ledger and configuration.
 * @param candidate - Directory facts.
 * @param root - Canonical `.malt/worktrees`.
 * @param seen - Deliveries and attempts.
 * @returns The decision.
 */
async function decide(context: PruneContext, candidate: Candidate, root: string, seen: Holders): Promise<PruneEntry> {
  const { registration, record } = candidate;
  const isOwnedRoot = isInside(root, candidate.key);
  if (record === undefined || !isOwnedRoot) {
    return decideUnlisted(candidate, isOwnedRoot);
  }
  const owner = ownerOf(context, record, candidate.key, seen);
  const base = { id: record.id, directory: record.directory, kind: kindOf(record.id), owner: owner?.label ?? null };
  const verdict = gitVerdict(registration);
  if (verdict !== null) {
    return { ...base, ...verdict };
  }
  if (owner?.isLive === true) {
    return { ...base, action: 'keep', reason: `In use by ${owner.label}.` };
  }
  if (registration !== undefined) {
    return decideOrphan(context, base, registration);
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- A ledger directory inside this project's owned worktree root.
  return existsSync(record.directory)
    ? { ...base, action: 'keep', reason: 'Git does not register this folder as a worktree; inspect it by hand.' }
    : {
        ...base,
        action: 'remove',
        reason: 'Its folder is gone and Git no longer registers it; only the ledger entry is retired.',
      };
}

/**
 * Refuse removal while dispatch runs or another environment owns the worktrees.
 *
 * @param context - Project ledger and configuration.
 * @throws {MeshError} When removal is not safe now.
 */
function assertMayRemove(context: PruneContext): void {
  if (context.repository.active()) {
    throw new MeshError('FACTORY_GATED', 'Pause the factory before removing worktrees. A dry run works while it runs.');
  }
  const owner = readOwner(context.mesh);
  const here = currentEnvironment(context.mesh);
  if (owner !== null && (owner.root !== here.root || owner.platform !== here.platform)) {
    throw new MeshError(
      'FACTORY_GATED',
      `.malt/worktrees belongs to the environment at ${owner.root} (${owner.platform}); prune from there. No worktree was touched.`,
    );
  }
}

/**
 * Archive when needed, then remove one orphaned worktree through the owned removal.
 *
 * @param context - Project Git and owned worktrees.
 * @param entry - A `remove` or `archive` decision.
 * @returns What was done.
 */
async function retire(context: PruneContext, entry: PruneEntry): Promise<PruneEntry> {
  if (entry.action === 'archive' && entry.archive !== undefined) {
    await context.workspaces.archive(entry.directory, entry.archive);
  }
  if (!(await context.workspaces.remove(entry.directory))) {
    return { ...entry, action: 'keep', reason: 'It gained uncommitted changes after the report, so it was kept.' };
  }
  return { ...entry, action: entry.action === 'archive' ? 'archived' : 'removed' };
}

/**
 * Carry out one removable decision, repeating the ownership check first.
 *
 * @param context - Project Git, ledger and configuration.
 * @param planned - The dry-run decision.
 * @returns What was done; a failure keeps the worktree and says why.
 */
async function carryOut(context: PruneContext, planned: Planned): Promise<PruneEntry> {
  const { entry, record, key } = planned;
  if (entry.action === 'keep') {
    return entry;
  }
  const owner = record === undefined ? null : ownerOf(context, record, key, await holders(context));
  if (entry.action === 'prune') {
    // Git prunes the stale registration either way; a live owner keeps its ledger entry.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- A ledger directory inside this project's owned worktree root.
    if (record !== undefined && owner?.isLive !== true && !existsSync(record.directory)) {
      await context.workspaces.remove(record.directory);
    }
    return { ...entry, action: 'pruned' };
  }
  if (owner?.isLive === true) {
    return { ...entry, owner: owner.label, action: 'keep', reason: `In use by ${owner.label}.` };
  }
  try {
    return await retire(context, entry);
  } catch (error) {
    return { ...entry, action: 'keep', reason: `Removal failed, so it was kept: ${messageOf(error)}` };
  }
}

/**
 * Report every worktree and snapshot and, with `apply`, remove the removable ones.
 *
 * @param context - Project Git, ledger and configuration.
 * @param input - Untrusted prune control.
 * @returns Every entry with its owner, action and reason, and whether removal ran.
 * @throws {MeshError} When removal is requested while the factory runs or another environment owns the worktrees.
 */
export async function pruneWorktrees(context: PruneContext, input: unknown): Promise<PruneResult> {
  const { apply } = factorySchemas.factory_prune.parse(input);
  if (apply) {
    assertMayRemove(context);
  }
  const directory = path.join(context.mesh.directory, 'worktrees');
  const root = await identity(directory);
  const seen = await holders(context);
  const found = await candidates(context, directory);
  const plan: Planned[] = [];
  for (const candidate of found) {
    // eslint-disable-next-line no-await-in-loop -- Worktrees are inspected one at a time.
    const entry = await decide(context, candidate, root, seen);
    // Only ledger entries inside this environment's root are ever retired.
    plan.push({ entry, key: candidate.key, record: isInside(root, candidate.key) ? candidate.record : undefined });
  }
  if (!apply) {
    return { applied: false, entries: plan.map((item) => item.entry) };
  }
  const entries: PruneEntry[] = [];
  for (const item of plan) {
    // eslint-disable-next-line no-await-in-loop -- Destructive Git operations never race each other.
    entries.push(await carryOut(context, item));
  }
  await context.workspaces.git(['worktree', 'prune']);
  return { applied: true, entries };
}
