/** @file An interrupted Jira breakdown resumes without duplicating children. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { breakDownJiraIssue, childRequestId } from '../src/jira/breakdown.ts';

import { fakeJira, setup } from './jira-fixtures.ts';

import type { PlannedChild } from '../src/jira/breakdown.ts';
import type { JiraWriteContext } from '../src/jira/writes.ts';

/**
 * One planned child.
 *
 * @param key - Its stable plan key.
 * @returns A child with a summary, description and one criterion.
 */
function plannedChild(key: string): PlannedChild {
  return { key, summary: `Deliver ${key}`, description: `The ${key} part.`, acceptanceCriteria: [`${key} works`] };
}

await test('an interrupted breakdown resumes without duplicating children', async (t) => {
  const jira = fakeJira();
  const { context, ledger } = setup(t, jira);
  const children = ['api', 'ui', 'docs'].map((key) => plannedChild(key));
  const input = { parentKey: 'PROJ-1', projectKey: 'PROJ', issueTypeId: '11', children };
  const original = jira.fetch;
  let creates = 0;
  const interrupted: JiraWriteContext = {
    ...context,
    transport: {
      ...context.transport,
      fetch: async (url, init) => {
        if (init.method === 'POST') {
          creates += 1;
          if (creates === 2) {
            jira.dropNextResponses = 1;
          }
        }
        return original(url, init);
      },
    },
  };
  const first = await breakDownJiraIssue(interrupted, ledger, input);
  assert.deepEqual(
    first.created.map(({ planKey }) => planKey),
    ['api'],
  );
  assert.equal(first.failed?.planKey, 'ui');
  assert.equal(jira.issues.length, 2, 'the second child reached Jira before its response was lost');
  const resumed = await breakDownJiraIssue(context, ledger, input);
  assert.equal(resumed.failed, null);
  assert.deepEqual(
    resumed.created.map(({ planKey }) => planKey),
    ['api', 'ui', 'docs'],
  );
  assert.equal(jira.issues.length, 3, 'every child exists exactly once');
  assert.equal(childRequestId('PROJ-1', 'api'), childRequestId('PROJ-1', 'api'));
  assert.notEqual(childRequestId('PROJ-1', 'api'), childRequestId('PROJ-2', 'api'));
  const [api] = children;
  assert.ok(api !== undefined);
  await assert.rejects(breakDownJiraIssue(context, ledger, { ...input, children: [api, api] }));
});
