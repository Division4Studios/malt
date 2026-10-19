/**
 * Project-private bare Git hub that replaces a hosted remote for local delivery.
 * Developer branches are pushed to it exactly as to GitHub. Its base branch is
 * protected by a receive hook, so only a reviewed squash merge, written with Git
 * plumbing and an atomic expected-old compare-and-swap, can advance it. The
 * operator's own checkout is never reset or rewritten.
 *
 * @file
 */

import { existsSync, mkdirSync } from 'node:fs';
import { chmod, open, realpath } from 'node:fs/promises';
import path from 'node:path';

import { MeshError } from '../protocol.ts';
import { writeAtomic } from '../summary.ts';

import { command } from './commands.ts';

/** Full-width zero object ID Git uses for created or deleted refs. */
const ZERO = /^0+$/v;
/** Trailer recording the merged pull request in each hub merge commit. */
const PULL_TRAILER = 'MALT-Pull';
/** Trailer recording the exact reviewed head in each hub merge commit. */
const HEAD_TRAILER = 'MALT-Head';
/** Recent base history scanned to recognize an interrupted merge. */
const RECOVERY_DEPTH = 200;
/** Owner-only, executable hook mode; Git silently skips hooks without the execute bit on POSIX. */
const HOOK_MODE = 0o700;
/** Owner execute bit Git requires before it runs a hook on POSIX. */
const OWNER_EXECUTE = 0o100;
/** Hub-local hook directory, relative to the bare repository where Git runs receive hooks. */
const HOOKS_PATH = 'hooks';

/**
 * Read a hook's text only if Git would execute it. One handle supplies both the
 * mode and the text, so the file checked is the file read.
 *
 * @param file - Hook path.
 * @returns Hook text, or null when Git would skip the hook.
 */
async function executableText(file: string): Promise<string | null> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixed hook path inside the private hub.
  await using handle = await open(file, 'r');
  const stats = await handle.stat();
  // Git for Windows does not check the execute bit, so only POSIX requires it.
  const isExecutable = process.platform === 'win32' || Math.floor(stats.mode / OWNER_EXECUTE) % 2 === 1;
  return isExecutable ? await handle.readFile('utf8') : null;
}

/** Git boundary, injectable for failure tests. */
export type HubGit = (args: readonly string[], cwd: string) => Promise<string>;

/**
 * Receive hook that protects the base branch from every push.
 *
 * @param base - Validated base branch name.
 * @returns POSIX shell hook text, also executed by Git for Windows.
 */
export function protectionHook(base: string): string {
  return [
    '#!/bin/sh',
    '# MALT local hub protection. Base advances only through reviewed local merges.',
    'while read old new ref; do',
    `  if [ "$ref" = "refs/heads/${base}" ]; then`,
    `    echo "MALT hub: ${base} is protected; merge through a reviewed local pull request." >&2`,
    '    exit 1',
    '  fi',
    'done',
    'exit 0',
    '',
  ].join('\n');
}

/**
 * Compare filesystem paths using the host's case rules.
 *
 * @param value - Existing path.
 * @returns Canonical comparable path.
 */
