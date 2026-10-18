/** @file Jira traceability: idempotent evidence comments, the pre-job re-read and the credential blocker, from fixtures. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { z } from 'zod/v3';

import { JiraRequestError } from '../src/jira/client.ts';
import { commentEvidenceOnce, credentialBlocker, evidenceText, recheckIssue } from '../src/jira/traceability.ts';

import { fakeJira, setup } from './jira-fixtures.ts';

import type { JiraFetch } from '../src/jira/client.ts';
import type { JiraWriteContext } from '../src/jira/writes.ts';

/** The comment request body the fixture reads. */
const commentBodySchema = z.object({ body: z.unknown() });

/** A fixture issue with comments that can lose a comment's response. */
interface CommentSite {
  /** Posted comments. */
  readonly comments: { id: string; body: unknown }[];
  /** Comment posts whose response is lost after Jira saved the comment. */
  dropNext: number;
  /** Comments Jira returns per page. */
  pageSize: number;
  /** Fields the issue reports. */
  fields: Record<string, unknown>;
  /** Transport. */
  readonly fetch: JiraFetch;
}

/**
 * A fixture issue `PROJ-1` with a comment thread and current state.
 *
 * @returns The fixture.
 */
function commentSite(): CommentSite {
  const site: CommentSite = {
    comments: [],
    dropNext: 0,
    pageSize: 50,
    fields: {
      summary: 'Export',
      status: { id: '3', name: 'In Progress', statusCategory: { key: 'indeterminate' } },
      assignee: null,
      resolution: null,
    },
    fetch: async (raw, init) => {
      await Promise.resolve();
      const { pathname, searchParams } = new URL(raw);
      let body: unknown = { id: '1', key: 'PROJ-1', fields: site.fields };
      if (pathname === '/rest/api/3/issue/PROJ-1/comment' && init.method === 'POST') {
        const comment = {
          id: String(site.comments.length + 1),
          body: commentBodySchema.parse(JSON.parse(init.body ?? '{}')).body,
        };
        site.comments.push(comment);
        if (site.dropNext > 0) {
          site.dropNext -= 1;
          throw new Error('socket hang up');
        }
        body = { id: comment.id };
      } else if (pathname === '/rest/api/3/issue/PROJ-1/comment') {
        const startAt = Number(searchParams.get('startAt') ?? '0');
        const newest = site.comments.toReversed();
        body = { comments: newest.slice(startAt, startAt + site.pageSize), total: newest.length };
      }
      const text = JSON.stringify(body);
      return {
        status: init.method === 'POST' ? 201 : 200,
        headers: { get: () => null },
        text: async () => {
          await Promise.resolve();
          return text;
        },
      };
    },
  };
  return site;
}

await test('evidence comments say what happened, with short commits', () => {
  assert.equal(evidenceText({ kind: 'progress', summary: 'Tests pass' }), 'MALT progress: Tests pass');
  assert.match(
    evidenceText({ kind: 'pull_request', url: 'https://github.com/o/r/pull/7', head: 'a'.repeat(40) }),
    /^MALT opened a pull request for this issue at a{12}: https:\/\/github\.com\/o\/r\/pull\/7$/v,
  );
  assert.match(
    evidenceText({ kind: 'merged', url: 'https://github.com/o/r/pull/7', commit: 'b'.repeat(40), verified: true }),
    /as b{12} and verified on main\.$/v,
  );
});

await test('an evidence comment is posted once, even after a lost response', async (t) => {
  const site = commentSite();
  const { context, ledger } = setup(t, fakeJira());
  const write: JiraWriteContext = { ...context, transport: { ...context.transport, fetch: site.fetch } };
  const input = {
    requestId: 'pr-PROJ-1-abc',
    issueKey: 'PROJ-1',
    evidence: { kind: 'pull_request', url: 'https://github.com/o/r/pull/7', head: 'c'.repeat(40) },
  } as const;
  const first = await commentEvidenceOnce(write, ledger, input);
  assert.deepEqual(await commentEvidenceOnce(write, ledger, input), first);
  assert.equal(site.comments.length, 1);
  site.dropNext = 1;
  const lost = { ...input, requestId: 'merged-PROJ-1-def' };
  await assert.rejects(commentEvidenceOnce(write, ledger, lost), /Could not reach Jira/v);
  assert.equal(site.comments.length, 2, 'Jira saved the comment although the response was lost');
  for (let index = 0; index < 5; index += 1) {
    site.comments.push({ id: `newer-${String(index)}`, body: 'someone else' });
  }
  site.pageSize = 2;
  const recovered = await commentEvidenceOnce(write, ledger, lost);
  assert.equal(recovered.id, '2', 'the marker is found on a later page');
  assert.equal(site.comments.length, 7, 'the retry found it instead of posting again');
  const held = { ...input, requestId: 'held-PROJ-1' };
  const [winner, overlapping] = await Promise.allSettled([
    commentEvidenceOnce(write, ledger, held),
    commentEvidenceOnce(write, ledger, held),
  ]);
  assert.equal(winner.status, 'fulfilled');
  assert.equal(overlapping.status, 'rejected', 'an overlapping attempt is refused instead of posting again');
});

await test('an issue is re-read before a job and not worked once done, resolved or reassigned', async () => {
  const site = commentSite();
  const transport = {
    site: { origin: 'https://example.atlassian.net', deployment: 'cloud' },
    credential: { email: 'robot@example.com', token: 'token' },
    fetch: site.fetch,
  } as const;
  assert.equal((await recheckIssue(transport, 'PROJ-1', 'acc-malt')).blocked, null);
  site.fields = { ...site.fields, assignee: { accountId: 'acc-human' } };
  assert.equal((await recheckIssue(transport, 'PROJ-1', 'acc-malt')).blocked, 'reassigned');
  site.fields = { ...site.fields, assignee: null, resolution: { name: 'Done' } };
  assert.equal((await recheckIssue(transport, 'PROJ-1', 'acc-malt')).blocked, 'resolved');
});

await test('a rejected credential becomes one blocker; other failures do not', () => {
  assert.match(
    credentialBlocker(new JiraRequestError('Jira rejected the credential.', { failure: 'unauthorized' })) ?? '',
    /revoked, rotated or expired/v,
  );
  assert.equal(credentialBlocker(new JiraRequestError('Busy.', { failure: 'rate_limited' })), null);
  assert.equal(credentialBlocker(new Error('other')), null);
});
