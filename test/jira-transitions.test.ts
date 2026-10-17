/** @file Jira transition planning: mapped stages, missing transitions, required fields and deleted issues, from fixtures. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { JiraRequestError } from '../src/jira/client.ts';
import { mappingProblems, planTransition, readTransitions, stageMappingSchema } from '../src/jira/transitions.ts';

import type { JiraFetch, JiraTransport } from '../src/jira/client.ts';
import type { JiraTransition, StageMapping } from '../src/jira/transitions.ts';

/**
 * A transport answering one transitions document, or 404.
 *
 * @param body - Transitions document, or `null` for a deleted issue.
 * @returns The transport and every requested URL.
 */
function transport(body: unknown): { transport: JiraTransport; urls: string[] } {
  const urls: string[] = [];
  const fetch: JiraFetch = async (url) => {
    await Promise.resolve();
    urls.push(url);
    const text = JSON.stringify(body ?? { errorMessages: ['Issue does not exist'] });
    return {
      status: body === null ? 404 : 200,
      headers: { get: () => null },
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
    urls,
  };
}

/** A workflow: To Do → In Progress → In Review → Done, where Done needs a resolution. */
const TRANSITIONS = {
  transitions: [
    { id: '21', name: 'Start', to: { id: '3', name: 'In Progress', statusCategory: { key: 'indeterminate' } } },
    {
      id: '31',
      name: 'Review',
      to: { id: '4', name: 'In Review' },
      fields: { comment: { required: false, name: 'Comment' } },
    },
    {
      id: '41',
      name: 'Finish',
      to: { id: '5', name: 'Done', statusCategory: { key: 'done' } },
      fields: {
        resolution: { required: true, name: 'Resolution', hasDefaultValue: false },
        fixVersions: { required: true, name: 'Fix versions', hasDefaultValue: true },
      },
    },
  ],
};
/** Development → In Progress, QA → In Review, Done → Done. */
const MAPPING: StageMapping = stageMappingSchema.parse({
  Development: { statusId: '3', statusName: 'In Progress' },
  'QA / Review': { statusId: '4', statusName: 'In Review' },
  Done: { statusId: '5', statusName: 'Done' },
  'Final Verification': { statusId: '9', statusName: 'Verifying' },
});

/**
 * The fixture's transitions, read through the client.
 *
 * @returns Transitions with their required fields.
 */
async function transitions(): Promise<JiraTransition[]> {
  const fixture = transport(TRANSITIONS);
  const read = await readTransitions(fixture.transport, 'PROJ-1');
  assert.equal(
    fixture.urls[0],
    'https://example.atlassian.net/rest/api/3/issue/PROJ-1/transitions?expand=transitions.fields',
  );
  return read;
}

await test('transitions are read with their required screen fields', async () => {
  const read = await transitions();
  assert.deepEqual(
    read.map((transition) => [transition.id, transition.to.name, transition.requiredFields.map((field) => field.name)]),
    [
      ['21', 'In Progress', []],
      ['31', 'In Review', []],
      ['41', 'Done', ['Resolution']],
    ],
    'optional fields and fields with defaults are not required',
  );
  assert.equal(read[0]?.to.category, 'indeterminate');
  assert.equal(read[1]?.to.category, null);
});

await test('a mapped stage plans the transition that reaches its status', async () => {
  const plan = planTransition({
    mapping: MAPPING,
    stage: 'QA / Review',
    issueKey: 'PROJ-1',
    currentStatusId: '3',
    transitions: await transitions(),
  });
  assert.ok(plan.kind === 'transition');
  assert.equal(plan.transition.id, '31');
  assert.deepEqual(
    planTransition({
      mapping: MAPPING,
      stage: 'QA / Review',
      issueKey: 'PROJ-1',
      currentStatusId: '4',
      transitions: [],
    }),
    { kind: 'already' },
  );
});

await test('an unmapped stage, a missing transition or a required field is one explicit blocker', async () => {
  const available = await transitions();
  const base = { mapping: MAPPING, issueKey: 'PROJ-1', currentStatusId: '1', transitions: available } as const;
  const unmapped = planTransition({ ...base, stage: 'Ready' });
  assert.equal(unmapped.kind === 'blocked' ? unmapped.reason : null, 'unmapped');
  const missing = planTransition({ ...base, stage: 'Final Verification' });
  assert.equal(missing.kind === 'blocked' ? missing.reason : null, 'no_transition');
  assert.match(missing.kind === 'blocked' ? missing.message : '', /PROJ-1 has no transition to "Verifying"/v);
  const fields = planTransition({ ...base, stage: 'Done' });
  assert.equal(fields.kind === 'blocked' ? fields.reason : null, 'required_fields');
  assert.deepEqual(fields.kind === 'blocked' ? fields.fields : [], [{ id: 'resolution', name: 'Resolution' }]);
});

await test('a deleted issue is reported, not guessed', async () => {
  await assert.rejects(
    readTransitions(transport(null).transport, 'PROJ-404'),
    (error: unknown) => error instanceof JiraRequestError && error.failure === 'not_found',
  );
});

await test('a mapping is checked against the project workflows before it is saved', () => {
  const types = [
    {
      id: '1',
      name: 'Story',
      subtask: false,
      statuses: [
        { id: '3', name: 'In Progress' },
        { id: '4', name: 'In Review' },
      ],
    },
    { id: '2', name: 'Bug', subtask: false, statuses: [{ id: '5', name: 'Done' }] },
  ];
  assert.deepEqual(mappingProblems(MAPPING, types), [
    '"Final Verification" is mapped to "Verifying", which no workflow in this project has.',
  ]);
  assert.equal(stageMappingSchema.safeParse({ Shipping: { statusId: '1', statusName: 'X' } }).success, false);
});
