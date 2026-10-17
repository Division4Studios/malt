/**
 * Exact diagnostics for supervisor failures: failed commands keep their
 * family, subcommand, exit and a redacted, bounded stderr tail, and empty
 * publications name their reason.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { command, CommandFailureError } from '../src/factory/commands.ts';
import { EmptyPublicationError, emptyPublicationReason } from '../src/factory/publication-size.ts';

import { fixture, rejection } from './delivery-fixture.ts';
import { createCleanup, createProject } from './helpers.ts';

import type { Fixture } from './delivery-fixture.ts';
import type { FactoryTask } from '../src/factory/schema.ts';

/**
 * Publish the fixture's delivery.
 *
 * @param f - Fixture.
 * @param task - Delivery state to publish.
 * @returns Published source.
 */
async function publish(f: Fixture, task: FactoryTask = f.task): Promise<{ head: string }> {
  return await f.workspaces.publish(task, async () => {
    await delay(0);
  });
}

await test('a failed command keeps its family, subcommand, exit code and a redacted, bounded stderr tail', async (t) => {
  const defer = createCleanup(t);
  const { root } = createProject(defer);
  const previous = process.env['GH_TOKEN'];
  process.env['GH_TOKEN'] = 'ghp_fixtureTokenValue123456789';
  defer(() => {
    if (previous === undefined) {
      delete process.env['GH_TOKEN'];
    } else {
      process.env['GH_TOKEN'] = previous;
    }
  });
  const script = `process.stderr.write('x'.repeat(9000) + ' push to https://user:hunter2@example.invalid/r failed ' + process.env.GH_TOKEN); process.exit(3)`;
  const failure = await rejection(command(process.execPath, ['-e', script], root));
  assert.ok(failure instanceof CommandFailureError);
  assert.equal(failure.command.exitCode, 3);
  assert.equal(failure.command.isTimeout, false);
  assert.equal(failure.command.subcommand, null, 'option-only invocations name no subcommand');
  assert.ok(failure.command.stderrTail.length <= 4000);
  assert.doesNotMatch(failure.command.stderrTail, /ghp_fixtureTokenValue|hunter2/v);
  assert.match(failure.command.stderrTail, /\[REDACTED\]/v);
  assert.match(failure.message, /^The node command failed with exit code 3\./v);
  assert.doesNotMatch(failure.message, /process\.exit/v, 'arguments never appear in the message');

  const git = await rejection(command('git', ['push', 'nowhere', 'main'], root));
  assert.ok(git instanceof CommandFailureError);
  assert.equal(git.command.family, 'git');
  assert.equal(git.command.subcommand, 'push');
  assert.equal(typeof git.command.exitCode, 'number');
  assert.match(git.message, /^The git push command failed with exit code \d+\./v);

  const missing = await rejection(command('malt-no-such-executable', ['run'], root));
  assert.ok(missing instanceof CommandFailureError);
  assert.equal(missing.command.isLaunchFailure, true);
  assert.match(missing.message, /malt-no-such-executable run command could not be started/v);
});

await test('empty publications name nothing_to_commit, empty_diff and already_merged', async (t) => {
  assert.equal(
    emptyPublicationReason({ ownCommitsBefore: 0, ownCommitsAfter: 0, hadEdits: false }),
    'nothing_to_commit',
  );
  assert.equal(emptyPublicationReason({ ownCommitsBefore: 2, ownCommitsAfter: 0, hadEdits: false }), 'already_merged');
  assert.equal(emptyPublicationReason({ ownCommitsBefore: 0, ownCommitsAfter: 1, hadEdits: true }), 'empty_diff');

  const untouched = await fixture(t);
  const nothing = await rejection(publish(untouched));
  assert.ok(nothing instanceof EmptyPublicationError);
  assert.equal(nothing.reason, 'nothing_to_commit');
  assert.equal(nothing.code, 'FACTORY_GATED');

  const duplicate = await fixture(t);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixture writes only inside its owned worktree.
  await writeFile(path.join(duplicate.directory, 'shared.txt'), 'same change\n');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixture writes only inside its temporary project.
  await writeFile(path.join(duplicate.mesh.root, 'shared.txt'), 'same change\n');
  await duplicate.workspaces.git(['commit', '-am', 'Main already has the same change']);
  await duplicate.workspaces.git(['push', 'origin', 'main']);
  const same = await rejection(publish(duplicate));
  assert.ok(same instanceof EmptyPublicationError);
  assert.equal(same.reason, 'empty_diff');

  const merged = await fixture(t);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixture writes only inside its owned worktree.
  await writeFile(path.join(merged.directory, 'shared.txt'), 'delivered\n');
  const first = await publish(merged);
  await merged.workspaces.git(['push', 'origin', `${first.head}:main`], merged.directory);
  const again = await rejection(publish(merged, { ...merged.task, head: first.head }));
  assert.ok(again instanceof EmptyPublicationError);
  assert.equal(again.reason, 'already_merged');
  assert.match(again.message, /already on main/v);
});
