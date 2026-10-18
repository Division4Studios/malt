/**
 * DOM-free tests of the Inbox, Board and delivery view helpers. They import
 * the compiled browser modules, so `npm run check` builds web first; a bare
 * `npm test` needs `npm run build:web`.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { approvalInput, isPending, targetFromItem, targetFromStep } from '../web/dist/approval-model.js';
import {
  bulkTargets,
  groupBoard,
  lifecycleControl,
  parsePrefs,
  tabTarget,
  workflowChoices,
} from '../web/dist/board-model.js';
import {
  excerpt,
  findingSeverity,
  inboxCount,
  layerGroups,
  readConsole,
  relativeAge,
  runningText,
  shortSha,
  stepStrip,
} from '../web/dist/console-model.js';

const TASK = '11111111-1111-4111-8111-111111111111';
const DONE_TASK = '22222222-2222-4222-8222-222222222222';
const FEATURE = '33333333-3333-4333-8333-333333333333';
const HEAD = 'abcdef0123456789abcdef0123456789abcdef01';
const REQUEST = '44444444-4444-4444-8444-444444444444';

/**
 * Build one step record as the broker projects it.
 *
 * @param id - Identifier, also used as the kind and title stem.
 * @param state - Plain state such as `running`.
 * @param layer - One-based execution layer.
 * @returns Step record.
 */
function step(id: string, state: string, layer: number): Record<string, unknown> {
  return {
    id,
    title: `${id} step`,
    kind: id,
    layer,
    roles: ['qa-1'],
    state,
    gate: false,
    blind: id === 'security',
    provider: null,
    result: null,
  };
}

/**
 * Build a snapshot carrying a console projection.
 *
 * @returns Snapshot shaped like `/api/snapshot`.
 */
function snapshotFixture(): Record<string, unknown> {
  return {
    factory: {
      console: {
        deliveries: [
          {
            taskId: TASK,
            issue: 12,
            title: 'Add <b>login</b>',
            featureId: FEATURE,
            phase: 'review',
            column: 'needs_you',
            workflow: { id: 'standard', name: 'Standard' },
            steps: [
              step('implement', 'done', 1),
              step('review', 'running', 2),
              step('security', 'needs_you', 2),
              step('final', 'waiting', 3),
            ],
            running: { jobId: 'job-1', role: 'qa-1', step: 'review' },
            head: HEAD,
            base: null,
            prUrl: 'https://github.com/o/r/pull/3',
            developer: 'developer-1',
            waitingOn: [7, 'x'],
            attempts: 2,
            error: null,
            updatedAt: 1000,
          },
          {
            taskId: DONE_TASK,
            issue: 5,
            title: 'Docs',
            featureId: null,
            phase: 'done',
            column: 'done',
            workflow: { id: 'docs', name: 'Docs only' },
            steps: [],
            running: null,
            head: null,
            base: null,
            prUrl: null,
            developer: null,
            waitingOn: [],
            attempts: 1,
            error: null,
            updatedAt: 900,
          },
          { title: 'missing id is skipped' },
          'not an object',
        ],
        objectives: [
          {
            featureId: FEATURE,
            title: 'Accounts',
            phase: 'refining',
            column: 'planning',
            workflow: { id: 'standard', name: 'Standard' },
            steps: [step('plan', 'running', 1)],
            deliveries: { total: 2, done: 1 },
            error: null,
            createdAt: 10,
          },
        ],
        inbox: {
          open: [
            {
              id: `approval:${TASK}:security`,
              kind: 'approval',
              title: 'Security review · #12 Add <b>login</b>',
              detail: 'This gated step finished and waits for your approval.',
              since: 1000,
              taskId: TASK,
              featureId: null,
              stepId: 'security',
              head: HEAD,
              requestId: null,
            },
            {
              id: `plan:${FEATURE}:approve-plan`,
              kind: 'plan_approval',
              title: 'Approve plan · Accounts',
              detail: '',
              since: 1100,
              taskId: null,
              featureId: FEATURE,
              stepId: 'approve-plan',
              head: null,
              requestId: null,
            },
            { id: 'unknown:1', kind: 'mystery', title: 'skipped' },
          ],
          answered: [{ id: REQUEST, title: 'Approved review · #4 Old', note: 'fine', at: 500 }],
        },
      },
    },
  };
}