async function canonical(value: string): Promise<string> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Only the configured remote URL and the project's own hub path are compared.
  const resolved = await realpath(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Outcome of previewing a pull request against the current base. */
export interface MergePreview {
  /** Current base tip. */
  readonly base: string;
  /** Current branch head, null when the branch no longer exists. */
  readonly head: string | null;
  /** Base is already contained in head. */
  readonly upToDate: boolean;
  /** A merge would produce no conflicts. */
  readonly mergeable: boolean;
}

/** One project's local hub repository. */
export class LocalHub {
  /** Bare repository directory. */
  public readonly directory: string;
  /** Protected base branch. */
  private readonly base: string;
  /** Git boundary. */
  private readonly git: HubGit;

  /**
   * Bind a hub inside the project's private local delivery directory.
   *
   * @param local - The project's `.malt/local` directory.
   * @param base - Protected base branch.
   * @param git - Git boundary.
   */
  public constructor(local: string, base: string, git: HubGit = async (args, cwd) => command('git', args, cwd)) {
    this.directory = path.join(local, 'hub.git');
    this.base = base;
    this.git = git;
  }

  /**
   * Create the hub from the project's base branch, register it as a remote and protect it.
   * Repeating this is safe; an existing hub keeps its history.
   *
   * @param project - Primary repository root.
   * @param remote - Remote name to register in the project.
   * @returns Whether the hub was newly created.
   * @throws {MeshError} When the remote name already points elsewhere.
   */
  public async initialize(project: string, remote: string): Promise<boolean> {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixed hub path under the selected project's private state.
    const isNew = !existsSync(path.join(this.directory, 'HEAD'));
    if (isNew) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixed hub path under the selected project's private state.
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      await this.git(['init', '--bare', '--initial-branch', this.base, this.directory], project);
    }
    const listed = await this.git(['remote'], project);
    const remotes = listed.split('\n');
    if (remotes.includes(remote)) {
      const url = await this.git(['remote', 'get-url', remote], project);
      if (!(await this.isHub(url))) {
        throw new MeshError(
          'INVALID_INPUT',
          `Remote "${remote}" already points elsewhere. Choose another local delivery remote name.`,
        );
      }
    } else {
      await this.git(['remote', 'add', remote, this.directory], project);
    }
    if (isNew || (await this.tip()) === null) {
      await this.git(['push', remote, `refs/heads/${this.base}:refs/heads/${this.base}`], project);
    }
    await this.protect();
    return isNew;
  }

  /**
   * Prove the configured remote is this hub, its base exists and protection is intact.
   *
   * @param url - The project's configured delivery remote URL.
   * @param requiresProtection - Whether the receive hook must be present.
   * @throws {MeshError} When any local delivery prerequisite is missing.
   */
  public async verify(url: string, requiresProtection: boolean): Promise<void> {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixed hub path under the selected project's private state.
    if (!existsSync(path.join(this.directory, 'HEAD'))) {
      throw new MeshError(
        'FACTORY_GATED',
        'The local delivery hub does not exist. Pause the factory and apply a policy with "delivery": "local" (factory-setup or Project setup) to create it.',
      );
    }
    if (!(await this.isHub(url))) {
      throw new MeshError('WRONG_PROJECT', 'The factory remote must point at this project’s local delivery hub.');
    }
    if ((await this.git(['rev-parse', '--is-bare-repository'], this.directory)) !== 'true') {
      throw new MeshError('FACTORY_GATED', 'The local delivery hub must be a bare repository.');
    }
    if ((await this.tip()) === null) {
      throw new MeshError('FACTORY_GATED', `The local delivery hub has no ${this.base} branch.`);
    }
    if (requiresProtection && !(await this.isProtected())) {
      throw new MeshError(
        'FACTORY_GATED',
        `The local hub ${this.base} branch protection hook is missing, modified or not executable. Pause the factory and re-apply its policy (factory-setup or Project setup) to restore it.`,
      );
    }
  }

  /**
   * Read the current protected base tip.
   *
   * @returns Commit ID, null before the base exists.
   */
  public async tip(): Promise<string | null> {
    return this.ref(`refs/heads/${this.base}`);
  }

  /**
   * Read one branch head.
   *
   * @param branch - Branch name.
   * @returns Commit ID, null when absent.
   */
  public async head(branch: string): Promise<string | null> {
    return this.ref(`refs/heads/${branch}`);
  }

  /**
   * Compare a branch with the current base without touching any working tree.
   *
   * @param branch - Pull-request branch.
   * @returns Freshness and conflict evidence.
   * @throws {MeshError} When the base is missing.
   */
  public async preview(branch: string): Promise<MergePreview> {
    const base = await this.tip();
    if (base === null) {
      throw new MeshError('FACTORY_GATED', `The local delivery hub has no ${this.base} branch.`);
    }
    const head = await this.head(branch);
    if (head === null) {
      return { base, head, upToDate: false, mergeable: false };
    }
    const isUpToDate = await this.contains(head, base);
    return { base, head, upToDate: isUpToDate, mergeable: isUpToDate || (await this.tree(base, head)) !== null };
  }

  /**
   * Find a merge of this exact pull request and head already on the base.
   *
   * @param pull - Pull-request number.
   * @param head - Reviewed head.
   * @returns The merge commit, null when none exists.
   */
  public async findMerge(pull: number, head: string): Promise<string | null> {
    const log = await this.git(
      [
        'log',
        `-${String(RECOVERY_DEPTH)}`,
        '--format=%H%x00%B%x01',
        '--fixed-strings',
        `--grep=${PULL_TRAILER}: ${String(pull)}`,
        `refs/heads/${this.base}`,
      ],
      this.directory,
    );
    for (const entry of log.split('\u{1}')) {
      const [commit, body] = entry.trim().split('\0', 2);
      if (
        commit !== undefined &&
        body?.includes(`${PULL_TRAILER}: ${String(pull)}\n`) === true &&
        body.includes(`${HEAD_TRAILER}: ${head}`)
      ) {
        return commit;
      }
    }
    return null;
  }

  /**
   * Squash-merge an exact reviewed head onto the expected base with an atomic ref swap.
   *
   * @param merge - Pull request identity, reviewed head, expected base and message.
   * @returns The new base commit.
   * @throws {MeshError} For a moved head or base, conflicts or a lost compare-and-swap.
   */
  public async squash(merge: {
    readonly pull: number;
    readonly branch: string;
    readonly head: string;
    readonly base: string;
    readonly title: string;
    readonly body: string;
  }): Promise<string> {
    const previous = await this.findMerge(merge.pull, merge.head);
    if (previous !== null) {
      return previous;
    }
    if ((await this.head(merge.branch)) !== merge.head) {
      throw new MeshError('FACTORY_GATED', 'The local pull request head changed after review.');
    }
    if ((await this.tip()) !== merge.base) {
      throw new MeshError(
        'FACTORY_GATED',
        `The local ${this.base} branch advanced after review; refresh the delivery.`,
      );
    }
    const tree = await this.tree(merge.base, merge.head);
    if (tree === null) {
      throw new MeshError('FACTORY_GATED', 'The local pull request conflicts with the current base.');
    }
    const identity = await this.git(['log', '-1', '--format=%an%x00%ae', merge.head], this.directory);
    const [name = 'MALT', email = 'malt@localhost'] = identity.split('\0', 2);
    const message = `${merge.title} (#${String(merge.pull)})\n\n${merge.body}\n\n${PULL_TRAILER}: ${String(merge.pull)}\n${HEAD_TRAILER}: ${merge.head}\n`;
    const commit = await this.git(
      ['-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit-tree', tree, '-p', merge.base, '-m', message],
      this.directory,
    );
    try {
      await this.git(['update-ref', `refs/heads/${this.base}`, commit, merge.base], this.directory);
    } catch (error) {
      throw new MeshError('FACTORY_GATED', `The local ${this.base} branch moved during merge; nothing was changed.`, {
        cause: error,
      });
    }
    return commit;
  }

  /**
   * Produce a unified diff between a merge base and a branch for operator review.
   *
   * @param base - Base commit.
   * @param head - Head commit.
   * @returns Diff text.
   */
  public async diff(base: string, head: string): Promise<string> {
    return this.git(['diff', '--no-color', '--no-ext-diff', `${base}...${head}`], this.directory);
  }

  /**
   * Determine whether a remote URL names this hub.
   *
   * @param url - Remote URL.
   * @returns Whether both paths resolve to the same directory.
   */
  private async isHub(url: string): Promise<boolean> {
    try {
      return (await canonical(url)) === (await canonical(this.directory));
    } catch {
      return false;
    }
  }

  /**
   * Install or restore the protection hook, and pin Git's hook directory to it.
   * A global or system `core.hooksPath` would otherwise make Git run hooks from
   * elsewhere and skip this one; the repository-local setting takes precedence.
   */
  private async protect(): Promise<void> {
    const hook = path.join(this.directory, 'hooks', 'pre-receive');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixed hook directory inside the private hub.
    mkdirSync(path.dirname(hook), { recursive: true, mode: 0o700 });
    writeAtomic(hook, protectionHook(this.base));
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixed hook path inside the private hub.
    await chmod(hook, HOOK_MODE);
    await this.git(['config', '--local', 'core.hooksPath', HOOKS_PATH], this.directory);
  }

  /**
   * Check that the exact protection hook is installed and Git will run it.
   *
   * @returns Whether the hook matches, Git's effective hook directory is the hub's own and Git can execute it.
   */
  private async isProtected(): Promise<boolean> {
    const hook = path.join(this.directory, 'hooks', 'pre-receive');
    try {
      const hooksPath = await this.git(['config', '--get', 'core.hooksPath'], this.directory);
      return hooksPath === HOOKS_PATH && (await executableText(hook)) === protectionHook(this.base);
    } catch {
      return false;
    }
  }

  /**
   * Resolve a ref without failing for absent ones.
   *
   * @param reference - Full ref name.
   * @returns Commit ID or null.
   */
  private async ref(reference: string): Promise<string | null> {
    try {
      const value = await this.git(['rev-parse', '--verify', '--quiet', `${reference}^0`], this.directory);
      return value === '' || ZERO.test(value) ? null : value;
    } catch {
      return null;
    }
  }

  /**
   * Check ancestry.
   *
   * @param descendant - Possible descendant.
   * @param ancestor - Possible ancestor.
   * @returns Whether ancestor is contained in descendant.
   */
  private async contains(descendant: string, ancestor: string): Promise<boolean> {
    try {
      await this.git(['merge-base', '--is-ancestor', ancestor, descendant], this.directory);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Compute the merged tree without a working tree.
   *
   * @param base - Base commit.
   * @param head - Head commit.
   * @returns Tree ID, null when the merge conflicts.
   */
  private async tree(base: string, head: string): Promise<string | null> {
    try {
      const output = await this.git(['merge-tree', '--write-tree', '--no-messages', base, head], this.directory);
      return output.split('\n', 1)[0] ?? null;
    } catch {
      return null;
    }
  }
}
