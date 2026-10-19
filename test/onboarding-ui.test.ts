/**
 * DOM-free tests of the Get started and Settings view models. They import
 * compiled browser modules, so `npm run check` builds web first; a bare
 * `npm test` needs `npm run build:web`.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { firstOutcome, isOnboardingNeeded, onboardingSteps, readPreflight } from '../web/dist/onboarding-model.js';
import { buildRows, providerHealth, revalidationInput, revalidationSetting } from '../web/dist/settings-model.js';

const FEATURE = '11111111-1111-4111-8111-111111111111';
const NOW = 1_800_000_000_000;

/**
 * A factory projection with one objective, set up and running unless overridden.
 *
 * @param overrides - Fields replaced on the projection.
 * @param objective - Fields replaced on the objective.
 * @returns Factory projection.
 */
function factory(
  overrides: Record<string, unknown> = {},
  objective: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    configured: true,
    active: true,
    error: null,
    admission: { blocker: 'none', providers: { claude: null, codex: null } },
    features: [
      { id: FEATURE, objective: 'Ship it', phase: 'queued', createdAt: NOW - 1000, error: null, ...objective },
    ],
    jobs: [],
    workflows: { defaultId: 'malt-assured', items: [{ id: 'malt-assured', workflow: { name: 'MALT assured' } }] },
    settings: {
      providers: { claude: { enabled: true, executable: 'claude' }, codex: { enabled: false, executable: 'codex' } },
    },
    ...overrides,
  };
}

/** A preflight report as the broker sends it. */
const REPORT = {
  ok: true,
  checks: [
    { id: 'claude', label: 'Claude Code CLI', status: 'pass', detail: '2.1.0 · claude.ai subscription', fix: null },
    { id: 'codex', label: 'Codex CLI', status: 'fix-it', detail: 'codex was not found', fix: 'Install Codex.' },
    { id: 'odd', label: 'Odd', status: 'unknown', detail: '', fix: null },
  ],
};

await test('onboarding is needed until the project is set up, connected and has an objective', () => {
  const github = { connected: true };
  assert.equal(isOnboardingNeeded({ factory: factory(), github }), false);
  assert.equal(isOnboardingNeeded({ factory: factory({ configured: false }), github }), true);
  assert.equal(isOnboardingNeeded({ factory: factory(), github: { connected: false } }), true);
  assert.equal(isOnboardingNeeded({ factory: factory({ features: [] }), github }), true);
});

await test('a preflight response is validated check by check', () => {
  const report = readPreflight(REPORT);
  assert.ok(report !== null);
  assert.deepEqual(
    report.checks.map((item) => [item.id, item.status, item.fix]),
    [
      ['claude', 'pass', null],
      ['codex', 'fix-it', 'Install Codex.'],
    ],
  );
  assert.equal(readPreflight({ checks: [] }), null);
  assert.equal(readPreflight('nope'), null);
});

await test('the first outcome names the started role, or the exact reason nothing started', () => {
  const running = [
    { featureId: FEATURE, role: 'product-owner', kind: 'plan', provider: 'claude', state: 'running', startedAt: NOW },
  ];
  const started = firstOutcome(factory({ jobs: running }), NOW);
  assert.equal(started.state, 'started');
  assert.match(started.text, /product-owner started planning on claude/v);

  const cases: [Record<string, unknown>, Record<string, unknown>, RegExp][] = [
    [{ configured: false }, {}, /not set up/v],
    [{ active: false }, {}, /paused\. Start the factory/v],
    [{}, { phase: 'blocked', error: 'Plan rejected by the operator.' }, /blocked\. Plan rejected/v],
    [{ error: 'Model policy revision 3 blocks qa-1.' }, {}, /Model policy revision 3 blocks qa-1/v],
    [{ admission: { blocker: 'job_cap', providers: {} } }, {}, /Job cap reached/v],
    [
      { admission: { blocker: 'none', providers: { claude: 'cooldown', codex: 'disabled' } } },
      {},
      /no provider is eligible \(claude: cooldown; codex: disabled\)/v,
    ],
  ];
  for (const [overrides, objective, pattern] of cases) {
    const outcome = firstOutcome(factory(overrides, objective), NOW);
    assert.equal(outcome.state, 'parked', String(pattern));
    assert.match(outcome.text, pattern);
  }

  assert.match(firstOutcome(factory(), NOW).text, /one scheduling cycle/v);
  const slow = firstOutcome(factory({}, { createdAt: NOW - 5 * 60_000 }), NOW);
  assert.equal(slow.state, 'waiting');
  assert.match(slow.text, /No role has started for 5 min/v);
  assert.equal(firstOutcome(factory({ features: [] }), NOW).state, 'waiting');
});

