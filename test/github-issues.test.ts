/** @file Read-only issue pagination, deterministic observed revisions and scope fences. */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { z } from 'zod/v3';

import { GitHubDelivery } from '../src/factory/remote.ts';
import { readIssueCorpus, readObservedIssue } from '../src/github-issues.ts';
import { ProjectGitHub } from '../src/github.ts';

import { createCleanup, createProject } from './helpers.ts';

/** Fixed observed remote time; all closed-window tests use an explicit cutoff. */
const updatedAt = '2026-10-16T00:00:00.000Z';
/** Canonical selected native repository, not a mutable owner/name. */
const repository = { id: 'R_fixture' };
/** Fixed recent-closed cutoff retained across pages. */
const closedSince = Date.parse('2026-10-01T00:00:00.000Z');

/**
 * Produce finite native issue data, including hostile but inert issue prose.
 *
 * @param number - Repository-local number.
 * @returns Synthetic GraphQL Issue; never an inference or live GitHub mutation.
 */
function issue(number: number): Record<string, unknown> {
  return {
    __typename: 'Issue',
    id: `I_${number}`,
    number,
    repository,
    title: 'Bounded issue',
    body: '<script>untrusted()</script>',
    url: `https://github.com/fixture/app/issues/${number}`,
    state: 'OPEN',
    stateReason: null,
    updatedAt,
    closedAt: null,
    parent: null,
    labels: { nodes: [{ name: 'bug' }, { name: 'area:console' }], pageInfo: { hasNextPage: false } },
    subIssues: { nodes: [], pageInfo: { hasNextPage: false } },
  };
}

/** Validate only the structured native variables used by this fixture. */
const queryVariablesSchema = z.object({ id: z.string() });
/** No fixture can smuggle a shell command through the query body. */
const queryInputSchema = z.object({ variables: queryVariablesSchema });

/**
 * Hash one exact synthetic native observation through the production reader.
 *
 * @param value - Native issue fixture.
 * @returns Current observed revision.
 */
async function revisionFor(value: unknown): Promise<string> {
  const observed = await readObservedIssue(
    async () => {
      await Promise.resolve();
      return { node: { ...repository, issue: value } };
    },
    repository.id,
    1,
  );
  return observed.revision;
}

await test('bounded open then recent-closed pages preserve cutoff and explicitly report coverage', async () => {
  const calls: unknown[] = [];
  const pages = [
    { nodes: [issue(1)], pageInfo: { hasNextPage: true, endCursor: 'next-open' } },
    { nodes: [issue(2)], pageInfo: { hasNextPage: false, endCursor: 'last-open' } },
    {
      nodes: [
        { ...issue(3), state: 'CLOSED', closedAt: updatedAt },
        { ...issue(4), state: 'CLOSED', updatedAt: '2026-09-01T00:00:00.000Z', closedAt: '2026-09-01T00:00:00.000Z' },
      ],
      pageInfo: { hasNextPage: true, endCursor: 'older-closed' },
    },
  ];
  const query = async (document: string, variables: Record<string, unknown>): Promise<unknown> => {
    assert.match(document, /issues\(states:\$states/v, 'Repository IssueConnection excludes PRs.');
    calls.push(variables);
    await Promise.resolve();
    return { node: { ...repository, issues: pages[calls.length - 1] } };
  };
  const first = await readIssueCorpus(query, repository.id, { limit: 2, closedSince });
  assert.equal(first.complete, false);
  assert.equal(first.items[0]?.body, '<script>untrusted()</script>');
  const second = await readIssueCorpus(query, repository.id, { limit: 2, cursor: first.nextCursor });
  assert.equal(second.nextCursor?.phase, 'closed');
  const final = await readIssueCorpus(query, repository.id, { limit: 2, cursor: second.nextCursor });
  assert.deepEqual(
    final.items.map((item) => item.number),
    [3],
  );
  assert.equal(final.nextCursor, null);
  assert.equal(final.complete, true);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[1], { id: repository.id, states: ['OPEN'], limit: 2, after: 'next-open' });
  assert.deepEqual(calls[2], { id: repository.id, states: ['CLOSED'], limit: 2, after: null });
});

