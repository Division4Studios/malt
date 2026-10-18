/** @file Read-only Jira JQL intake: paging, bounds, rate limits, renamed keys and unworkable issues, from fixtures. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { chooseIntake, searchIntake, unworkableReason } from '../src/jira/intake.ts';

import type { JiraFetch, JiraTransport } from '../src/jira/client.ts';
import type { IntakeIssue } from '../src/jira/intake.ts';

/** MALT's Jira account. */
const ACCOUNT = 'acc-malt';

/**
 * A search result issue.
 *
 * @param id - Jira's stable issue ID, which survives key renames.
 * @param key - Current issue key, such as PROJ-1.
 * @param fields - Field overrides.
 * @returns Raw search issue.
 */
function issue(id: string, key: string, fields: Record<string, unknown> = {}): unknown {
  return {
    id,
    key,
    fields: {
      summary: `Summary of ${key}`,
      status: { id: '1', name: 'To Do', statusCategory: { key: 'new' } },
      assignee: null,
      resolution: null,
      ...fields,
    },
  };
}

/** An HTTP failure a fixture page answers with. */
interface Failure {
  /** HTTP status. */
  readonly status: number;
  /** `Retry-After` header. */
  readonly retryAfter?: string;
}

/**
 * Whether a fixture answer is an HTTP failure rather than a page body.
 *
 * @param answer - Fixture answer.
 * @returns True for a failure.
 */
function isFailure(answer: unknown): answer is Failure {
  return typeof answer === 'object' && answer !== null && 'status' in answer;
}

/**
 * A transport serving search pages in order, then empty pages.
 *
 * @param answers - Page bodies, or failures.
 * @returns The transport and the query of every request.
 */
function pages(...answers: unknown[]): {
  transport: JiraTransport;
  queries: URLSearchParams[];
} {
  const queries: URLSearchParams[] = [];
  const fetch: JiraFetch = async (raw) => {
    await Promise.resolve();
    const url = new URL(raw);
    queries.push(url.searchParams);
    const answer = answers[queries.length - 1] ?? { issues: [] };
    const failure = isFailure(answer) ? answer : null;
    const text = JSON.stringify(failure === null ? answer : {});
    return {
      status: failure?.status ?? 200,
      headers: { get: (name) => (name === 'retry-after' ? (failure?.retryAfter ?? null) : null) },
      text: async () => {
        await Promise.resolve();
        return text;
      },
    };
  };
  return {
    transport: {
      site: { origin: 'https://example.atlassian.net', deployment: 'cloud' },
      credential: { email: 'robot@example.com', token: 'token' },
      fetch,
    },
    queries,
  };
}

await test('intake pages through the JQL filter with the enhanced search token', async () => {
  const fixture = pages(
    { issues: [issue('1', 'PROJ-1'), issue('2', 'PROJ-2')], nextPageToken: 'next' },
    { issues: [issue('3', 'PROJ-3')], isLast: true },
  );
  const read = await searchIntake(fixture.transport, ' project = PROJ AND labels = malt ');
  assert.deepEqual(
    read.issues.map(({ key }) => key),
    ['PROJ-1', 'PROJ-2', 'PROJ-3'],
  );
  assert.equal(read.isTruncated, false);
  const [first, second] = fixture.queries;
  assert.ok(first !== undefined && second !== undefined);
  assert.equal(first.get('jql'), 'project = PROJ AND labels = malt');
  assert.equal(first.get('nextPageToken'), null);
  assert.equal(second.get('nextPageToken'), 'next');
  assert.match(first.get('fields') ?? '', /status/v);
});

await test('intake reads are bounded and say when they stopped early', async () => {
  const fixture = pages(
    { issues: [issue('1', 'PROJ-1'), issue('2', 'PROJ-2')], nextPageToken: 'a' },
    { issues: [issue('3', 'PROJ-3')], nextPageToken: 'b' },
  );
  const read = await searchIntake(fixture.transport, 'project = PROJ', { limit: 2 });
  assert.equal(read.issues.length, 2);
  assert.equal(read.isTruncated, true);
  assert.equal(read.next, 'a');
  assert.equal(fixture.queries.length, 1, 'no page is read past the bound');
  const rest = await searchIntake(fixture.transport, 'project = PROJ', { limit: 2, cursor: read.next });
  assert.deepEqual(
    rest.issues.map(({ key }) => key),
    ['PROJ-3'],
    'resuming reads the issues after the bound instead of starting again',
  );
  assert.equal(fixture.queries[1]?.get('nextPageToken'), 'a');
});

await test('a rate limit keeps the pages already read and reports Retry-After', async () => {
  const fixture = pages({ issues: [issue('1', 'PROJ-1')], nextPageToken: 'a' }, { status: 429, retryAfter: '45' });
  const read = await searchIntake(fixture.transport, 'project = PROJ');
  assert.deepEqual(
    read.issues.map(({ key }) => key),
    ['PROJ-1'],
  );
  assert.equal(read.isTruncated, true);
  assert.equal(read.retryAfterSeconds, 45);
  assert.equal(read.next, 'a', 'the refused page is read again after the wait');
  await assert.rejects(searchIntake(pages({ status: 401 }).transport, 'project = PROJ'), /rejected the credential/v);
  await assert.rejects(searchIntake(pages().transport, ' '.repeat(3)), /String must contain at least 1/v);
});

await test('done, resolved and reassigned issues are skipped with the reason', () => {
  const base: IntakeIssue = {
    id: '1',
    key: 'PROJ-1',
    summary: 'A',
    status: 'To Do',
    category: 'new',
    assignee: null,
    resolution: null,
  };
  assert.equal(unworkableReason(base, ACCOUNT), null);
  assert.equal(
    unworkableReason({ ...base, assignee: ACCOUNT }, ACCOUNT),
    null,
    'issues assigned to MALT stay workable',
  );
  assert.equal(unworkableReason({ ...base, category: 'done' }, ACCOUNT), 'done');
  assert.equal(unworkableReason({ ...base, resolution: "Won't Do" }, ACCOUNT), 'resolved');
  assert.equal(unworkableReason({ ...base, assignee: 'acc-human' }, ACCOUNT), 'reassigned');
});

await test('an issue whose project key was renamed is not queued twice', async () => {
  const fixture = pages({
    issues: [
      issue('10', 'NEW-1'),
      issue('11', 'NEW-2', { status: { id: '9', name: 'Done', statusCategory: { key: 'done' } } }),
      issue('12', 'NEW-3', { assignee: { accountId: 'acc-human' } }),
      issue('13', 'NEW-4'),
      issue('13', 'NEW-4'),
    ],
    isLast: true,
  });
  const chosen = chooseIntake(await searchIntake(fixture.transport, 'project = NEW'), ACCOUNT, new Set(['10']));
  assert.deepEqual(
    chosen.queue.map(({ key }) => key),
    ['NEW-4'],
  );
  assert.deepEqual(chosen.skipped, [
    { key: 'NEW-1', reason: 'already_queued' },
    { key: 'NEW-2', reason: 'done' },
    { key: 'NEW-3', reason: 'reassigned' },
    { key: 'NEW-4', reason: 'already_queued' },
  ]);
});
