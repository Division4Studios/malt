/** @file Approve/reject in the Recommendations pane: one request per decision, required rationale, stale prompts, retries and announcements. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { createRecommendationsView } from '../web/dist/recommendations-ui.js';

import { fake, installDom } from './dom-shim.ts';

import type { FakeElement } from './dom-shim.ts';

/** Fixture identity and revision. */
const [ID, REVISION] = ['a'.repeat(64), 'b'.repeat(64)];

/** One awaiting-human proposal, as list row and as detail. */
const record = {
  id: ID,
  revision: REVISION,
  state: 'awaiting_human',
  unread: false,
  body: {
    kind: 'consolidate',
    tickets: [3, 1],
    action: 'Merge #3 into #1',
    evidence: ['Same acceptance'],
    preview: { before: 'Two tickets', after: 'One ticket' },
    survivor: 1,
    transferredAcceptance: [],
    transferredDependencies: [],
    affectedAssignments: [],
  },
};

/**
 * Let pending promise callbacks run.
 *
 * @returns After the current turn's callbacks.
 */
async function settle(): Promise<void> {
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/**
 * Invoke the click handler of a rendered button.
 *
 * @param node - Button.
 */
function click(node: FakeElement | null): void {
  const [handler] = node?.listeners.get('click') ?? [];
  assert.ok(typeof handler === 'function');
  Reflect.apply(handler, node, []);
}

/**
 * The button with the given text.
 *
 * @param root - Pane.
 * @param label - Visible text.
 * @returns Button or null.
 */
function buttonNamed(root: FakeElement, label: string): FakeElement | null {
  return root.querySelectorAll('button').find((node) => node.textContent === label) ?? null;
}

/**
 * Mount the pane with a scripted decision route and open the proposal.
 *
 * @param t - Test context.
 * @param answers - What each decision request resolves or rejects with, in order.
 * @returns Pane root and recorded requests.
 */
async function opened(
  t: Parameters<typeof installDom>[0],
  answers: (Record<string, unknown> | Error)[],
): Promise<{ root: FakeElement; sent: Record<string, unknown>[]; reloads: { count: number } }> {
  const dom = installDom(t);
  const sent: Record<string, unknown>[] = [];
  const reloads = { count: 0 };
  const gate: { release: (() => void) | null; next: number } = { release: null, next: 0 };
  const pane = createRecommendationsView({
    list: async () => {
      reloads.count += 1;
      await Promise.resolve();
      return { items: [record], counts: { total: 1, unread: 0, pending: 1, awaitingHuman: 1 }, contentRevision: 'c' };
    },
    markRead: async () => {
      await Promise.resolve();
      throw new Error('Already read.');
    },
    detail: async () => {
      await Promise.resolve();
      return { recommendation: record, contentRevision: 'd' };
    },
    decide: async (input) => {
      sent.push(input);
      await new Promise<void>((resolve) => {
        gate.release = resolve;
      });
      const scripted = answers[gate.next] ?? new Error('No scripted answer.');
      gate.next += 1;
      if (Error.isError(scripted)) {
        throw scripted;
      }
      return scripted;
    },
    identity: () => `operation-${String(sent.length + 1)}`,
  });
  const root = fake(pane.element);
  dom.body.append(root);
  await pane.refresh();
  click(root.querySelector('button'));
  await settle();
  Reflect.set(root, 'release', () => {
    gate.release?.();
  });
  return { root, sent, reloads };
}

/**
 * Type a rationale into the open form.
 *
 * @param root - Pane.
 * @param value - Rationale.
 */
function type(root: FakeElement, value: string): void {
  const field = root.querySelector('textarea');
  assert.ok(field !== null);
  Reflect.set(field, 'value', value);
  const [handler] = field.listeners.get('input') ?? [];
  assert.ok(typeof handler === 'function');
  Reflect.apply(handler, field, []);
}

/**
 * Let a scripted decision answer.
 *
 * @param root - Pane carrying the release hook.
 */
async function answer(root: FakeElement): Promise<void> {
  const release: unknown = Reflect.get(root, 'release');
  assert.ok(typeof release === 'function');
  Reflect.apply(release, undefined, []);
  await settle();
  await settle();
}

await test('a decision needs a rationale and is announced in a live region', async (t) => {
  const { root, sent } = await opened(t, []);
  click(buttonNamed(root, 'Approve'));
  await settle();
  assert.equal(sent.length, 0);
  const live = root.querySelectorAll('p').find((node) => node.getAttribute('role') === 'status');
  assert.equal(live?.getAttribute('aria-live'), 'polite');
  assert.equal(live.textContent, 'Write a rationale before deciding.');
});

await test('rapid repeated clicks send one request with the exact revision and one operation identity', async (t) => {
  const { root, sent, reloads } = await opened(t, [{ outcome: 'approved' }]);
  type(root, '  The tickets describe one change.  ');
  click(buttonNamed(root, 'Approve'));
  click(buttonNamed(root, 'Approve'));
  click(buttonNamed(root, 'Reject'));
  await settle();
  assert.deepEqual(sent, [
    {
      operationId: 'operation-1',
      id: ID,
      revision: REVISION,
      decision: 'approve',
      rationale: 'The tickets describe one change.',
    },
  ]);
  assert.equal(Reflect.get(buttonNamed(root, 'Approve') ?? {}, 'disabled'), true, 'controls disable in flight');
  const before = reloads.count;
  await answer(root);
  assert.ok(reloads.count > before, 'the list is re-read after a decision');
  assert.match(root.textContent, /Approved\./v);
});

await test('a failed request keeps the rationale and retries with the same identity', async (t) => {
  const { root, sent } = await opened(t, [new Error('Offline.'), { outcome: 'rejected' }]);
  type(root, 'Not the same scope.');
  click(buttonNamed(root, 'Reject'));
  await answer(root);
  assert.match(root.textContent, /Not decided: Offline\. Your rationale is kept; try again\./v);
  assert.equal(Reflect.get(root.querySelector('textarea') ?? {}, 'value'), 'Not the same scope.');
  click(buttonNamed(root, 'Reject'));
  await answer(root);
  assert.deepEqual(
    sent.map((input) => input['operationId']),
    ['operation-1', 'operation-1'],
  );
});

await test('a stale answer prompts a refresh and never shows the proposal as decided', async (t) => {
  const { root } = await opened(t, [{ outcome: 'stale' }]);
  type(root, 'Looks right.');
  click(buttonNamed(root, 'Approve'));
  await answer(root);
  assert.match(root.textContent, /changed since you opened it/v);
  assert.doesNotMatch(root.textContent, /Approved\./v);
  assert.equal(buttonNamed(root, 'Approve'), null, 'no decision control is offered for the stale revision');
  assert.ok(buttonNamed(root, 'Refresh') !== null);
});

await test('every decision control is a native, keyboard-operable element with visible focus', async (t) => {
  const { root } = await opened(t, []);
  const controls = root.descendants().filter((node) => node.listeners.size > 0);
  assert.ok(controls.length >= 3);
  assert.ok(
    controls.every((node) => ['BUTTON', 'TEXTAREA'].includes(node.tagName) && node.getAttribute('tabindex') === null),
  );
  assert.ok(root.querySelector('label')?.querySelector('textarea') !== null, 'the rationale has a label');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Reads only this repository's stylesheet.
  const css = readFileSync(new URL('../web/style.css', import.meta.url), 'utf8');
  assert.match(css, /button:focus-visible/v);
  assert.match(css, /textarea:focus/v);
});
