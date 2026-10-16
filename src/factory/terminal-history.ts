/** @file Retain rewritten scratch ancestry before publication or branch retirement. */
import { MeshError } from '../protocol.ts';

/** Bound Git work and fail closed rather than silently ignoring older history. */
const HISTORY_LIMIT = 256;
/** Shell-free repository operation owned by the worktree manager. */
type Git = (args: readonly string[], cwd?: string) => Promise<string>;

/**
 * Pin retained terminal reflog heads under content-addressed private Git refs.
 *
 * @param git - Selected repository Git boundary.
 * @param worktrees - Existing registry-owned scratch trees, including detached HEAD history.
 * @throws {MeshError} If scratch history cannot be inspected completely within bounds.
 */
export async function retainTerminalHistory(git: Git, worktrees: readonly string[]): Promise<void> {
  const listing = await git(['for-each-ref', '--format=%(refname)', 'refs/heads/malt/terminal/']);
  const references = [
    ...listing
      .split('\n')
      .filter(Boolean)
      .map((reference) => ({ reference, cwd: undefined })),
    ...worktrees.map((cwd) => ({ reference: 'HEAD', cwd })),
  ];
  if (references.length > HISTORY_LIMIT) {
    throw new MeshError('FACTORY_GATED', 'Terminal history exceeds the bounded isolation audit.');
  }
  const heads = new Set<string>();
  for (const { reference, cwd } of references) {
    // eslint-disable-next-line no-await-in-loop -- Inspect each bounded terminal reflog before allowing publication or retirement.
    const log = await git(
      ['reflog', 'show', `--max-count=${String(HISTORY_LIMIT + 1)}`, '--format=%H', reference],
      cwd,
    );
    const entries = log.split('\n').filter(Boolean);
    if (entries.length === 0 || entries.length > HISTORY_LIMIT) {
      throw new MeshError('FACTORY_GATED', 'Terminal reflog is unavailable or exceeds the bounded isolation audit.');
    }
    for (const head of entries) {
      if (!/^(?:[\da-f]{40}|[\da-f]{64})$/v.test(head)) {
        throw new MeshError('FACTORY_GATED', 'Terminal history contains an invalid commit identity.');
      }
      heads.add(head);
    }
    if (heads.size > HISTORY_LIMIT) {
      throw new MeshError('FACTORY_GATED', 'Terminal history exceeds the bounded isolation audit.');
    }
  }
  const archived = await git(['for-each-ref', '--format=%(objectname)', 'refs/malt/archive/terminal-history-*']);
  const retained = new Set(archived.split('\n').filter(Boolean));
  for (const head of heads) {
    if (!retained.has(head)) {
      // eslint-disable-next-line no-await-in-loop -- Preserve each content-addressed commit before a branch/reflog can be retired.
      await git(['update-ref', `refs/malt/archive/terminal-history-${head}`, head]);
    }
  }
}