await test('steps follow the snapshot and mark the first unfinished one current', () => {
  const fresh = onboardingSteps({ factory: { features: [] }, github: {} }, null, NOW);
  assert.deepEqual(
    fresh.map((step) => [step.id, step.progress]),
    [
      ['preflight', 'current'],
      ['connect', 'todo'],
      ['factory', 'todo'],
      ['workflow', 'done'],
      ['objective', 'todo'],
      ['start', 'todo'],
      ['outcome', 'todo'],
    ],
  );
  const report = readPreflight(REPORT);
  const ready = onboardingSteps(
    { factory: factory(), github: { connected: true, connection: { repository: 'o/r' } } },
    report,
    NOW,
  );
  assert.deepEqual(
    ready.map((step) => step.progress),
    ['done', 'done', 'done', 'done', 'done', 'done', 'current'],
  );
  assert.match(ready[0]?.detail ?? '', /1 suggested fix below/v);
  assert.match(ready[1]?.detail ?? '', /o\/r/v);
  assert.match(ready[3]?.detail ?? '', /MALT assured/v);

  const failing = readPreflight({
    ok: false,
    checks: [{ id: 'git', label: 'Git', status: 'fail', detail: 'missing', fix: 'Install Git.' }],
  });
  const blocked = onboardingSteps({ factory: factory({ active: false }), github: { connected: true } }, failing, NOW);
  assert.equal(blocked[0]?.progress, 'blocked');
  assert.equal(blocked[5]?.progress, 'current');
  assert.equal(blocked[6]?.progress, 'blocked');
});

await test('provider health joins saved policy, preflight, capacity, gates and the last failure', () => {
  const projection = factory({
    capacities: [
      {
        provider: 'claude',
        cooldownUntil: NOW + 60_000,
        subscriptionUsedPercent: null,
        subscriptionWindows: [{ id: '5h', usedPercent: 40, resetAt: NOW + 3_600_000 }],
      },
    ],
    admission: { blocker: 'none', providers: { claude: 'provider_cooldown', codex: null } },
    jobs: [
      { provider: 'codex', state: 'failed', finishedAt: NOW - 10, summary: 'x'.repeat(400) },
      { provider: 'codex', state: 'failed', finishedAt: NOW - 99, summary: 'older' },
    ],
  });
  const [claude, codex] = providerHealth(projection, readPreflight(REPORT), NOW);
  assert.ok(claude !== undefined && codex !== undefined);
  assert.equal(claude.isEnabled, true);
  assert.equal(claude.cli.status, 'pass');
  assert.equal(claude.cooldownUntil, NOW + 60_000);
  assert.equal(claude.gate, 'provider_cooldown');
  assert.match(claude.quota[0] ?? '', /^5h: 40% used/v);
  assert.equal(codex.isEnabled, false);
  assert.equal(codex.cli.fix, 'Install Codex.');
  assert.deepEqual(codex.quota, ['Subscription: usage unknown']);
  assert.ok((codex.lastFailure?.summary.length ?? 0) <= 240);
  assert.equal(codex.lastFailure?.at, NOW - 10);

  const unchecked = providerHealth({}, null, NOW);
  assert.ok(unchecked.every((row) => row.isEnabled === null && row.cli.status === 'unchecked'));
});

await test('build rows report versions and the installed shell revision, or say they are unknown', () => {
  const rows = new Map(
    buildRows({ malt: '0.1.0', broker: '0.1.0', node: '24.15.0', platform: 'win32' }, [
      'other',
      'malt-public-shell-0123456789abcdef',
    ]),
  );
  assert.equal(rows.get('MALT'), '0.1.0');
  assert.equal(rows.get('Offline shell cache'), '0123456789ab');
  const missing = new Map(buildRows(null, []));
  assert.equal(missing.get('Broker'), 'not answering');
  assert.equal(missing.get('Offline shell cache'), 'not installed in this browser');
});

await test('brief revalidation shows the saved choice and changes only while paused, keeping every other setting', () => {
  assert.deepEqual(revalidationSetting({}), { isEnabled: false, blocker: 'Set up the factory first.' });
  const settings = { maxDiffLines: 500, briefRevalidation: true, providers: { claude: { enabled: true } } };
  assert.deepEqual(revalidationSetting({ settings, active: false }), { isEnabled: true, blocker: null });
  assert.equal(revalidationSetting({ settings, active: true }).blocker, 'Pause the factory to change project policy.');
  assert.deepEqual(revalidationInput({ settings }, false), { ...settings, briefRevalidation: false });
});
