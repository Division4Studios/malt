/**
 * DOM-free tests of the workflow revision history model. They import the
 * compiled browser module, so `npm run check` builds web first; a bare
 * `npm test` needs `npm run build:web`.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { diffRevisions, parseHistory, usageText } from '../web/dist/workflow-history-model.js';

/**
 * A minimal step record as the broker sends it.
 *
 * @param id - Step key, also used as its title.
 * @param fields - Fields that differ from the defaults.
 * @returns Step record.
 */
function step(id: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, kind: 'review', title: id, roles: ['qa-1'], after: [], blind: false, gate: false, ...fields };
}

const response = {
  workflowId: 'team-quick',
  source: 'project',
  current: 'b'.repeat(64),
  revisions: [
    {
      revision: 'b'.repeat(64),
      createdAt: 20,
      isCurrent: true,
      workflow: {
        id: 'team-quick',
        name: 'Team quick',
        description: 'Reviewed once.',
        planning: [],
        delivery: [
          step('implement', { kind: 'implement' }),
          step('review', { roles: ['qa-2'], blind: true }),
          step('final'),
        ],
      },
      objectives: [{ featureId: 'f', title: 'New work', phase: 'active' }],
      objectiveCount: 1,
      deliveryCount: 2,
    },
    {
      revision: 'a'.repeat(64),
      createdAt: null,
      isCurrent: false,
      workflow: {
        id: 'team-quick',
        name: 'Quick',
        description: '',
        planning: [],
        delivery: [step('implement', { kind: 'implement' }), step('review'), step('docs', { kind: 'document' })],
      },
      objectives: [],
      objectiveCount: 0,
      deliveryCount: 0,
    },
    { revision: '', workflow: {} },
  ],
};

await test('the history decodes revisions, drops nameless ones and survives malformed input', () => {
  const history = parseHistory(response);
  assert.equal(history.source, 'project');
  assert.deepEqual(
    history.revisions.map((revision) => [revision.isCurrent, revision.createdAt, revision.workflow.name]),
    [
      [true, 20, 'Team quick'],
      [false, null, 'Quick'],
    ],
  );
  assert.deepEqual(parseHistory('nope'), { workflowId: '', source: 'frozen', revisions: [] });
  assert.equal(parseHistory({ ...response, source: 'other' }).source, 'frozen');
});

await test('two revisions compare step by step in plain words', () => {
  const [current, older] = parseHistory(response).revisions;
  assert.ok(current !== undefined && older !== undefined);
  const diff = diffRevisions(older.workflow, current.workflow);
  assert.deepEqual(diff.workflow, ['name: Quick → Team quick', 'description changed']);
  assert.deepEqual(
    diff.steps.map((change) => [change.change, change.id, change.details]),
    [
      ['changed', 'review', ['seats: qa-1 → qa-2', 'blind review: no → yes']],
      ['added', 'final', []],
      ['removed', 'docs', []],
    ],
  );
  assert.deepEqual(diffRevisions(current.workflow, current.workflow), { workflow: [], steps: [] });
});

await test('usage reads as one sentence', () => {
  const [current, older] = parseHistory(response).revisions;
  assert.ok(current !== undefined && older !== undefined);
  assert.equal(usageText(current), 'Frozen by 1 objective and 2 deliveries.');
  assert.equal(usageText(older), 'No objective or delivery runs it.');
});
