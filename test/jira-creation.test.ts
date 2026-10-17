/** @file Idempotent Jira creation against a stateful fixture site: retries and lost responses never duplicate. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createJiraIssueOnce, creationMarker } from '../src/jira/creation.ts';

import { fakeJira, setup } from './jira-fixtures.ts';

import type { JiraWriteContext } from '../src/jira/writes.ts';

/** One creation request. */
const REQUEST = {
  requestId: 'feature-1',
  projectKey: 'PROJ',
  issueTypeId: '10',
  summary: 'Export as CSV',
  description: 'Operators export the board.',
  acceptanceCriteria: ['A CSV downloads'],
};

await test('a request creates one issue, and repeating it returns the same issue', async (t) => {
  const jira = fakeJira();
  const { context, ledger } = setup(t, jira);
  const first = await createJiraIssueOnce(context, ledger, REQUEST);
  const again = await createJiraIssueOnce(context, ledger, REQUEST);
  assert.deepEqual(again, first);
  assert.equal(jira.issues.length, 1);
  const text = JSON.stringify(jira.issues[0]?.description);
  assert.ok(text.includes(creationMarker(ledger, 'feature-1')), 'the marker is in the description');
  assert.ok(text.includes('[ ] A CSV downloads'), 'acceptance criteria are in the description');
  await assert.rejects(createJiraIssueOnce(context, ledger, { ...REQUEST, summary: 'Changed' }), {
    code: 'INVALID_INPUT',
  });
});

await test('a lost response is reconciled from the marker instead of creating again', async (t) => {
  const jira = fakeJira();
  const { context, ledger } = setup(t, jira);
  jira.dropNextResponses = 1;
  await assert.rejects(createJiraIssueOnce(context, ledger, REQUEST), /Could not reach Jira/v);
  assert.equal(jira.issues.length, 1, 'Jira created it although the response was lost');
  const reconciled = await createJiraIssueOnce(context, ledger, REQUEST);
  assert.equal(reconciled.key, jira.issues[0]?.key);
  assert.equal(jira.issues.length, 1, 'no duplicate');
  const [search] = jira.searches;
  assert.match(search?.get('jql') ?? '', /^project = "PROJ" AND reporter = currentUser\(\) AND created >= -\d+m/v);
});

await test('a creation that never reached Jira is created on retry, and two matches are refused', async (t) => {
  const jira = fakeJira();
  const { context, ledger } = setup(t, jira);
  const failing: JiraWriteContext = {
    ...context,
    transport: {
      ...context.transport,
      fetch: async () => {
        await Promise.resolve();
        throw new Error('offline');
      },
    },
  };
  await assert.rejects(createJiraIssueOnce(failing, ledger, REQUEST));
  assert.equal(jira.issues.length, 0);
  await createJiraIssueOnce(context, ledger, REQUEST);
  assert.equal(jira.issues.length, 1, 'no match found, so it is created once');
  const other = { ...REQUEST, requestId: 'feature-2' };
  jira.dropNextResponses = 1;
  await assert.rejects(createJiraIssueOnce(context, ledger, other));
  const duplicate = jira.issues.at(-1);
  assert.ok(duplicate !== undefined);
  jira.issues.push({ ...duplicate, id: '99999', key: 'PROJ-999' });
  await assert.rejects(createJiraIssueOnce(context, ledger, other), /More than one Jira issue carries/v);
});
