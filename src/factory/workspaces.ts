/**
 * Owned Git worktrees and branch lifecycle. The primary checkout is never
 * reset or cleaned. Snapshot reviewers cannot submit edits; cleanup refuses
 * dirty trees and preserves verified source commits under archive refs.
 *
 * @file
 */

import { existsSync, mkdirSync } from 'node:fs';
import { symlink, lstat, realpath, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod/v3';

import { readJsonFile } from '../config.ts';
import { hasErrorCode } from '../errors.ts';
import { MeshError } from '../protocol.ts';
import { writeAtomic } from '../summary.ts';

import { command } from './commands.ts';
import { assertPublicationSize } from './publication-size.ts';

import type { MeshConfig } from '../config.ts';
import type { FactoryConfig, FactoryTask } from './schema.ts';

/**
 * Compare canonical Git paths using the host's case rules.
 *
 * @param value - Git or configured root path.
 * @returns Normalized root identity.
 */
async function normalize(value: string): Promise<string> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Callers compare only configured project roots and native Git/worktree paths.
  const canonical = await realpath(value);
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

/**
 * Validate an owned memory link before use or nonrecursive retirement.
 *
 * @param link - Generated owned worktree link.
 * @param target - Canonical selected project memory.
 * @throws {MeshError} For a foreign or ordinary-directory memory link.
 */
async function verifyMemoryLink(link: string, target: string): Promise<void> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Caller supplies only an owned worktree's generated .malt link.
  const info = await lstat(link);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Resolve the same generated link to prove its target before retirement.
  const actual = await realpath(link);
  if (!info.isSymbolicLink() || (await normalize(actual)) !== (await normalize(target))) {
    throw new MeshError('INVALID_INPUT', 'The worktree memory link must point to this project .malt.');
  }
}
/** Named branch id length bound. */
const BRANCH_ID_LENGTH = 8;

/** Ownership evidence for each worktree, retained after cleanup. */
const ownershipSchema = z.array(
  z.object({ id: z.string(), directory: z.string(), branch: z.string().nullable(), removed: z.boolean() }),
);
/** An owned snapshot whose source fingerprint must remain unchanged. */
export interface SourceSnapshot {
  /** Owned isolated directory. */
  readonly directory: string;
  /** Exact checked-out commit. */
  readonly head: string;
  /** Status before running checks/model review. */
  readonly status: string;
}

/** Project-local worktree manager using shell-free Git commands. */
export class WorkspaceManager {
  /** Workspace-local paths. */
  private readonly mesh: MeshConfig;
  /** Delivery policies and branch names. */
  private readonly config: FactoryConfig;
  /** Ownership ledger location. */
  private readonly ledger: string;

  /**
   * Prepare repository operations without touching the primary checkout.
   *
   * @param mesh - Target project.
   * @param config - Factory settings.
   */
  public constructor(mesh: MeshConfig, config: FactoryConfig) {
    this.mesh = mesh;
    this.config = config;
    this.ledger = path.join(mesh.directory, 'factory', 'worktrees.json');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Prepare only the selected project's fixed owned-worktree ledger directory.
    mkdirSync(path.dirname(this.ledger), { recursive: true, mode: 0o700 });
  }

  /**
   * Run Git with argument boundaries intact.
   *
   * @param args - Literal Git arguments.
   * @param cwd - Worktree or primary repository, which is never reset.
   * @returns Git standard output.
   */
  public async git(args: readonly string[], cwd = this.mesh.root): Promise<string> {
    return command('git', args, cwd);
  }

  /**
   * Read the original repository's origin URL for project connection validation.
   *
   * @returns Configured remote URL.
   * @throws {MeshError} When factory setup is attempted in a nested folder.
   */
  public async origin(): Promise<string> {
    const root = await this.git(['rev-parse', '--show-toplevel']);
    if ((await normalize(root)) !== (await normalize(this.mesh.root))) {
      throw new MeshError('INVALID_INPUT', 'Configure the factory in the Git repository root.');
    }
    await this.assertPrivateStateUntracked();
    return this.git(['remote', 'get-url', this.config.remote]);
  }

