/** @file Project → Recommendations rendered into a text-only DOM: inert text, poll stability, keyboard rows, read receipts and counts. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createRecommendationsView } from '../web/dist/recommendations-ui.js';

import { FakeElement, fake, installDom } from './dom-shim.ts';

/** Markup and markdown a proposal could carry; both must stay text. */
const HOSTILE = '<img src=x onerror="globalThis.pwnedRecommendation=true"> **merge** [link](javascript:alert(1))';

/**
 * A page with one unread awaiting-human proposal.
 *
 * @param isUnread - Unread flag.
 * @returns Untrusted page.
 */
function page(isUnread = true): Record<string, unknown> {
  return {
    items: [
      {
        id: 'a'.repeat(64),
        revision: 'b'.repeat(64),
        state: 'awaiting_human',
        unread: isUnread,
        body: {
          kind: 'related',
          tickets: [4, 9],
          action: HOSTILE,
          evidence: ['Same files'],
          preview: { before: 'Two', after: 'Linked' },
        },
      },
    ],
    counts: { total: 1, unread: isUnread ? 1 : 0, pending: 1, awaitingHuman: 1 },
    contentRevision: 'c'.repeat(64),
  };
}

/**
 * Mount the pane with a fake broker.
 *
 * @param t - Test context.
 * @returns The pane, its root, the Project badge and recorded read receipts.
 */
function mount(t: Parameters<typeof installDom>[0]): {
  pane: ReturnType<typeof createRecommendationsView>;
  dom: ReturnType<typeof installDom>;
  root: FakeElement;
  badge: FakeElement;
  reads: string[][];
} {
  const dom = installDom(t);
  const badge = new FakeElement('span');
  badge.setAttribute('id', 'recommendation-count');
  dom.body.append(badge);
  const reads: string[][] = [];
  const state = { isUnread: true };
  const pane = createRecommendationsView({
    list: async () => {
      await Promise.resolve();
      return page(state.isUnread);
    },
    markRead: async (id, revision) => {
      reads.push([id, revision]);
      state.isUnread = false;
      await Promise.resolve();
      return {};
    },
  });
  const root = fake(pane.element);
  dom.body.append(root);
  return { pane, dom, root, badge, reads };
}

await test('hostile markup and markdown stay inert text', async (t) => {
  const { pane, root } = mount(t);
  await pane.refresh();
  assert.ok(root.textContent.includes(HOSTILE));
  assert.equal(root.querySelector('img'), null);
  assert.equal(root.querySelector('a'), null);
  assert.equal(Reflect.get(globalThis, 'pwnedRecommendation'), undefined);
});

await test('polling an unchanged page keeps every node and the focus', async (t) => {
  const { pane, root, dom } = mount(t);
  await pane.refresh();
  const row = root.querySelector('button');
  assert.ok(row !== null);
  row.focus();
  const nodes = root.descendants();
  await pane.refresh();
  await pane.refresh();
  assert.deepEqual(root.descendants(), nodes, 'nothing was redrawn');
  assert.equal(dom.activeElement, row);
});

await test('rows are native buttons that open by keyboard and record the exact revision as read', async (t) => {
  const { pane, root, reads } = mount(t);
  await pane.refresh();
  const row = root.querySelector('button');
  assert.equal(row?.getAttribute('aria-expanded'), 'false');
  assert.match(root.textContent, /Unread/v);
  const [open] = row.listeners.get('click') ?? [];
  assert.ok(typeof open === 'function');
  Reflect.apply(open, row, []);
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  assert.deepEqual(reads, [['a'.repeat(64), 'b'.repeat(64)]]);
  const opened = root.querySelector('button');
  assert.equal(opened?.getAttribute('aria-expanded'), 'true');
  assert.match(root.textContent, /Same files/v);
  assert.match(root.textContent, /Before.*Two.*After.*Linked/sv);
  assert.doesNotMatch(root.textContent, /Unread/v, 'the marker clears once read');
});

await test('the Project entry shows accessible pending and unread counts, cleared on a project switch', async (t) => {
  const { pane, badge } = mount(t);
  await pane.refresh();
  assert.equal(badge.getAttribute('aria-label'), '1 pending and 1 unread recommendations');
  assert.equal(badge.textContent, '1 · 1 new');
  pane.reset();
  assert.equal(badge.textContent, '');
});
