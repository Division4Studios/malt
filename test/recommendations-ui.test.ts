/** @file Project → Recommendations rendered into a text-only DOM: inert text, poll stability, keyboard rows, read receipts and counts. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { useLocale } from '../web/dist/i18n.js';
import { createRecommendationsView } from '../web/dist/recommendations-ui.js';

import { FakeElement, fake, installDom } from './dom-shim.ts';

/** Markup and markdown a proposal could carry; both must stay text. */
const HOSTILE = '<img src=x onerror="globalThis.pwnedRecommendation=true"> **merge** [link](javascript:alert(1))';

/**
 * A page with one unread awaiting-human proposal.
 *
 * @param isUnread - Unread flag.
 * @param id - Recommendation identity.
 * @returns Untrusted page.
 */
function page(isUnread = true, id = 'a'.repeat(64)): Record<string, unknown> {
  return {
    items: [
      {
        id,
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

await test('a read started for the previous project is discarded after a reset', async (t) => {
  const dom = installDom(t);
  const gate: { release: (() => void) | null } = { release: null };
  const pane = createRecommendationsView({
    list: async () => {
      await new Promise<void>((resolve) => {
        gate.release = resolve;
      });
      return page();
    },
    markRead: async () => {
      await Promise.resolve();
      return {};
    },
  });
  const root = fake(pane.element);
  dom.body.append(root);
  const pending = pane.refresh();
  pane.reset();
  gate.release?.();
  await pending;
  assert.equal(root.textContent, '', 'the previous project never repopulates the pane');
});

await test('a failed read receipt stays visible after the refresh', async (t) => {
  const dom = installDom(t);
  const pane = createRecommendationsView({
    list: async () => {
      await Promise.resolve();
      return page();
    },
    markRead: async () => {
      await Promise.resolve();
      throw new Error('Receipt refused.');
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
  assert.match(root.textContent, /Receipt refused\./v);
  assert.match(root.textContent, /Unread/v);
});

await test('a receipt settling after a project reset does not reach the new project', async (t) => {
  const dom = installDom(t);
  const gate: { release: (() => void) | null } = { release: null };
  let lists = 0;
  const pane = createRecommendationsView({
    list: async () => {
      lists += 1;
      await Promise.resolve();
      return page();
    },
    markRead: async () => {
      await new Promise<void>((resolve) => {
        gate.release = resolve;
      });
      throw new Error('Old project receipt refused.');
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
  pane.reset();
  gate.release?.();
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  assert.equal(lists, 1, 'no refresh follows the old receipt');
  assert.doesNotMatch(root.textContent, /Old project receipt refused/v);
});

await test('a change on an earlier loaded page redraws the pane', async (t) => {
  const dom = installDom(t);
  const state = { action: 'First wording' };
  const pane = createRecommendationsView({
    list: async (cursor) => {
      await Promise.resolve();
      if (cursor !== null) {
        return page(false, 'd'.repeat(64));
      }
      const body = {
        kind: 'related',
        tickets: [4],
        action: state.action,
        evidence: [],
        preview: { before: 'a', after: 'b' },
      };
      const row = { id: 'a'.repeat(64), revision: 'b'.repeat(64), state: 'awaiting_human', unread: false, body };
      return {
        items: [row],
        counts: { unread: 0, pending: 2 },
        contentRevision: state.action,
        nextCursor: 'e'.repeat(64),
      };
    },
    markRead: async () => {
      await Promise.resolve();
      return {};
    },
  });
  const root = fake(pane.element);
  dom.body.append(root);
  await pane.refresh();
  const more = root.querySelectorAll('button').find((node) => node.textContent === 'Show more recommendations');
  const [load] = more?.listeners.get('click') ?? [];
  assert.ok(typeof load === 'function');
  Reflect.apply(load, undefined, []);
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  state.action = 'Second wording';
  await pane.refresh();
  assert.match(root.textContent, /Second wording/v);
});

await test('more than one page is reachable through the cursor', async (t) => {
  const dom = installDom(t);
  const after: (string | null)[] = [];
  const pane = createRecommendationsView({
    list: async (cursor) => {
      after.push(cursor);
      await Promise.resolve();
      return cursor === null ? { ...page(), nextCursor: 'e'.repeat(64) } : page(false, 'd'.repeat(64));
    },
    markRead: async () => {
      await Promise.resolve();
      return {};
    },
  });
  const root = fake(pane.element);
  dom.body.append(root);
  await pane.refresh();
  const more = root.querySelectorAll('button').find((node) => node.textContent === 'Show more recommendations');
  const [load] = more?.listeners.get('click') ?? [];
  assert.ok(typeof load === 'function');
  Reflect.apply(load, undefined, []);
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  assert.deepEqual(after, [null, null, 'e'.repeat(64)]);
  assert.equal(root.querySelectorAll('li').length, 2);
});

await test('the pane lives under Project without a new top-level section', () => {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Reads only this repository's shell.
  const shell = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  assert.equal(shell.match(/data-group="/gv)?.length, 7);
  const project = shell.slice(shell.indexOf('data-navigation="project"'));
  assert.ok(project.slice(0, project.indexOf('</div>')).includes('data-view="recommendations"'));
});

await test('a language change relabels the pane but keeps proposal text exactly as sent', async (t) => {
  const dom = installDom(t);
  t.after(() => {
    useLocale('en');
  });
  const pane = createRecommendationsView({
    list: async () => {
      await Promise.resolve();
      return {
        items: [
          {
            id: 'a'.repeat(64),
            revision: 'b'.repeat(64),
            state: 'awaiting_human',
            unread: false,
            body: {
              kind: 'related',
              tickets: [4],
              action: 'Pending',
              evidence: [],
              preview: { before: 'Before', after: 'After' },
            },
          },
        ],
        counts: { unread: 0, pending: 1 },
        contentRevision: 'c'.repeat(64),
      };
    },
    markRead: async () => {
      await Promise.resolve();
      return {};
    },
  });
  const root = fake(pane.element);
  dom.body.append(root);
  await pane.refresh();
  useLocale('zh-CN');
  pane.relabel();
  assert.match(root.textContent, /待处理（1）/v, 'labels follow the new language');
  assert.match(root.textContent, /相关工单 · #4 · Pending/v, 'the proposal action stays as sent');
});
