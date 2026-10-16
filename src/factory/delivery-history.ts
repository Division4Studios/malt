/** @file Supervisor-created commit receipts, independent of terminal refs and reflog expiry. */
import { MeshError } from '../protocol.ts';

/** Fail closed rather than truncate an unexpectedly large commit history. */
const MAX_COMMITS = 256;
/** Selected repository's bounded shell-free Git boundary. */
type Git = (args: readonly string[]) => Promise<string>;

/**
 * Preserve an exact supervisor-created commit, scoped to its durable delivery.
 *
 * @param git - Selected repository.
 * @param taskId - Validated internal delivery UUID.
 * @param head - Actual commit created by the supervisor's Git command.
 */
export async function recordDeliveryCommit(git: Git, taskId: string, head: string): Promise<void> {
  await git(['update-ref', `refs/malt/delivery/${taskId}/${head}`, head]);
}

/**
 * Require exact receipts for new commits; observing a terminal checkout grants none.
 *
 * @param git - Selected repository.
 * @param source - Actual source and previously validated durable checkpoint.
 * @throws {MeshError} For unreceipted commits, including rewritten operator history.
 */
export async function assertDeliveryHistory(
  git: Git,
  source: { taskId: string; head: string; base: string; checkpoint: string | null },
): Promise<void> {
  const listing = await git([
    'rev-list',
    `--max-count=${String(MAX_COMMITS + 1)}`,
    source.head,
    `^${source.base}`,
    ...(source.checkpoint === null ? [] : [`^${source.checkpoint}`]),
  ]);
  const commits = listing.split('\n').filter(Boolean);
  if (commits.length > MAX_COMMITS) {
    throw new MeshError('FACTORY_GATED', 'Delivery history exceeds the bounded source receipt audit.');
  }
  const receipts = await git([
    'for-each-ref',
    '--format=%(refname) %(objectname)',
    `refs/malt/delivery/${source.taskId}/`,
  ]);
  const recorded = new Set(receipts.split('\n'));
  if (commits.some((head) => !recorded.has(`refs/malt/delivery/${source.taskId}/${head} ${head}`))) {
    throw new MeshError(
      'FACTORY_GATED',
      'An unverified or terminal-only commit cannot satisfy a delivery head. Preserve the branch and return its edits to the original developer; the supervisor must create new commits.',
    );
  }
}
