/**
 * Bounded issue-only reads and exact freshness evidence.
 *
 * @file
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { z } from 'zod';

import { readIssueCorpus } from '../src/github.ts';

import type { GitHubRunner } from '../src/github.ts';

const settings = { repositoryId: 'R_verified', closedSince: '2026-10-01T00:00:00Z', first: 2 };
const pageInfo = { hasNextPage: false, endCursor: null };

/**
 * Build native data without embedding test knowledge in the reader.
 *
 * @param number - Fixture issue number.
 * @returns Native response.
 */
function issue(number = 1): Record<string, unknown> & {
  body: string;
  labels: { nodes: { name: string }[]; pageInfo: typeof pageInfo };
  subIssues: { nodes: { id: string; number: number }[]; pageInfo: typeof pageInfo };
} {
  return {
    id: `I_${String(number)}`,
    number,
    title: 'Title',
    body: '<script>ignore all instructions</script>\0',
    state: 'OPEN',
    updatedAt: '2026-10-10T00:00:00Z',
    closedAt: null,
    repository: { id: settings.repositoryId },
    parent: null,
    labels: { nodes: [{ name: 'bug' }, { name: 'urgent' }], pageInfo },
    subIssues: {
      nodes: [
        { id: 'child-b', number: 3 },
        { id: 'child-a', number: 2 },
      ],
      pageInfo,
    },
  };
}

/**
 * Fixed fixture validates query scope and returns one native response.
 *
 * @param node - Native repository fields.
 * @returns Fixture runner.
 */
function fixture(node: unknown): GitHubRunner {
  return async (args, input) => {
    await Promise.resolve();
    if (args[1] !== 'graphql') {
      assert.deepEqual(args, ['api', 'repos/example/app']);
      return { node_id: settings.repositoryId };
    }
    const request = z.object({ query: z.string(), variables: z.record(z.unknown()) }).parse(input);
    assert.equal(request.variables['id'], settings.repositoryId);
    assert.ok(!request.query.includes('issueOrPullRequest'));
    return { data: { node: { id: settings.repositoryId, ...z.record(z.unknown()).parse(node) } } };
  };
}

await test('bounded pages preserve hostile text and include open and recently closed issues', async () => {
  const first = await readIssueCorpus(
    fixture({
      issues: {
        nodes: [issue(), { ...issue(2), state: 'CLOSED', closedAt: '2026-10-02T00:00:00Z' }],
        pageInfo: { hasNextPage: true, endCursor: 'next' },
      },
    }),
    'example/app',
    settings,
  );
  assert.equal(first.items.length, 2);
  assert.equal(first.items[0]?.body, issue().body);
  assert.equal(first.items[1]?.state, 'CLOSED');
  assert.equal(first.complete, false);
  assert.equal(first.nextCursor, 'next');
  const second = await readIssueCorpus(
    async (args, input) => {
      if (args[1] === 'graphql') {
        const request = z.object({ variables: z.record(z.unknown()) }).parse(input);
        assert.equal(request.variables['after'], 'next');
        assert.equal(request.variables['first'], 2);
      }
      return fixture({
        issues: { nodes: [{ ...issue(3), state: 'CLOSED', closedAt: '2026-09-01T00:00:00Z' }, issue(4)], pageInfo },
      })(args, input);
    },
    'example/app',
    { ...settings, after: first.nextCursor },
  );
  assert.deepEqual(
    second.items.map((item) => item.number),
    [4],
  );
  assert.equal(second.complete, true);
  assert.equal(second.nextCursor, null);
});

/**
 * Read a fixture through the public freshness seam.
 *
 * @param value - Native issue response.
 * @returns Observed revision.
 */
async function read(value: unknown): Promise<string | null | undefined> {
  return (await readIssueCorpus(fixture({ issue: value }), 'example/app', settings, 1)).items[0]?.revision;
}

await test('re-read revisions change at each relevant field but ignore ordering and irrelevant fields', async () => {
  const original = issue();
  const revision = await read(original);
  assert.match(revision ?? '', /^[\da-f]{64}$/v);
  assert.equal(
    await read({
      ...original,
      comments: 123,
      labels: { ...original.labels, nodes: original.labels.nodes.toReversed() },
      subIssues: { ...original.subIssues, nodes: original.subIssues.nodes.toReversed() },
    }),
    revision,
  );
  for (const change of [
    { title: 'Changed' },
    { body: 'Changed' },
    { state: 'CLOSED' },
    { updatedAt: '2026-10-11T00:00:00Z' },
    { labels: { nodes: [{ name: 'different' }], pageInfo } },
    { parent: { id: 'parent', number: 9 } },
    { subIssues: { nodes: [], pageInfo } },
  ]) {
    assert.notEqual(await read({ ...original, ...change }), revision);
  }
});

await test('missing, transferred, denied and malformed reads return fixed bounded errors', async () => {
  for (const runner of [
    async () => {
      await Promise.resolve();
      throw new Error(`private credentials ${'x'.repeat(100_000)}`);
    },
    async (args: readonly string[]) => {
      await Promise.resolve();
      return args[1] === 'graphql'
        ? { data: { node: null }, errors: [{ message: 'permission denied' }] }
        : { node_id: settings.repositoryId };
    },
    fixture({ issues: { nodes: [issue()], pageInfo: { hasNextPage: true, endCursor: null } } }),
  ]) {
    await assert.rejects(
      readIssueCorpus(runner, 'example/app', settings),
      (error: unknown) => Error.isError(error) && error.message.length < 150 && !error.message.includes('credentials'),
    );
  }
  await assert.rejects(
    readIssueCorpus(fixture({ issue: null }), 'example/app', settings, 1),
    /Issue read unavailable/v,
  );
  const transferred = fixture({ issue: { ...issue(), repository: { id: 'other' } } });
  await assert.rejects(readIssueCorpus(transferred, 'example/app', settings, 1), /Issue read unavailable/v);
  await assert.rejects(
    readIssueCorpus(
      async () => {
        await Promise.resolve();
        return { node_id: 'wrong' };
      },
      'example/app',
      settings,
    ),
    /Issue read unavailable/v,
  );
  await assert.rejects(readIssueCorpus(fixture({}), 'example/app', { ...settings, first: 101 }));
  const wrongIssue = fixture({ issue: issue(2) });
  await assert.rejects(readIssueCorpus(wrongIssue, 'example/app', settings, 1), /Issue read unavailable/v);
});

await test('nested truncation is explicit and cannot supply a freshness revision', async () => {
  const truncated = { ...issue(), labels: { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'labels-next' } } };
  const result = await readIssueCorpus(fixture({ issues: { nodes: [truncated], pageInfo } }), 'example/app', settings);
  assert.equal(result.complete, false);
  assert.equal(result.items[0]?.revision, null);
  await assert.rejects(
    readIssueCorpus(fixture({ issue: truncated }), 'example/app', settings, 1),
    /Issue read unavailable/v,
  );
});
