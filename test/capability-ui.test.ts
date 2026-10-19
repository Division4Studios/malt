/** @file The Capabilities view keeps drafts to their project and never loses a choice made during a save. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createCapabilityView } from '../web/dist/capability-ui.js';

import { fake, installDom } from './dom-shim.ts';

import type { FakeElement } from './dom-shim.ts';
import type { TestContext } from 'node:test';

/** One capability's stored policy, as the matrix route returns it. */
const MATRIX = {
  provider: 'github',
  capabilities: [{ capability: 'issues.create', support: 'supported', mode: 'disabled', roles: [] }],
  history: [],
};

/**
 * Serve the matrix for any project from a stubbed `fetch`.
 *
 * @param t - Owns the mock, restored after the test.
 */
function serveMatrix(t: TestContext): void {
  t.mock.method(globalThis, 'fetch', async () => {
    await Promise.resolve();
    return Response.json(MATRIX);
  });
}

/**
 * Choose a mode in the row's picker.
 *
 * @param root - View root.
 * @param mode - Mode value.
 */
function choose(root: FakeElement, mode: string): void {
  const select = root.querySelector('select');
  assert.ok(select !== null);
  Reflect.set(select, 'value', mode);
  const [handler] = select.listeners.get('change') ?? [];
  assert.ok(typeof handler === 'function');
  Reflect.apply(handler, select, []);
}

/**
 * Find the capability row's Save control.
 *
 * @param root - View root.
 * @returns Its button, enabled only while a draft differs from the stored policy.
 */
function saveButton(root: FakeElement): FakeElement {
  const save = root.querySelectorAll('button').find((node) => node.textContent === 'Save');
  assert.ok(save !== undefined);
  return save;
}

await test('a draft made in one project is neither shown nor saved in another', async (t) => {
  const dom = installDom(t);
  serveMatrix(t);
  let project = 'a';
  const sent: unknown[] = [];
  const view = createCapabilityView({
    project: () => project,
    control: async (_operation, input) => {
      await Promise.resolve();
      sent.push(input);
      return true;
    },
  });
  const root = fake(view.element);
  dom.body.append(root);
  await view.refresh();
  choose(root, 'human-only');
  assert.equal(Reflect.get(saveButton(root), 'disabled'), false, 'the draft is pending in project a');
  project = 'b';
  await view.refresh();
  assert.equal(Reflect.get(saveButton(root), 'disabled'), true, "project b starts without a's draft");
  assert.deepEqual(sent, []);
});

await test('a choice made while its save is in flight stays a draft', async (t) => {
  const dom = installDom(t);
  serveMatrix(t);
  const answer = Promise.withResolvers<boolean>();
  const view = createCapabilityView({ project: () => 'a', control: async () => answer.promise });
  const root = fake(view.element);
  dom.body.append(root);
  await view.refresh();
  choose(root, 'human-only');
  const [click] = saveButton(root).listeners.get('click') ?? [];
  assert.ok(typeof click === 'function');
  Reflect.apply(click, saveButton(root), []);
  choose(root, 'approved-agent-roles');
  answer.resolve(true);
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  await view.refresh();
  assert.equal(Reflect.get(saveButton(root), 'disabled'), false, 'the newer choice was not discarded');
});
