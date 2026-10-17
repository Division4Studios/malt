/**
 * DOM-free Inbox rules: question parsing and lanes, answer validation, new-item
 * detection for notifications, and the delivery merge-gate toggle. They import
 * the compiled browser modules, so a bare `npm test` needs `npm run build:web`.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mergeGateControl } from '../web/dist/board-model.js';
import { readConsole } from '../web/dist/console-model.js';
import { answerInput, freshItems, notificationContent } from '../web/dist/inbox-model.js';

const QUESTION = '55555555-5555-4555-8555-555555555555';
const REQUEST = '66666666-6666-4666-8666-666666666666';

/**
 * A console snapshot with the given open Inbox items.
 *
 * @param open - Raw items as the broker projects them.
 * @returns Snapshot holding only the Inbox.
 */
function snapshot(open: readonly Record<string, unknown>[]): unknown {
  return { factory: { console: { deliveries: [], objectives: [], inbox: { open, answered: [] } } } };
}

/** One question as the broker projects it. */
const rawQuestion = {
  id: `question:${QUESTION}`,
  kind: 'question',
  lane: 'reply',
  title: 'developer-1 asks · #4 Pick a format',
  detail: 'JSON or SQLite?',
  since: 10,
  taskId: null,
  featureId: null,
  stepId: 'implement',
  head: null,
  requestId: null,
  questionId: QUESTION,
  choices: ['JSON', 'SQLite', 7, ''],
  allowText: false,
};

await test('questions parse with their choices, and older items fall into their default lane', () => {
  const model = readConsole(
    snapshot([
      rawQuestion,
      { id: 'blocked:x', kind: 'blocked_delivery', title: 'Blocked', detail: 'Stopped', since: 1 },
      { id: 'approval:x', kind: 'approval', lane: 'bogus', title: 'Approve', detail: '', since: 2 },
    ]),
  );
  const [question, blocked, approval] = model.open;
  assert.ok(question !== undefined && blocked !== undefined && approval !== undefined);
  assert.equal(question.questionId, QUESTION);
  assert.deepEqual(question.choices, ['JSON', 'SQLite']);
  assert.equal(question.allowText, false);
  assert.equal(blocked.lane, 'notice');
  assert.equal(approval.lane, 'reply');
});

await test('answers must use an offered choice or allowed text', () => {
  const [item] = readConsole(snapshot([rawQuestion])).open;
  assert.ok(item !== undefined);
  assert.deepEqual(answerInput(item, REQUEST, null, ''), { ok: false, error: 'Choose an option.' });
  assert.deepEqual(answerInput(item, REQUEST, 'YAML', ''), { ok: false, error: 'Choose one of the offered options.' });
  assert.equal(answerInput(item, REQUEST, 'JSON', 'Because').ok, false);
  assert.deepEqual(answerInput(item, REQUEST, 'JSON', '  '), {
    ok: true,
    input: { questionId: QUESTION, requestId: REQUEST, choice: 'JSON', text: '' },
  });
  const [open] = readConsole(snapshot([{ ...rawQuestion, allowText: true, choices: [] }])).open;
  assert.ok(open !== undefined);
  assert.deepEqual(answerInput(open, REQUEST, null, ' Use SQLite. '), {
    ok: true,
    input: { questionId: QUESTION, requestId: REQUEST, choice: null, text: 'Use SQLite.' },
  });
  assert.equal(answerInput(open, REQUEST, null, 'x'.repeat(2001)).ok, false);
  const [approval] = readConsole(snapshot([{ ...rawQuestion, kind: 'approval' }])).open;
  assert.ok(approval !== undefined);
  assert.equal(answerInput(approval, REQUEST, 'JSON', '').ok, false);
});

await test('only reply items that were not open before raise notifications', () => {
  const first = readConsole(snapshot([rawQuestion])).open;
  const initial = freshItems(null, first);
  assert.deepEqual(initial.fresh, [], 'the first snapshot only records what is open');
  const later = readConsole(
    snapshot([
      rawQuestion,
      { ...rawQuestion, id: 'approval:new', kind: 'approval', lane: 'reply' },
      { ...rawQuestion, id: 'blocked:new', kind: 'blocked_delivery', lane: 'notice' },
    ]),
  ).open;
  const next = freshItems(initial.seen, later);
  assert.deepEqual(
    next.fresh.map((item) => item.id),
    ['approval:new'],
  );
  assert.deepEqual(freshItems(next.seen, later).fresh, [], 'each item notifies once');
  const [long] = readConsole(snapshot([{ ...rawQuestion, detail: 'd'.repeat(400) }])).open;
  assert.ok(long !== undefined);
  const content = notificationContent(long);
  assert.equal(content.tag, `malt-inbox:question:${QUESTION}`);
  assert.match(content.title, /^Question: developer-1 asks/v);
  assert.ok(content.body.length <= 180);
});

await test('the merge gate toggles only before a delivery is merge ready', () => {
  const steps = [{ id: 'implement' }, { id: 'operator-merge-gate' }];
  assert.deepEqual(mergeGateControl({ taskId: 't', phase: 'review', steps }), {
    label: 'Remove merge approval',
    input: { taskId: 't', merge: false },
  });
  assert.deepEqual(mergeGateControl({ taskId: 't', phase: 'development', steps: [] })?.input, {
    taskId: 't',
    merge: true,
  });
  assert.equal(mergeGateControl({ taskId: 't', phase: 'merge_ready', steps }), null);
});