void test('the console projection is read defensively from untrusted snapshot data', () => {
  const model = readConsole(snapshotFixture());
  assert.deepEqual(
    model.deliveries.map((delivery) => delivery.taskId),
    [TASK, DONE_TASK],
  );
  const [first] = model.deliveries;
  assert.ok(first !== undefined);
  assert.equal(first.title, 'Add <b>login</b>', 'markup stays plain text for textContent rendering');
  assert.deepEqual(first.waitingOn, [7]);
  assert.equal(model.open.length, 2, 'unknown decision kinds are skipped');
  assert.equal(model.answered.length, 1);
  assert.equal(inboxCount(snapshotFixture()), 2);
  for (const malformed of [
    null,
    'text',
    [],
    {},
    { factory: { console: 'x' } },
    { factory: { console: { deliveries: 5 } } },
  ]) {
    assert.equal(inboxCount(malformed), 0);
    assert.deepEqual(readConsole(malformed).deliveries, []);
  }
  const odd = readConsole({
    factory: {
      console: { deliveries: [{ taskId: 'a', column: 'sideways', steps: [{ id: 's', state: 'exploded' }] }] },
    },
  });
  assert.deepEqual(
    odd.deliveries.map((delivery) => [delivery.column, delivery.steps.map((member) => member.state)]),
    [['in_progress', ['waiting']]],
    'unknown columns and states fall back to neutral values',
  );
});

void test('board groups cards into five columns and applies filters', () => {
  const model = readConsole(snapshotFixture());
  const all = groupBoard(model, { query: '', workflow: '', showDone: true });
  assert.deepEqual(
    Object.entries(all.columns).map(([column, cards]) => [column, cards.map((card) => card.key)]),
    [
      ['planning', [`objective:${FEATURE}`]],
      ['ready', []],
      ['in_progress', []],
      ['needs_you', [`delivery:${TASK}`]],
      ['done', [`delivery:${DONE_TASK}`]],
    ],
  );
  const hidden = groupBoard(model, { query: '', workflow: '', showDone: false });
  assert.deepEqual(hidden.columns['done'], []);
  assert.equal(hidden.hiddenDone, 1);
  assert.deepEqual(
    groupBoard(model, { query: '#12', workflow: '', showDone: true }).columns['needs_you']?.map((card) => card.key),
    [`delivery:${TASK}`],
  );
  assert.equal(groupBoard(model, { query: '#12', workflow: '', showDone: true }).columns['planning']?.length, 0);
  assert.equal(groupBoard(model, { query: 'LOGIN', workflow: '', showDone: true }).columns['needs_you']?.length, 1);
  assert.equal(groupBoard(model, { query: 'accounts', workflow: '', showDone: true }).columns['planning']?.length, 1);
  const byWorkflow = groupBoard(model, { query: '', workflow: 'docs', showDone: true });
  assert.equal(byWorkflow.columns['needs_you']?.length, 0);
  assert.equal(byWorkflow.columns['done']?.length, 1);
  assert.deepEqual(workflowChoices(model), [
    { id: 'docs', name: 'Docs only' },
    { id: 'standard', name: 'Standard' },
  ]);
});

void test('saved board preferences are validated and tab keys wrap around', () => {
  assert.deepEqual(parsePrefs(null), { query: '', workflow: '', showDone: false, tab: 'needs_you' });
  assert.deepEqual(parsePrefs('not json'), parsePrefs(null));
  assert.deepEqual(parsePrefs('[1]'), parsePrefs(null));
  assert.deepEqual(parsePrefs(JSON.stringify({ query: 'x', workflow: 7, showDone: true, tab: 'done' })), {
    query: 'x',
    workflow: '',
    showDone: true,
    tab: 'done',
  });
  assert.equal(parsePrefs(JSON.stringify({ tab: 'elsewhere' })).tab, 'needs_you');
  assert.equal(tabTarget(4, 'ArrowRight', 5), 0);
  assert.equal(tabTarget(0, 'ArrowLeft', 5), 4);
  assert.equal(tabTarget(2, 'Home', 5), 0);
  assert.equal(tabTarget(2, 'End', 5), 4);
  assert.equal(tabTarget(2, 'Enter', 5), null);
  assert.equal(tabTarget(2, 'constructor', 5), null);
});

void test('step strips, layers and running text describe the pipeline', () => {
  const [delivery] = readConsole(snapshotFixture()).deliveries;
  assert.ok(delivery !== undefined);
  const strip = stepStrip(delivery.steps);
  assert.equal(strip.caption, '1 of 4 steps done');
  assert.deepEqual(
    strip.segments.map((segment) => [segment.state, segment.label]),
    [
      ['done', 'implement step: Done'],
      ['running', 'review step: Running'],
      ['needs_you', 'security step: Needs you'],
      ['waiting', 'final step: Waiting'],
    ],
  );
  assert.deepEqual(
    layerGroups(delivery.steps).map((group) => [group.layer, group.steps.map((member) => member.id)]),
    [
      [1, ['implement']],
      [2, ['review', 'security']],
      [3, ['final']],
    ],
  );
  assert.equal(runningText(delivery), 'qa-1 · review step');
});