  /**
   * Refuse to publish private runtime state even if it was tracked or force-staged earlier.
   *
   * @param cwd - Selected repository or an owned developer checkout.
   * @throws {MeshError} When the Git index contains project operational memory.
   */
  public async assertPrivateStateUntracked(cwd = this.mesh.root): Promise<void> {
    const tracked = await this.git(['ls-files', '--', ':(icase).malt', ':(icase).mlt'], cwd);
    if (tracked !== '') {
      throw new MeshError(
        'FACTORY_GATED',
        'Git is tracking .malt runtime state. Remove it from tracking before dispatch or publication; rotate any previously exposed secrets.',
      );
    }
  }

  /**
   * Fetch current main without pulling into the user's primary working tree.
   *
   * @returns Latest remote base commit.
   */
  public async base(): Promise<string> {
    if (this.config.baseBranch.startsWith('malt/terminal/')) {
      throw new MeshError('FACTORY_GATED', 'A terminal scratch branch cannot be a delivery base.');
    }
    await this.git([
      'fetch',
      this.config.remote,
      `+refs/heads/${this.config.baseBranch}:refs/remotes/${this.config.remote}/${this.config.baseBranch}`,
    ]);
    return this.git(['rev-parse', `refs/remotes/${this.config.remote}/${this.config.baseBranch}`]);
  }

