/** @file The Recommendations pane's DOM-free model: page validation, lanes, accessible counts and a poll-stable render key. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { useLocale } from '../web/dist/i18n.js';
import {
  RECOMMENDATION_LANES,
  countLabel,
  laneGroups,
  readPage,
  renderKey,
  ticketText,
} from '../web/dist/recommendations-model.js';

/** Stable fixture identities. */
const ID = 'a'.repeat(64);
/** Second fixture identity. */
const OTHER = 'b'.repeat(64);

/**
 * A summary record as the broker lists it.
 *
 * @param id - Identity.
 * @param state - Lifecycle state.
 * @param isUnread - Unread flag.
 * @returns Untrusted record.
 */
function row(id: string, state: string, isUnread = true): Record<string, unknown> {
  return {
    id,
    revision: 'c'.repeat(64),
    state,
    unread: isUnread,
    isSummary: true,
    body: {
      kind: 'consolidate',
      tickets: [3, 1, 'x', -2],
      action: '<b>Merge</b> #3 into #1',
      evidence: ['Same acceptance', 7],
      preview: { before: 'Two tickets', after: 'One ticket' },
    },
  };
}

/**
 * A list page.
 *
 * @param items - Rows.
 * @param contentRevision - Page digest.
 * @returns Untrusted page.
 */
function page(items: unknown[], contentRevision = 'd'.repeat(64)): Record<string, unknown> {
  return { items, counts: { total: 2, unread: 1, pending: 1, awaitingHuman: 1 }, contentRevision };
}

await test('pages keep valid rows, drop malformed ones and preserve hostile text as data', () => {
  const read = readPage(page([row(ID, 'awaiting_human'), { id: OTHER }, row(OTHER, 'unknown_state'), 'junk']));
  assert.ok(read !== null);
  assert.equal(read.items.length, 1);
  const [item] = read.items;
  assert.ok(item !== undefined);
  assert.equal(item.lane, 'pending');
  assert.equal(item.kind, 'Consolidate tickets');
  assert.deepEqual(item.tickets, [3, 1]);
  assert.equal(item.action, '<b>Merge</b> #3 into #1', 'markup stays literal text for textContent rendering');
  assert.deepEqual(item.evidence, ['Same acceptance']);
  assert.deepEqual(read.counts, { total: 2, unread: 1, pending: 1, awaitingHuman: 1 });
  for (const malformed of [null, [], {}, { items: [] }, { items: 'x', contentRevision: 'r' }]) {
    assert.equal(readPage(malformed), null);
  }
});

await test('every lifecycle state belongs to one lane and lanes keep their order', () => {
  const states = [
    'proposed',
    'awaiting_human',
    'approved',
    'applying',
    'reconciling',
    'completed',
    'rejected',
    'stale',
    'failed',
  ];
  const read = readPage(page(states.map((state, index) => row(String(index).repeat(64).slice(0, 64), state))));
  assert.ok(read !== null);
  assert.equal(read.items.length, states.length);
  assert.deepEqual(
    laneGroups(read.items).map((group) => group.lane),
    RECOMMENDATION_LANES,
  );
  assert.equal(laneGroups(read.items)[0]?.items.length, 2, 'proposed and awaiting human are both pending');
});

await test('an unchanged poll keeps the render key; content, state or read changes alter it', () => {
  const base = readPage(page([row(ID, 'awaiting_human')]));
  const again = readPage(page([row(ID, 'awaiting_human')]));
  assert.ok(base !== null && again !== null);
  assert.equal(renderKey(base), renderKey(again));
  const changed = [
    readPage(page([row(ID, 'awaiting_human')], 'e'.repeat(64))),
    readPage(page([row(ID, 'awaiting_human', false)])),
  ];
  for (const next of changed) {
    assert.ok(next !== null);
    assert.notEqual(renderKey(next), renderKey(base));
  }
});

await test('counts and tickets read naturally in both languages', (t) => {
  t.after(() => {
    useLocale('en');
  });
  const counts = { total: 3, unread: 2, pending: 1, awaitingHuman: 1 };
  assert.equal(countLabel(counts), '1 pending and 2 unread recommendations');
  assert.equal(ticketText([1, 3]), '#1, #3');
  assert.equal(ticketText([]), 'No tickets');
  useLocale('zh-CN');
  assert.equal(countLabel(counts), '1 条待处理、2 条未读建议');
  assert.equal(ticketText([]), '无工单');
});