void test('formatting helpers bound ages, shas, errors and severities', () => {
  const now = 10_000_000;
  assert.equal(relativeAge(0, now), 'unknown time');
  assert.equal(relativeAge(now - 30_000, now), 'just now');
  assert.equal(relativeAge(now - 185_000, now), '3m 05s ago');
  assert.equal(relativeAge(now, now + 6 * 86_400_000 + 5000), '6d ago');
  assert.equal(shortSha(HEAD), 'abcdef0');
  assert.equal(shortSha(null), '—');
  assert.equal(excerpt('a\nb\nc'), 'a\nb\nc');
  assert.equal(excerpt('a\nb\nc\nd'), 'a\nb\nc…');
  assert.deepEqual(findingSeverity('[P1] Missing check'), { severity: 'P1', text: 'Missing check' });
  assert.deepEqual(findingSeverity('[P7] Not a severity'), { severity: null, text: '[P7] Not a severity' });
  assert.deepEqual(findingSeverity('No tag'), { severity: null, text: 'No tag' });
});

void test('approval requests bind the right owner, head and note', () => {
  const model = readConsole(snapshotFixture());
  const [deliveryItem, planItem] = model.open;
  assert.ok(deliveryItem !== undefined && planItem !== undefined);
  const deliveryTarget = targetFromItem(deliveryItem);
  assert.ok(deliveryTarget !== null);
  assert.equal(deliveryTarget.stepTitle, 'Security review');
  assert.equal(deliveryTarget.subject, '#12 Add <b>login</b>');
  assert.deepEqual(approvalInput(deliveryTarget, { requestId: REQUEST, approve: true, note: '  ok  ' }), {
    input: { requestId: REQUEST, taskId: TASK, stepId: 'security', head: HEAD, approve: true, note: 'ok' },
  });
  assert.deepEqual(approvalInput(deliveryTarget, { requestId: REQUEST, approve: false, note: ' '.repeat(3) }), {
    error: 'Explain what must change before rejecting.',
  });
  assert.ok('error' in approvalInput(deliveryTarget, { requestId: REQUEST, approve: true, note: 'x'.repeat(4001) }));
  const planTarget = targetFromItem(planItem);
  assert.ok(planTarget !== null);
  assert.deepEqual(approvalInput(planTarget, { requestId: REQUEST, approve: false, note: 'Split it' }), {
    input: {
      requestId: REQUEST,
      featureId: FEATURE,
      stepId: 'approve-plan',
      head: null,
      approve: false,
      note: 'Split it',
    },
  });
  assert.equal(
    targetFromItem({ ...deliveryItem, kind: 'blocked_delivery', id: `blocked:${TASK}` }),
    null,
    'only approvals open the dialog',
  );
  assert.ok(isPending(deliveryTarget, model.open));
  assert.ok(!isPending(deliveryTarget, [planItem]));
  const [delivery] = model.deliveries;
  const security = delivery?.steps.find((candidate) => candidate.id === 'security');
  assert.ok(delivery !== undefined && security !== undefined);
  const fromStep = targetFromStep({ ...delivery, head: 'newer' }, security, model.open);
  assert.equal(fromStep.head, HEAD, 'the Inbox item head wins over the current delivery head');
  assert.equal(targetFromStep({ ...delivery, head: 'newer' }, security, []).head, 'newer');
});

await test('lifecycle controls hold, resume and archive exactly the deliveries shown', () => {
  const model = readConsole(snapshotFixture());
  const [open, finished] = model.deliveries;
  assert.ok(open !== undefined && finished !== undefined);
  assert.deepEqual(lifecycleControl(open), {
    label: 'Hold',
    operation: 'factory_hold',
    input: { taskIds: [TASK], hold: true },
  });
  assert.equal(lifecycleControl({ ...open, held: { at: 1, reason: 'Freeze' } }).label, 'Resume');
  assert.deepEqual(lifecycleControl(finished).input, { taskIds: [DONE_TASK], archive: true });
  const shown = groupBoard(model, { query: '', workflow: '', showDone: true });
  assert.deepEqual(bulkTargets(shown), { hold: [TASK], resume: [] }, 'Finished deliveries are never held.');
  assert.deepEqual(bulkTargets(groupBoard(model, { query: 'no such card', workflow: '', showDone: true })), {
    hold: [],
    resume: [],
  });
  const held = readConsole({
    factory: {
      console: {
        deliveries: [
          { taskId: TASK, issue: 1, title: 'x', column: 'ready', phase: 'ready', held: { at: 2, reason: 'r' } },
        ],
        archived: { total: 3, recent: [{ taskId: DONE_TASK, issue: 9, title: 'Old' }, { issue: 2 }] },
      },
    },
  });
  assert.deepEqual(held.deliveries[0]?.held, { at: 2, reason: 'r' });
  assert.deepEqual(held.archived, { total: 3, recent: [{ taskId: DONE_TASK, issue: 9, title: 'Old' }] });
});
