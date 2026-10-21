/** @file The Connections view's DOM-free Jira workflow model: reading the saved workflow and building its save. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  readIntakePreview,
  readJiraWorkflow,
  skipReasonLabel,
  workflowDraft,
  workflowProblem,
  workflowSaveInput,
} from '../web/dist/jira-workflow-model.js';

/** Statuses of the saved tracker. */
const STATUSES = [
  { id: '10', name: 'To Do' },
  { id: '13', name: 'Done' },
];

await test('only a Jira tracker has a workflow, read with its statuses and last intake', () => {
  assert.equal(readJiraWorkflow({ connectionV2: { tracker: { provider: 'github-projects' } } }), null);
  const view = readJiraWorkflow({
    connectionV2: {
      tracker: {
        provider: 'jira',
        workflowField: { options: STATUSES },
        jira: {
          workflow: { stages: { Done: { statusId: '13', statusName: 'Done' }, Unknown: { statusId: '10' } } },
        },
      },
    },
    jiraIntake: { checkedAt: 'now', offered: ['PROJ-1', 3], skipped: [], retryAfterSeconds: null, error: null },
  });
  assert.deepEqual(view, {
    jql: '',
    stages: { Done: '13' },
    statuses: STATUSES,
    lastIntake: { checkedAt: 'now', offered: ['PROJ-1'], skipped: [], retryAfterSeconds: 0, error: '' },
  });
});

await test('a save names each mapped status, drops unknown ones and turns an empty filter off', () => {
  const view = { jql: 'project = PROJ', stages: { Done: '13' }, statuses: STATUSES, lastIntake: null };
  const draft = workflowDraft(view);
  assert.deepEqual(workflowSaveInput({ ...draft, stages: { ...draft.stages, Ready: '99' } }, STATUSES), {
    operation: 'jira_workflow_save',
    input: { jql: 'project = PROJ', stages: { Done: { statusId: '13', statusName: 'Done' } } },
  });
  assert.deepEqual(workflowSaveInput({ jql: ' ', stages: {} }, STATUSES).input, { jql: null, stages: {} });
  assert.equal(workflowProblem(draft), null);
  assert.match(workflowProblem({ jql: 'x'.repeat(2001), stages: {} }) ?? '', /2,000 characters/v);
});

await test('a save preview and skip reasons read as the operator sees them', () => {
  assert.equal(readIntakePreview({ intakePreview: null }), null);
  assert.deepEqual(
    readIntakePreview({ intakePreview: { queue: ['PROJ-1'], skipped: [{ key: 'PROJ-2', reason: 'done' }] } }),
    { queue: ['PROJ-1'], skipped: [{ key: 'PROJ-2', reason: 'done' }], isTruncated: false },
  );
  assert.equal(skipReasonLabel('reassigned'), 'assigned to someone else');
  assert.equal(skipReasonLabel('mystery'), 'mystery');
});
