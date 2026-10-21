/**
 * A project on local delivery is not treated as a GitHub project: Get started
 * counts the protected hub as its delivery target, Project setup shows local
 * delivery instead of a missing GitHub Project, and a delivery's local pull
 * request opens in Workflow → Pull requests instead of "link unavailable".
 * Imports compiled browser modules, so a bare `npm test` needs `npm run build:web`.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { pullRequestLink } from '../web/dist/console-dom.js';
import { localPullNumber } from '../web/dist/console-model.js';
import { isLocalDelivery, isOnboardingNeeded, onboardingSteps } from '../web/dist/onboarding-model.js';
import { setupView } from '../web/dist/views.js';

import { fake, installDom } from './dom-shim.ts';

/** The broker's local ledger summary for a project on `"delivery": "local"`. */
const LOCAL = { remote: 'malt-hub', base: 'main', issues: [{ number: 1 }], pulls: [{ number: 3 }] };
/** A configured project with one objective. */
const FACTORY = {
  configured: true,
  active: false,
  features: [{ id: 'f', objective: 'Ship it', phase: 'queued', createdAt: 1, error: null }],
  jobs: [],
};

await test('Get started treats the local hub as the connected delivery target', () => {
  const snapshot = { factory: FACTORY, github: { connected: false }, local: LOCAL };
  assert.equal(isLocalDelivery(snapshot), true);
  assert.equal(isOnboardingNeeded(snapshot), false, 'no GitHub Project is required');
  const steps = onboardingSteps(snapshot, null, 2);
  const connect = steps.find((step) => step.id === 'connect');
  assert.equal(connect?.progress, 'done');
  assert.equal(connect.title, 'Deliver through the local hub');
  assert.match(connect.detail, /malt-hub\/main/v);
  assert.notEqual(steps.find((step) => step.progress === 'current')?.id, 'connect');

  const github = { factory: FACTORY, github: { connected: false }, local: null };
  assert.equal(isLocalDelivery(github), false);
  assert.equal(isOnboardingNeeded(github), true);
  const unconnected = onboardingSteps(github, null, 2).find((step) => step.id === 'connect');
  assert.equal(unconnected?.title, 'Connect the GitHub repository and Project');
  assert.equal(unconnected.progress, 'todo');
});

await test('local pull-request addresses are recognised exactly', () => {
  assert.equal(localPullNumber('malt-local://pulls/3'), 3);
  for (const other of [
    'malt-local://issues/3',
    'malt-local://pulls/0',
    'malt-local://pulls/3/files',
    'https://github.com/o/r/pull/3',
    '',
  ]) {
    assert.equal(localPullNumber(other), null, other);
  }
});

await test('a local pull request opens in Workflow → Pull requests, never "link unavailable"', (t) => {
  installDom(t);
  const opened: number[] = [];
  const link = fake(
    pullRequestLink('malt-local://pulls/3', 'Pull request', (pull) => {
      opened.push(pull);
    }),
  );
  assert.equal(link.tagName, 'BUTTON');
  assert.equal(link.textContent, 'Pull request');
  assert.match(String(Reflect.get(link, 'title')), /#3 in Workflow → Pull requests/v);
  const [handler] = link.listeners.get('click') ?? [];
  assert.ok(typeof handler === 'function');
  Reflect.apply(handler, link, []);
  assert.deepEqual(opened, [3]);
  const unrouted = fake(pullRequestLink('malt-local://pulls/3', 'Pull request'));
  assert.equal(unrouted.textContent, 'Local pull request #3 in Workflow → Pull requests');
  assert.doesNotMatch(unrouted.textContent, /link unavailable/v);
  assert.equal(fake(pullRequestLink('https://github.com/o/r/pull/3', 'Pull request')).tagName, 'A');
});

await test('Project setup shows local delivery instead of a missing GitHub Project', (t) => {
  installDom(t);
  let opened = 0;
  const actions = {
    openPulls: () => {
      opened += 1;
    },
    setup: () => {
      assert.fail('local delivery has no GitHub connection to configure');
    },
    modelPolicy: () => {
      assert.fail('not opened by rendering');
    },
  };
  const state = { project: {}, factory: {}, events: [], github: {}, learning: {}, manager: null, observedAt: 1 };
  const local = fake(setupView({ ...state, local: LOCAL }, actions));
  assert.match(local.textContent, /Local delivery/v);
  assert.match(local.textContent, /malt-hub\/main/v);
  assert.doesNotMatch(local.textContent, /GitHub Project(?!\s+is needed)|not connected/v);
  const open = local.querySelectorAll('button').find((node) => node.textContent === 'Open pull requests');
  const [handler] = open?.listeners.get('click') ?? [];
  assert.ok(typeof handler === 'function');
  Reflect.apply(handler, open, []);
  assert.equal(opened, 1);
  const github = fake(setupView({ ...state, local: null }, actions));
  assert.match(github.textContent, /GitHub Project/v);
  assert.match(github.textContent, /not connected/v);
});
