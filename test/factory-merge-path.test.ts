/**
 * The protected-branch merge path: the readiness gate no longer needs GitHub
 * approval or a clean merge state, protection is read from repository
 * settings, rulesets and classic protection, and the merge step chooses
 * between merging, auto-merge, the merge queue and a precise wait.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { chooseMergePath, readProtection } from '../src/factory/merge-path.ts';
import { mergeBlocker } from '../src/factory/remote.ts';
import { factoryConfigSchema, taskSchema } from '../src/factory/schema.ts';

import type { Protection } from '../src/factory/merge-path.ts';
import type { PullRequest } from '../src/factory/remote.ts';
import type { GitHubRunner } from '../src/github.ts';

/** Reviewed head. */
const HEAD = 'a'.repeat(40);
/** A head nobody reviewed. */
const OTHER_HEAD = 'c'.repeat(40);
/** Reviewed base. */
const BASE = 'b'.repeat(40);
/** Default project policy. */
const SETTINGS = factoryConfigSchema.parse({
  testCommands: [{ file: process.execPath }],
  endToEndCommands: [{ file: process.execPath }],
});
/** A delivery reviewed at the fixture head and base. */
const TASK = taskSchema.parse({
  id: randomUUID(),
  featureId: null,
  issue: 1,
  parentIssue: 2,
  key: 'merge',
  title: 'Protected merge',
  description: 'One scoped delivery.',
  acceptanceCriteria: ['Observable behavior passes.'],
  dependencies: [],
  phase: 'merge_ready',
  developer: 'developer-1',
  branch: 'fixture-branch',
  worktree: null,
  head: HEAD,
  base: BASE,
  pr: 3,
  prUrl: 'https://github.com/example/app/pull/3',
  merge: null,
  reviews: [],
  feedback: [],
  attempts: 1,
  version: 1,
  error: null,
  updatedAt: 1,
});
/** An unprotected repository with every merge method and no auto-merge. */
const OPEN_PROTECTION: Protection = {
  methods: ['squash', 'rebase', 'merge'],
  isAutoMergeAllowed: false,
  hasMergeQueue: false,
  requiredReviews: 0,
  requiredChecks: [],
};

/**
 * A PR at the reviewed head and base.
 *
 * @param fields - Overrides.
 * @returns PR state.
 */
function pr(fields: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 3,
    url: 'https://github.com/example/app/pull/3',
    headRefOid: HEAD,
    baseRefOid: BASE,
    baseRefName: 'main',
    isDraft: false,
    state: 'OPEN',
    mergeStateStatus: 'CLEAN',
    mergeCommit: null,
    statusCheckRollup: [],
    reviewDecision: null,
    ...fields,
  };
}

/**
 * A token that cannot read classic protection, on a branch with a merge queue.
 *
 * @param args - GitHub CLI arguments.
 * @returns Settings or rules; classic protection is refused.
 */
const unreadableProtection: GitHubRunner = async (args) => {
  await delay(0);
  if (args[1]?.endsWith('/protection') === true) {
    throw new Error('HTTP 403: classic protection needs admin rights');
  }
  return args[1] === 'repos/example/app' ? {} : [{ type: 'merge_queue', parameters: {} }];
};