  /**
   * Create or resume an owned worktree and link its shared project memory.
   *
   * @param id - Internal task/job key.
   * @param reference - Exact commit, or fetched base reference.
   * @param branch - New developer branch; null for a read-only snapshot.
   * @param isMemoryShared - Managed assignments share memory; operator scratch terminals never do.
   * @returns Owned directory.
   * @throws {MeshError} If another directory or branch is encountered.
   */
  public async create(id: string, reference: string, branch: string | null, isMemoryShared = true): Promise<string> {
    if (!/^[\d\-a-z]+$/v.test(id)) {
      throw new MeshError('INVALID_INPUT', 'Unsafe worktree key.');
    }
    const directory = path.join(this.mesh.directory, 'worktrees', id);
    this.assertOwnedPath(directory);
    const records = this.ownership();
    const previous = records.find((entry) => entry.id === id && !entry.removed);
    if (previous === undefined) {
      // Record intent before Git so interrupted creation can be recognized.
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Owned project-local worktree parent.
      mkdirSync(path.dirname(directory), { recursive: true, mode: 0o700 });
      writeAtomic(
        this.ledger,
        `${JSON.stringify([...records.filter((entry) => entry.id !== id), { id, directory, branch, removed: false }], null, 2)}\n`,
      );
    } else if (previous.directory !== directory || previous.branch !== branch) {
      throw new MeshError('INVALID_INPUT', 'Worktree ownership does not match this assignment.');
    }
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Check only the generated owned target.
    if (!existsSync(directory)) {
      const args =
        branch === null
          ? ['worktree', 'add', '--detach', directory, reference]
          : ['worktree', 'add', '-b', branch, directory, reference];
      await this.git(args);
    }
    const common = await this.git(['rev-parse', '--path-format=absolute', '--git-common-dir'], directory);
    const original = await this.git(['rev-parse', '--path-format=absolute', '--git-common-dir']);
    if ((await normalize(common)) !== (await normalize(original))) {
      throw new MeshError('INVALID_INPUT', 'The recorded worktree belongs to another repository.');
    }
    await this.attachMemory(directory, isMemoryShared);
    // Every worktree uses this repository's shared local exclude file. Do not
    // commit credentials or recursively add the linked memory directory.
    const exclude = path.join(original, 'info', 'exclude');
    let contents = '';
    try {
      const { readFileSync } = await import('node:fs');

      contents = readFileSync(exclude, 'utf8');
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) {
        throw error;
      }
    }
    const existing = new Set(contents.split('\n').map((line) => line.trim()));
    // Directory-only rules do not ignore the memory symlink on Unix.
    const missing = ['.malt', '.malt/', '.mlt', '.mlt/'].filter((rule) => !existing.has(rule));
    if (missing.length > 0) {
      writeAtomic(exclude, `${contents}\n${missing.join('\n')}\n`);
    }
    return directory;
  }

  /**
   * Retained terminal trees come from ownership records, never a bounded history page.
   *
   * @returns Owned terminal worktrees, oldest intent first.
   */
  public terminalTrees(): z.output<typeof ownershipSchema> {
    return this.ownership().filter(
      (record) =>
        !record.removed && record.id.startsWith('terminal-') && record.branch?.startsWith('malt/terminal/') === true,
    );
  }

  /**
   * Capture source identity around a review or validation step.
   *
   * @param directory - Owned worktree.
   * @returns Commit and unignored status.
   */
  public async snapshot(directory: string): Promise<SourceSnapshot> {
    return {
      directory,
      head: await this.git(['rev-parse', 'HEAD'], directory),
      status: await this.git(['status', '--porcelain', '--untracked-files=all'], directory),
    };
  }

  /**
   * Enforce that QA and final verification did not edit the implementation.
   *
   * @param snapshot - Pinned source identity.
   * @throws {MeshError} When source files or the checked-out head changed.
   */
  public async assertUnchanged(snapshot: SourceSnapshot): Promise<void> {
    const current = await this.snapshot(snapshot.directory);
    if (current.head !== snapshot.head || current.status !== snapshot.status || current.status !== '') {
      throw new MeshError(
        'FACTORY_GATED',
        'A review/verification process changed source files. Its approval is invalid; QA must report defects rather than implement fixes.',
      );
    }
  }

  /**
   * Prepare the original developer's branch, preserving unfinished edits.
   *
   * @param task - Current delivery.
   * @returns Directory, branch and freshly fetched base.
   */
  public async developer(task: FactoryTask): Promise<{ directory: string; branch: string; base: string }> {
    this.assertDeliveryTask(task);
    const base = await this.base();
    const branch =
      task.branch ?? `malt/issue-${String(task.issue)}-${task.id.slice(0, BRANCH_ID_LENGTH)}-${String(task.version)}`;
    const directory = task.worktree ?? (await this.create(`${task.id}-dev-${String(task.version)}`, base, branch));
    this.assertOwnedPath(directory);
    const snapshot = await this.snapshot(directory);
    if (snapshot.status === '') {
      try {
        await this.git(['merge', '--no-edit', base], directory);
      } catch {
        /* Retain merge conflicts for the responsible developer to resolve. */
      }
    }
    return { directory, branch, base };
  }

  /**
   * Commit completed edits, refresh main, bound scope and publish the branch.
   *
   * @param task - Original developer assignment with an owned worktree.
   * @param beforePush - Verify the refreshed source and commit its durable publication checkpoint.
   * @returns Current head/base and diff summary.
   * @throws {MeshError} For empty or oversized deliveries.
   */
  public async publish(
    task: FactoryTask,
    beforePush: (source: { head: string; base: string }) => Promise<void>,
  ): Promise<{ head: string; base: string; diff: string }> {
    this.assertDeliveryTask(task);
    const record = task;
    if (record.worktree === null || record.branch === null) {
      throw new MeshError('FACTORY_GATED', 'The delivery has no owned developer worktree.');
    }
    const directory = record.worktree;
    const status = await this.git(['status', '--porcelain', '--untracked-files=all'], directory);
    if (status !== '') {
      await this.git(['add', '--all'], directory);
      await this.assertPrivateStateUntracked(directory);
      await this.git(['commit', '-m', `Deliver #${String(record.issue)}: ${record.title}`], directory);
    }
    const base = await this.base();
    await this.git(['merge', '--no-edit', base], directory);
    await this.assertPrivateStateUntracked(directory);
    const head = await this.git(['rev-parse', 'HEAD'], directory);
    await this.assertDeliveryHead(head, base);
    const diff = await this.git(['diff', '--numstat', `${base}...${head}`], directory);
    const entries = diff === '' ? [] : diff.split('\n');
    let lines = 0;
    for (const entry of entries) {
      for (const value of entry.split('\t', 2)) {
        const parsed = Number(value);
        lines += Number.isFinite(parsed) ? parsed : 0;
      }
    }
    if (entries.length === 0) {
      throw new MeshError(
        'FACTORY_GATED',
        'The delivery diff is empty. Reconcile already-delivered work before implementation.',
      );
    }
    await beforePush({ head, base });
    assertPublicationSize({ head, base, files: entries.length, lines }, this.config, task.sizeApproval);
    await this.git(['push', '--set-upstream', this.config.remote, record.branch], directory);
    return { head, base, diff };
  }

  /**
   * Retry only a previously validated unchanged branch after an ambiguous push.
   *
   * @param task - Durable publication checkpoint.
   * @throws {MeshError} For changed or missing owned source.
   */
  public async retryPublication(task: FactoryTask): Promise<void> {
    this.assertDeliveryTask(task);
    if (task.worktree === null || task.branch === null || task.head === null) {
      throw new MeshError('FACTORY_GATED', 'Publication needs an owned validated branch checkpoint.');
    }
    this.assertOwnedPath(task.worktree);
    const source = await this.snapshot(task.worktree);
    const branch = await this.git(['branch', '--show-current'], task.worktree);
    if (source.status !== '' || source.head !== task.head || branch !== task.branch) {
      throw new MeshError('FACTORY_GATED', 'The validated branch changed; preserve it for developer repair.');
    }
    await this.assertDeliveryHead(source.head, await this.base());
    await this.git(['push', '--set-upstream', this.config.remote, task.branch], task.worktree);
  }

  /**
   * Prove that a merged commit exists on the fetched main history.
   *
   * @param merge - GitHub-confirmed merge commit.
   * @param base - Fetched main commit.
   */
  public async contains(merge: string, base: string): Promise<void> {
    await this.git(['merge-base', '--is-ancestor', merge, base]);
  }

  /**
   * Safely retire one owned snapshot; uncommitted work is never discarded.
   *
   * @param directory - Registry-owned directory.
   * @returns Whether it was removed, false when dirty.
   */
  public async remove(directory: string): Promise<boolean> {
    this.assertOwnedPath(directory);
    const records = this.ownership();
    const record = records.find((entry) => entry.directory === directory && !entry.removed);
    if (record === undefined) {
      throw new MeshError('INVALID_INPUT', 'Cleanup requires an owned worktree record.');
    }
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Verified absolute path under this project's owned worktree root.
    if (existsSync(directory)) {
      const snapshot = await this.snapshot(directory);
      if (snapshot.status !== '') {
        return false;
      }
      const link = path.join(directory, '.malt');
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Unlink only the verified junction/symlink itself, never its canonical shared-memory target.
      if (existsSync(link)) {
        await verifyMemoryLink(link, this.mesh.directory);

        if (process.platform === 'win32') {
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- Remove only the verified owned junction itself, without recursion into its target.
          await rmdir(link);
        } else {
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- Remove only the verified owned symbolic link itself.
          await unlink(link);
        }
      }
      await this.git(['worktree', 'remove', directory]);
    }
    writeAtomic(
      this.ledger,
      `${JSON.stringify(
        this.ownership().map((entry) => (entry.directory === directory ? { ...entry, removed: true } : entry)),
        null,
        2,
      )}\n`,
    );
    return true;
  }

  /**
   * Clean verified delivery resources while retaining history and changed branches.
   *
   * @param task - Verified delivery or explicitly superseded scope with confirmed remote retirement.
   * @returns Cleanup result suitable for the final report.
   */
  public async cleanup(task: FactoryTask): Promise<string> {
    const record = task;
    if (record.worktree === null) {
      return 'No developer resources need cleanup.';
    }
    if (
      record.branch === null ||
      record.head === null ||
      (record.merge === null && record.scopeReplacement === undefined)
    ) {
      return 'Preserved developer worktree because confirmed retired source identity is unavailable.';
    }
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Idempotent cleanup inspects only the verified project-owned worktree path.
    if (existsSync(record.worktree)) {
      const current = await this.snapshot(record.worktree);
      if (current.head !== record.head || current.status !== '') {
        return 'Preserved developer worktree because it contains newer or uncommitted work.';
      }
    }
    await this.git(['update-ref', `refs/malt/archive/${record.id}-${record.head}`, record.head]);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- A previously removed tree needs no second destructive operation.
    if (existsSync(record.worktree) && !(await this.remove(record.worktree))) {
      return 'Preserved dirty developer worktree.';
    }
    const remote = await this.git(['ls-remote', '--heads', this.config.remote, `refs/heads/${record.branch}`]);
    if (remote !== '' && remote.split('\t', 1)[0] === record.head) {
      await this.git([
        'push',
        `--force-with-lease=refs/heads/${record.branch}:${record.head}`,
        this.config.remote,
        `:refs/heads/${record.branch}`,
      ]);
    }
    const local = await this.git(['for-each-ref', '--format=%(objectname)', `refs/heads/${record.branch}`]);
    if (local === record.head) {
      await this.git(['update-ref', '-d', `refs/heads/${record.branch}`, record.head]);
    }
    return 'Removed retired worktree and unchanged delivery branches; archived source commit retained.';
  }

  /**
   * Read the local ownership ledger.
   *
   * @returns Worktree records, including removed snapshots.
   * @throws {Error} For invalid project state or failed execution.
   */
  private ownership(): z.output<typeof ownershipSchema> {
    try {
      return ownershipSchema.parse(readJsonFile(this.ledger));
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) {
        return [];
      }
      throw error;
    }
  }

  /**
   * Operator scratch resources cannot become a managed delivery assignment.
   *
   * @param task - Durable developer scope.
   * @throws {MeshError} For a terminal branch/tree or a foreign owned path.
   */
  private assertDeliveryTask(task: FactoryTask): void {
    if (task.worktree !== null) {
      this.assertOwnedPath(task.worktree);
    }
    const isTerminal = this.ownership().some(
      (record) => record.id.startsWith('terminal-') && record.directory === task.worktree,
    );
    if (isTerminal || task.branch?.startsWith('malt/terminal/') === true) {
      throw new MeshError('FACTORY_GATED', 'Terminal scratch work cannot be adopted as a delivery branch or worktree.');
    }
  }

  /**
   * Reject operator-only commits even when copied onto a developer branch.
   *
   * @param head - Actual Git head about to be published.
   * @param base - Fresh remote delivery base.
   * @throws {MeshError} For a terminal-exclusive source head.
   */
  private async assertDeliveryHead(head: string, base: string): Promise<void> {
    const all = await this.git(['rev-list', '--count', head, `^${base}`]);
    if (all === '0') {
      return;
    }
    const independent = await this.git([
      'rev-list',
      '--count',
      head,
      `^${base}`,
      '--not',
      '--branches=malt/terminal/*',
      '--glob=refs/malt/archive/terminal-*',
    ]);
    if (independent !== all) {
      throw new MeshError('FACTORY_GATED', 'A terminal-only commit cannot satisfy a delivery head.');
    }
  }

  /**
   * Only managed assignments receive the private project memory link.
   *
   * @param directory - Owned Git checkout.
   * @param isShared - Whether this checkout is a managed assignment.
   */
  private async attachMemory(directory: string, isShared: boolean): Promise<void> {
    if (!isShared) {
      return;
    }
    const link = path.join(directory, '.malt');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Inspect only the generated owned memory link.
    if (!existsSync(link)) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Only managed assignments link the verified project's memory.
      await symlink(this.mesh.directory, link, process.platform === 'win32' ? 'junction' : 'dir');
    }
    await verifyMemoryLink(link, this.mesh.directory);
  }

  /**
   * Ensure a generated worktree path remains inside this project's .malt.
   *
   * @param directory - Generated or recorded worktree directory.
   * @throws {MeshError} For an unsafe or foreign cleanup target.
   */
  private assertOwnedPath(directory: string): void {
    const relative = path.relative(path.join(this.mesh.directory, 'worktrees'), path.resolve(directory));
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new MeshError(
        'INVALID_INPUT',
        "Worktree operations must stay inside this project's owned .malt/worktrees directory.",
      );
    }
  }
}
