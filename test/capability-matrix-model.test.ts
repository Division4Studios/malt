/**
 * DOM-free tests of the Capabilities view model (#81). They import the
 * compiled browser module, so `npm run check` builds web first; a bare
 * `npm test` needs `npm run build:web`.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FACTORY_ROLES } from '../src/factory/seats.ts';
import {
  AGENT_ROLES,
  CAPABILITY_MODES,
  changeText,
  draftProblem,
  isModeOffered,
  modeLabel,
  policySetInput,
  readCapabilities,
  supportLabel,
} from '../web/dist/capability-model.js';

/** A broker capability view with one row per support state. */
const view = {
  connected: true,
  provider: 'github',
  capabilities: [
    { capability: 'labels-use', mode: 'disabled', roles: ['ignored'], support: 'supported', providerCapabilities: [] },
    { capability: 'views', mode: 'approved-agent-roles', roles: ['team-lead', 7], support: 'unsupported' },
    { capability: 'milestones', mode: 'everyone', roles: [], support: 'mystery' },
    { mode: 'disabled' },
  ],
  history: [
    {
      capability: 'labels-use',
      kind: 'human',
      actor: { kind: 'human', id: 'project-operator' },
      previous: { mode: 'disabled', roles: [] },
      next: { mode: 'approved-agent-roles', roles: ['qa-1'] },
      time: '2026-10-16T00:00:00.000Z',
    },
    {
      capability: 'labels-use',
      kind: 'human',
      actor: { kind: 'human', id: 'project-operator' },
      previous: { mode: 'approved-agent-roles', roles: ['qa-1'] },
      next: { mode: 'disabled', roles: [] },
      time: '2026-10-17T00:00:00.000Z',
    },
  ],
  historyTruncated: false,
};

await test('rows keep mode and provider support apart, and unknown values fail safe', () => {
  const matrix = readCapabilities(view);
  assert.equal(matrix.provider, 'github');
  assert.deepEqual(
    matrix.rows.map((row) => [row.capability, row.mode, row.roles, row.support]),
    [
      ['labels-use', 'disabled', [], 'supported'],
      ['views', 'approved-agent-roles', ['team-lead'], 'unsupported'],
      ['milestones', 'disabled', [], 'unverified'],
    ],
  );
  assert.deepEqual(
    matrix.history.map((change) => change.time),
    ['2026-10-17T00:00:00.000Z', '2026-10-16T00:00:00.000Z'],
    'newest change first',
  );
  assert.throws(() => readCapabilities(null));
});

await test('every mode and the role list for approved agent roles are offered', () => {
  assert.deepEqual(CAPABILITY_MODES, ['disabled', 'human-only', 'approved-agent-roles']);
  const modeLabels = new Set(CAPABILITY_MODES.map((mode) => modeLabel(mode)));
  assert.equal(modeLabels.size, 3);
  assert.deepEqual([...AGENT_ROLES], [...FACTORY_ROLES], 'the console offers exactly the server’s roles');
});

await test('unsupported and unverified are labelled distinctly from disabled, and unsupported can only be disabled', () => {
  const labels = [supportLabel('supported'), supportLabel('unsupported'), supportLabel('unverified')];
  const distinct = new Set([...labels, modeLabel('disabled')]);
  assert.equal(distinct.size, 4);
  const [supported, unsupported] = readCapabilities(view).rows;
  assert.ok(supported !== undefined && unsupported !== undefined);
  assert.ok(CAPABILITY_MODES.every((mode) => isModeOffered(supported, mode)));
  assert.deepEqual(
    CAPABILITY_MODES.filter((mode) => isModeOffered(unsupported, mode)),
    ['disabled'],
  );
});

await test('a save sends only the chosen mode, and roles only with approved agent roles', () => {
  assert.match(draftProblem({ mode: 'approved-agent-roles', roles: [] }) ?? '', /at least one role/v);
  assert.equal(draftProblem({ mode: 'human-only', roles: [] }), null);
  assert.deepEqual(policySetInput('labels-use', { mode: 'human-only', roles: ['qa-1'] }), {
    operation: 'capability_policy_set',
    input: { capability: 'labels-use', policy: { mode: 'human-only', roles: [] } },
  });
  assert.deepEqual(policySetInput('labels-use', { mode: 'approved-agent-roles', roles: ['qa-1'] }).input, {
    capability: 'labels-use',
    policy: { mode: 'approved-agent-roles', roles: ['qa-1'] },
  });
  const [latest] = readCapabilities(view).history;
  assert.ok(latest !== undefined);
  assert.equal(changeText(latest), 'project-operator changed labels-use: Approved agent roles (qa-1) → Disabled');
});