await test('observed revisions are set-order stable and sensitive to all retained issue semantics', async () => {
  const original = issue(1);
  const revision = await revisionFor(original);
  assert.equal(
    await revisionFor({
      ...original,
      labels: { nodes: [{ name: 'area:console' }, { name: 'bug' }], pageInfo: { hasNextPage: false } },
    }),
    revision,
  );
  for (const change of [
    { title: 'Changed title' },
    { body: 'Changed body' },
    { state: 'CLOSED', closedAt: updatedAt },
    { labels: { nodes: [], pageInfo: { hasNextPage: false } } },
    { parent: { id: 'I_parent', number: 2, repository } },
    { subIssues: { nodes: [{ id: 'I_child', number: 3, repository }], pageInfo: { hasNextPage: false } } },
    { updatedAt: '2026-10-16T01:00:00.000Z' },
  ]) {
    assert.notEqual(await revisionFor({ ...original, ...change }), revision);
  }
  await assert.rejects(revisionFor({ ...original, __typename: 'PullRequest' }));
  await assert.rejects(revisionFor({ ...original, repository: { id: 'R_foreign' } }), { code: 'WRONG_PROJECT' });
});

await test('partial relations, foreign cursors, missing issues and malformed pagination never imply complete data', async () => {
  const query = async (): Promise<unknown> => {
    await Promise.resolve();
    return {
      node: {
        ...repository,
        issues: {
          nodes: [{ ...issue(1), subIssues: { nodes: [], pageInfo: { hasNextPage: true } } }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    };
  };
  const partial = await readIssueCorpus(query, repository.id, { closedSince });
  assert.equal(partial.items[0]?.complete, false);
  assert.equal(partial.nextCursor?.hasTruncatedItems, true);
  await assert.rejects(
    readIssueCorpus(
      async () => {
        await Promise.resolve();
        return { node: { ...repository, issues: { nodes: [], pageInfo: { hasNextPage: true, endCursor: null } } } };
      },
      repository.id,
      {},
    ),
    { code: 'GITHUB_UNAVAILABLE' },
  );
  await assert.rejects(readIssueCorpus(query, 'R_foreign', { cursor: partial.nextCursor }), { code: 'WRONG_PROJECT' });
  await assert.rejects(readIssueCorpus(query, repository.id, { limit: 11 }));
  await assert.rejects(
    readIssueCorpus(query, repository.id, { cursor: partial.nextCursor, closedSince: closedSince + 1 }),
    { code: 'INVALID_INPUT' },
  );
  await assert.rejects(
    readObservedIssue(
      async () => {
        await Promise.resolve();
        return { node: { ...repository, issue: null } };
      },
      repository.id,
      1,
    ),
    { code: 'NOT_FOUND' },
  );
});

await test('ProjectGitHub and delivery reads require verified identity and retain bounded permission errors', async (t) => {
  const mesh = createProject(createCleanup(t));
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Only this fixture's private connection directory.
  mkdirSync(path.join(mesh.directory, 'github'));
  const file = path.join(mesh.directory, 'github', 'connection.json');
  const connection = {
    version: 2,
    tracker: {
      provider: 'github-projects',
      owner: 'fixture',
      projectId: 'PVT_test',
      projectNumber: 1,
      url: 'https://github.com/users/fixture/projects/1',
      workflowField: { id: 'status', name: 'Status' },
      capabilities: {},
      savedAt: updatedAt,
      verifiedAt: updatedAt,
    },
    source: {
      provider: 'github',
      repository: 'fixture/app',
      repositoryId: repository.id,
      capabilities: {},
      savedAt: updatedAt,
      verifiedAt: updatedAt,
    },
  };
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Persist only the explicit test-owned nonsecret connection.
  writeFileSync(file, JSON.stringify(connection));
  const github = new ProjectGitHub(mesh, async (args, input) => {
    assert.deepEqual(args, ['api', 'graphql', '--input', '-']);
    const payload = queryInputSchema.parse(input);
    assert.equal(payload.variables.id, repository.id);
    await Promise.resolve();
    return { data: { node: { ...repository, issue: issue(1) } } };
  });
  const delivery = new GitHubDelivery(mesh, github);
  assert.equal((await delivery.observedIssue(1)).number, 1);
  const denied = new ProjectGitHub(mesh, async () => {
    await Promise.resolve();
    return { errors: [{ message: 'Private remote error detail.' }] };
  });
  await assert.rejects(
    denied.issues().get(1),
    (error) => Error.isError(error) && error.message.length < 256 && !error.message.includes('Private remote'),
  );
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Replace only the test-owned connection with an explicitly unverified source.
  writeFileSync(file, JSON.stringify({ ...connection, source: { ...connection.source, repositoryId: null } }));
  assert.throws(() => github.issues(), { code: 'GITHUB_NOT_CONNECTED' });
});
