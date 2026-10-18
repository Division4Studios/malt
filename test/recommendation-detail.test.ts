/** @file An opened recommendation loads its full detail and shows the context a decision rests on, as inert text. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readDetail } from '../web/dist/recommendations-model.js';
import { createRecommendationsView } from '../web/dist/recommendations-ui.js';

import { fake, installDom } from './dom-shim.ts';

/** Assignment text that must stay inert. */
const HOSTILE = '<img src=x onerror="globalThis.pwnedDetail=true">';
/** One awaiting-human consolidation with its full decision context. */
const record = {
  id: 'a'.repeat(64),
  revision: 'b'.repeat(64),
  state: 'awaiting_human',
  unread: false,
  body: {
    kind: 'consolidate',
    tickets: [1, 3],
    action: 'Merge #3 into #1',
    evidence: ['Same acceptance'],
    preview: { before: 'Two tickets', after: 'One ticket' },
    survivor: 1,
    transferredAcceptance: ['Keeps the export'],
    transferredDependencies: [4],
    affectedAssignments: [HOSTILE],
  },
  audit: [],
};

await test('details validate the decision context and reject malformed responses', () => {
  const detail = readDetail({ recommendation: record, contentRevision: 'c'.repeat(64) });
  assert.ok(detail !== null);
  assert.equal(detail.survivor, 1);
  assert.deepEqual(detail.transferredAcceptance, ['Keeps the export']);
  assert.deepEqual(detail.transferredDependencies, [4]);
  assert.deepEqual(detail.affectedAssignments, [HOSTILE]);
  assert.equal(readDetail({ recommendation: { ...record, state: 'unknown' } }), null);
  assert.equal(readDetail({}), null);
});

await test('opening a row loads its detail and shows the whole context as text', async (t) => {
  const dom = installDom(t);
  const requested: string[] = [];
  const pane = createRecommendationsView({
    list: async () => {
      await Promise.resolve();
      return { items: [record], counts: { total: 1, unread: 0, pending: 1, awaitingHuman: 1 }, contentRevision: 'd' };
    },
    markRead: async () => {
      await Promise.resolve();
      throw new Error('Already read.');
    },
    detail: async (id) => {
      requested.push(id);
      await Promise.resolve();
      return { recommendation: record, contentRevision: 'e' };
    },
    decide: async () => {
      await Promise.resolve();
      throw new Error('Not needed here.');
    },
  });
  const root = fake(pane.element);
  dom.body.append(root);
  await pane.refresh();
  const [open] = root.querySelector('button')?.listeners.get('click') ?? [];
  assert.ok(typeof open === 'function');
  Reflect.apply(open, undefined, []);
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  assert.deepEqual(requested, ['a'.repeat(64)]);
  for (const expected of ['bbbbbbbbbbbb', '#1, #3', 'Keeps the export', '#4', 'Two tickets', 'One ticket', HOSTILE]) {
    assert.ok(root.textContent.includes(expected), expected);
  }
  assert.equal(root.querySelector('img'), null);
  assert.equal(Reflect.get(globalThis, 'pwnedDetail'), undefined);
});
