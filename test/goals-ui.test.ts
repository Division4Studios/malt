/**
 * DOM-free tests of the objective view and spend caps editor models. They
 * import the compiled browser modules, so `npm run check` builds web first.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checklistInput, definitionText, goalProgress, readGoals, readLogPage } from '../web/dist/goal-model.js';
import { NO_CAP, capProgress, capsInput, overrideText, readSpend } from '../web/dist/spend-model.js';

/** Objective ids. */
const OBJECTIVE = '00000000-0000-4000-8000-000000000001';
const ITEM = '00000000-0000-4000-8000-000000000002';
const PROPOSAL = '00000000-0000-4000-8000-000000000003';
const DELIVERY = '00000000-0000-4000-8000-000000000004';

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

void test('the Mission overview lists unfinished objectives with a definition of done, waiting ones first', () => {
  const { goals } = snapshot.factory.console;
  const plain = {
    ...goals[0],
    featureId: DELIVERY,
    title: 'Plain',
    awaitsDefinition: false,
    definition: { items: [], met: 0, proposed: 0 },
  };
  const finished = { ...goals[0], featureId: PROPOSAL, title: 'Shipped', phase: 'done' };
  const later = { ...goals[0], featureId: ITEM, title: 'Later', awaitsDefinition: false };
  const rows = goalProgress({ factory: { console: { goals: [later, plain, finished, goals[0]] } } });
  assert.deepEqual(
    rows.map((row) => [row.title, row.awaitsDefinition]),
    [
      ['Checkout redesign', true],
      ['Later', false],
    ],
    'objectives without a checklist and finished ones are left out',
  );
  assert.equal(rows[0]?.progress, '1 of 1 criteria met · 1 proposed');
  assert.deepEqual(goalProgress({}), []);
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

/** A cost summary carrying caps and spend. */
const summary = {
  spend: {
    revision: 3,
    caps: {
      project: 100,
      windowDays: 30,
      objectiveDefault: null,
      deliveryDefault: 2,
      objectives: {},
      deliveries: { [DELIVERY]: null },
      unpriced: 'block',
    },
    usage: [
      { scope: 'project', id: '', label: 'Project', usd: 85, unpricedAttempts: 0, cap: 100, blocked: null },
      { scope: 'delivery', id: DELIVERY, label: '#4 Card', usd: 2.5, unpricedAttempts: 1, cap: 2, blocked: 'cap' },
    ],
  },
};

void test('spend rows describe progress toward each cap', () => {
  const status = readSpend(summary);
  const [project, delivery] = status.usage;
  assert.ok(project !== undefined && delivery !== undefined);
  assert.deepEqual(capProgress(project), { percent: 85, text: '$85.00 of $100.00 (85%)', state: 'near' });
  assert.equal(capProgress(delivery).state, 'reached');
  assert.match(capProgress(delivery).text, /1 unpriced · cap reached/v);
  assert.equal(capProgress({ ...project, cap: null }).state, 'uncapped');
  assert.equal(overrideText(status.caps, delivery), NO_CAP);
  assert.equal(overrideText(status.caps, project), '');
});

void test('typed caps validate into a revision-fenced request with overrides', () => {
  const status = readSpend(summary);
  const form = {
    project: '150',
    windowDays: '7',
    objectiveDefault: '',
    deliveryDefault: '2.5',
    unpriced: 'ignore',
    overrides: [{ scope: 'delivery', id: DELIVERY, value: '' }],
  };
  const result = capsInput(status, form);
  assert.ok('input' in result);
  assert.deepEqual(result.input, {
    expectedRevision: 3,
    caps: {
      project: 150,
      windowDays: 7,
      objectiveDefault: null,
      deliveryDefault: 2.5,
      objectives: {},
      deliveries: {},
      unpriced: 'ignore',
    },
  });
  const lifted = capsInput(status, { ...form, overrides: [{ scope: 'objective', id: DELIVERY, value: 'NONE' }] });
  assert.ok('input' in lifted);
  assert.deepEqual(lifted.input, {
    expectedRevision: 3,
    caps: {
      project: 150,
      windowDays: 7,
      objectiveDefault: null,
      deliveryDefault: 2.5,
      objectives: { [DELIVERY]: null },
      deliveries: { [DELIVERY]: null },
      unpriced: 'ignore',
    },
  });
  assert.match(JSON.stringify(capsInput(status, { ...form, project: '-1' })), /positive dollar amount/v);
  assert.match(JSON.stringify(capsInput(status, { ...form, windowDays: '0' })), /1 to 90 days/v);
  assert.match(
    JSON.stringify(capsInput(status, { ...form, overrides: [{ scope: 'delivery', id: DELIVERY, value: 'lots' }] })),
    /Use none/v,
  );
});
