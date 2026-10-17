/** @file A running broker reports the exact source it was started from. */
import assert from 'node:assert/strict';
import test from 'node:test';

import { startBroker } from '../src/broker.ts';
import { SOURCE_REVISION, readSourceRevision } from '../src/source-revision.ts';

import { brokerUrl, createCleanup, createProject } from './helpers.ts';

/** A fixed commit id. */
const COMMIT = '0123456789abcdef0123456789abcdef01234567';

/**
 * Git access that fails the test if it is ever used.
 *
 * @throws {Error} Always: Git must not run when the image records its revision.
 */
function never(): never {
  throw new Error('Git must not run when the image records its revision.');
}

/**
 * Git reads of a checkout at {@link COMMIT}.
 *
 * @param status - Porcelain status output, or null when the status read fails.
 * @returns Fake Git access.
 */
function checkout(status: string | null): (args: readonly string[]) => string | null {
  return (args) => (args[0] === 'rev-parse' ? `${COMMIT}\n` : status);
}

await test('an image revision wins, a checkout reports HEAD and its dirty state, and anything else is unknown', () => {
  assert.deepEqual(readSourceRevision({ environment: ` ${COMMIT.toUpperCase()} `, git: never }), {
    commit: COMMIT,
    isDirty: null,
    origin: 'image',
  });
  assert.deepEqual(readSourceRevision({ environment: 'unknown', git: checkout('') }), {
    commit: COMMIT,
    isDirty: false,
    origin: 'checkout',
  });
  assert.equal(readSourceRevision({ environment: undefined, git: checkout(' M src/cli.ts\n') }).isDirty, true);
  assert.equal(readSourceRevision({ environment: undefined, git: checkout(null) }).isDirty, null);
  assert.deepEqual(readSourceRevision({ environment: undefined, git: () => null }), {
    commit: null,
    isDirty: null,
    origin: 'unknown',
  });
  assert.equal(readSourceRevision({ environment: undefined, git: () => 'not a commit' }).origin, 'unknown');
});

await test('the broker health endpoint reports its version and source revision', async (t) => {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  const broker = await startBroker(mesh, { port: 0 });
  defer(async () => broker.close());
  const response = await fetch(`${brokerUrl(broker.port)}/health`);
  assert.equal(response.status, 200);
  const health: unknown = await response.json();
  assert.ok(typeof health === 'object' && health !== null && 'revision' in health);
  assert.deepEqual(health.revision, SOURCE_REVISION);
});
