/**
 * DOM-free tests of the objective view and spend caps editor models. They
 * import the compiled browser modules, so `npm run check` builds web first.
 *
 * @file
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checklistInput, definitionText, readGoals, readLogPage } from '../web/dist/goal-model.js';

/** Objective ids. */
const OBJECTIVE = '00000000-0000-4000-8000-000000000001';
const ITEM = '00000000-0000-4000-8000-000000000002';
const PROPOSAL = '00000000-0000-4000-8000-000000000003';

/** A snapshot carrying one objective with a checklist. */
const snapshot = {
  factory: {
    console: {
      goals: [
        {
          featureId: OBJECTIVE,
          title: 'Checkout redesign',
          objective: 'Checkout redesign\n\nDetails',
          phase: 'active',
          updatedAt: 42,
          deliveries: { total: 2, done: 2 },
          definition: {
            items: [
              { id: ITEM, text: 'Audit passes', state: 'checked', by: 'final-tester', at: 40, evidence: 'Report' },
              { id: PROPOSAL, text: 'p95 below 300 ms', state: 'proposed', by: 'team-lead', at: 41, evidence: 'x' },
              { id: 'broken', state: 'unknown' },
            ],
            met: 1,
            proposed: 1,
            total: 2,
          },
          awaitsDefinition: true,
        },
        { title: 'missing id' },
      ],
    },
  },
};

void test('objectives read from the snapshot with checklist progress', () => {
  const [goal] = readGoals(snapshot);
  assert.ok(goal !== undefined);
  assert.equal(readGoals(snapshot).length, 1, 'Entries without an id are skipped.');
  assert.deepEqual(
    goal.items.map((item) => item.state),
    ['checked', 'proposed'],
  );
  assert.equal(goal.awaitsDefinition, true);
  assert.equal(definitionText(goal), '1 of 1 criteria met · 1 proposed');
  assert.equal(definitionText({ items: [], met: 0, proposed: 0 }), 'No definition of done yet');
  assert.deepEqual(readGoals({}), []);
});

void test('checklist rows validate into a version-fenced save, dismissing absent proposals', () => {
  const [goal] = readGoals(snapshot);
  assert.ok(goal !== undefined);
  const saved = checklistInput(goal, [
    { id: ITEM, text: ' Audit passes ', state: 'checked', evidence: '' },
    { id: '', text: 'Docs updated', state: 'open', evidence: ' link ' },
    { id: '', text: '', state: 'open', evidence: '' },
  ]);
  assert.ok('input' in saved);
  assert.deepEqual(saved.input, {
    featureId: OBJECTIVE,
    expectedUpdatedAt: 42,
    items: [
      { id: ITEM, text: 'Audit passes', state: 'checked', evidence: null },
      { text: 'Docs updated', state: 'open', evidence: 'link' },
    ],
  });
  assert.match(
    JSON.stringify(checklistInput(goal, [{ id: ITEM, text: 'x', state: 'proposed', evidence: '' }])),
    /choose open, checked or waived/v,
  );
  assert.match(
    JSON.stringify(checklistInput(goal, [{ id: 'gone', text: 'x', state: 'open', evidence: '' }])),
    /checklist changed/v,
  );
  assert.match(
    JSON.stringify(checklistInput(goal, [{ id: ITEM, text: '', state: 'open', evidence: '' }])),
    /needs text/v,
  );
});

void test('log pages keep valid entries and their older-page cursor', () => {
  const page = readLogPage({
    entries: [{ seq: 9, at: 1, kind: 'note', actor: 'operator', body: 'Hi' }, 'junk'],
    total: 12,
    next: 9,
  });
  assert.equal(page.entries.length, 1);
  assert.equal(page.next, 9);
  assert.equal(readLogPage({ entries: [], total: 0, next: null }).next, null);
});
