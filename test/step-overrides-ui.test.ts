/**
 * DOM-free tests of the step override editor model. They import the compiled
 * browser module, so `npm run check` builds web first; a bare `npm test`
 * needs `npm run build:web`.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ANY_PROVIDER,
  SEAT_PROFILE,
  initialChoice,
  libraryWorkflowSteps,
  overrideSummary,
  overridesFrom,
  parseCustomization,
  profileNames,
  seatNames,
} from '../web/dist/step-override-model.js';

/** A delivery's editor state as the broker projects it. */
const customization = parseCustomization({
  version: 4,
  steps: [
    {
      id: 'implement',
      title: 'Implement',
      kind: 'implement',
      optional: false,
      roles: ['developer-1', 'developer-2'],
      profile: null,
      provider: null,
      started: true,
    },
    {
      id: 'review',
      title: 'Review',
      kind: 'review',
      optional: false,
      roles: ['qa-1'],
      profile: null,
      provider: 'codex',
      started: false,
    },
    {
      id: 'document',
      title: 'Document',
      kind: 'document',
      optional: true,
      roles: ['librarian'],
      profile: null,
      provider: null,
      started: false,
    },
    {
      id: 'approve',
      title: 'Approve',
      kind: 'approve',
      optional: true,
      roles: [],
      profile: null,
      provider: null,
      started: false,
    },
  ],
  overrides: [{ stepId: 'implement', roles: ['developer-2'] }, { stepId: 'bogus' }],
});

await test('the editor state parses untrusted steps and overrides', () => {
  assert.ok(customization !== null);
  assert.equal(customization.version, 4);
  assert.deepEqual(
    customization.steps.map((step) => [step.id, step.optional, step.started]),
    [
      ['implement', false, true],
      ['review', false, false],
      ['document', true, false],
      ['approve', true, false],
    ],
  );
  assert.equal(parseCustomization(null), null);
  assert.equal(parseCustomization([1]), null);
});

await test('choices become the smallest override list and started steps keep theirs', () => {
  assert.ok(customization !== null);
  const choices = new Map(customization.steps.map((step) => [step.id, initialChoice(step, customization.overrides)]));
  assert.deepEqual(overridesFrom(customization.steps, choices, customization.overrides), [
    { stepId: 'implement', roles: ['developer-2'] },
  ]);
  choices.set('review', {
    stepId: 'review',
    include: true,
    role: 'qa-2',
    profile: SEAT_PROFILE,
    provider: ANY_PROVIDER,
  });
  choices.set('document', { stepId: 'document', include: false, role: '', profile: '', provider: 'codex' });
  choices.set('approve', { stepId: 'approve', include: false, role: 'qa-1', profile: '', provider: 'claude' });
  choices.set('implement', { stepId: 'implement', include: true, role: 'developer-1', profile: '', provider: '' });
  const overrides = overridesFrom(customization.steps, choices, customization.overrides);
  assert.deepEqual(overrides, [
    { stepId: 'implement', roles: ['developer-2'] },
    { stepId: 'review', roles: ['qa-2'], provider: null },
    { stepId: 'document', skip: true, provider: 'codex' },
    { stepId: 'approve', skip: true },
  ]);
  assert.equal(
    overrideSummary(customization.steps, overrides),
    'Skips Document, Approve; changes who performs Implement, Review.',
  );
  assert.equal(overrideSummary(customization.steps, []), '');
  // A step's own seat chosen again is no override.
  choices.set('review', { stepId: 'review', include: true, role: 'qa-1', profile: '', provider: 'codex' });
  assert.equal(
    overridesFrom(customization.steps, choices).some((override) => override.stepId === 'review'),
    false,
  );
});

await test('saved overrides seed the editor, including explicit nulls', () => {
  assert.ok(customization !== null);
  const [, review] = customization.steps;
  assert.ok(review !== undefined);
  assert.deepEqual(initialChoice(review, [{ stepId: 'review', profile: null, provider: null }]), {
    stepId: 'review',
    include: true,
    role: '',
    profile: SEAT_PROFILE,
    provider: ANY_PROVIDER,
  });
});

await test('library workflows, seats and profiles come from the factory snapshot', () => {
  const factory = {
    workflows: {
      items: [
        {
          id: 'quick',
          workflow: {
            planning: [{ id: 'plan', title: 'Plan', kind: 'plan', roles: ['team-lead'], optional: false }],
            delivery: [{ id: 'review', title: 'Review', kind: 'review', roles: ['qa-1'], optional: true }],
          },
        },
      ],
    },
    settings: { organization: { members: { 'qa-1': {}, 'qa-2': {} }, types: { reviewer: {}, architect: {} } } },
  };
  assert.deepEqual(
    libraryWorkflowSteps(factory, 'quick').map((step) => [step.id, step.started]),
    [
      ['plan', false],
      ['review', false],
    ],
  );
  assert.deepEqual(libraryWorkflowSteps(factory, 'missing'), []);
  assert.deepEqual(seatNames(factory), ['qa-1', 'qa-2']);
  assert.deepEqual(profileNames(factory), ['architect', 'reviewer']);
});