await test('the readiness gate waits on unmergeable or untested source but not on GitHub approval', () => {
  assert.equal(
    mergeBlocker(pr({ mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED' }), TASK, SETTINGS),
    null,
  );
  assert.match(mergeBlocker(pr({ mergeStateStatus: 'DIRTY' }), TASK, SETTINGS) ?? '', /conflicts/v);
  assert.match(mergeBlocker(pr({ mergeStateStatus: 'BEHIND' }), TASK, SETTINGS) ?? '', /behind/v);
  assert.match(mergeBlocker(pr({ mergeStateStatus: 'UNKNOWN' }), TASK, SETTINGS) ?? '', /still computing/v);
  assert.match(mergeBlocker(pr({ reviewDecision: 'CHANGES_REQUESTED' }), TASK, SETTINGS) ?? '', /requested changes/v);
  assert.match(mergeBlocker(pr({ headRefOid: OTHER_HEAD }), TASK, SETTINGS) ?? '', /stale/v);
  assert.match(mergeBlocker(pr({ isDraft: true }), TASK, SETTINGS) ?? '', /draft/v);
  const pending = pr({
    statusCheckRollup: [{ name: 'check (ubuntu-latest)', status: 'IN_PROGRESS', conclusion: null }],
  });
  assert.equal(mergeBlocker(pending, TASK, SETTINGS), 'GitHub check check (ubuntu-latest) is in_progress.');
  const failed = pr({ statusCheckRollup: [{ name: 'docker', conclusion: 'FAILURE' }] });
  assert.equal(mergeBlocker(failed, TASK, SETTINGS), 'GitHub check docker is failure.');
  const mandatory = { ...SETTINGS, requiredChecks: ['Quality gate'] };
  assert.match(mergeBlocker(pr(), TASK, mandatory) ?? '', /mandatory check Quality gate/v);
});

await test('protection combines repository settings, rulesets and readable classic protection', async () => {
  const routes: string[] = [];
  const runner: GitHubRunner = async (args) => {
    await delay(0);
    const route = args[1] ?? '';
    routes.push(route);
    if (route === 'repos/example/app') {
      return { allow_squash_merge: true, allow_rebase_merge: true, allow_merge_commit: true, allow_auto_merge: true };
    }
    if (route.endsWith('/protection')) {
      return {
        required_pull_request_reviews: { required_approving_review_count: 1 },
        required_status_checks: { contexts: ['docker'], checks: [{ context: 'docker' }] },
        required_linear_history: { enabled: true },
      };
    }
    return [
      {
        type: 'pull_request',
        parameters: { required_approving_review_count: 2, allowed_merge_methods: ['squash', 'merge'] },
      },
      { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'Quality gate' }] } },
    ];
  };
  const protection = await readProtection(runner, 'example/app', 'main');
  assert.deepEqual(protection, {
    methods: ['squash'],
    isAutoMergeAllowed: true,
    hasMergeQueue: false,
    requiredReviews: 2,
    requiredChecks: ['docker', 'Quality gate'],
  });
  assert.deepEqual(
    routes.toSorted((left, right) => left.localeCompare(right)),
    ['repos/example/app', 'repos/example/app/branches/main/protection', 'repos/example/app/rules/branches/main'],
  );

  const queued = await readProtection(unreadableProtection, 'example/app', 'main');
  assert.deepEqual(queued.methods, ['squash', 'rebase', 'merge']);
  assert.equal(queued.hasMergeQueue, true);
  assert.equal(queued.isAutoMergeAllowed, false, "GitHub's default is no auto-merge");
});

await test('the merge step merges, arms auto-merge, enqueues or waits with a precise reason', () => {
  assert.deepEqual(chooseMergePath(pr(), OPEN_PROTECTION), { action: 'merge', method: 'squash' });

  const review = pr({ mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED' });
  const reviewed = { ...OPEN_PROTECTION, requiredReviews: 1 };
  const armed = chooseMergePath(review, { ...reviewed, isAutoMergeAllowed: true });
  assert.equal(armed.action, 'auto');
  assert.match('reason' in armed ? armed.reason : '', /awaiting 1 approving review;/v);
  const handoff = chooseMergePath(review, reviewed);
  assert.equal(handoff.action, 'wait');
  assert.match(
    'reason' in handoff ? handoff.reason : '',
    /^PR #3 is awaiting 1 approving review\. Auto-merge is off for this repository, so a maintainer merges it/v,
  );

  const checks = { ...OPEN_PROTECTION, requiredChecks: ['docker'], isAutoMergeAllowed: true };
  const pending = chooseMergePath(pr({ mergeStateStatus: 'BLOCKED' }), checks);
  assert.match('reason' in pending ? pending.reason : '', /awaiting required check docker/v);

  const queue = chooseMergePath(review, { ...reviewed, hasMergeQueue: true });
  assert.equal(queue.action, 'queue');
  assert.match('reason' in queue ? queue.reason : '', /merge queue, awaiting 1 approving review/v);

  const linear = chooseMergePath(pr(), { ...OPEN_PROTECTION, methods: ['rebase'] });
  assert.deepEqual(linear, { action: 'merge', method: 'rebase' });
  const none = chooseMergePath(pr(), { ...OPEN_PROTECTION, methods: [] });
  assert.equal(none.action, 'wait');
});
