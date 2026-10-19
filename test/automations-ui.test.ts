/**
 * DOM-free tests of the Schedules & triggers view model. They import the
 * compiled browser module, so `npm run check` builds web first; a bare
 * `npm test` needs `npm run build:web`.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  SECRET_PLACEHOLDER,
  describeCron,
  draftOf,
  draftProblem,
  fireText,
  issuedSecret,
  readAutomations,
  saveInput,
  toggleInput,
  triggerExamples,
  triggerUrl,
  zonedTime,
} from '../web/dist/automations-model.js';

const SCHEDULE = '11111111-1111-4111-8111-111111111111';
const TRIGGER = '22222222-2222-4222-8222-222222222222';
const FEATURE = '33333333-3333-4333-8333-333333333333';

/** Endpoint the broker reports for the home project. */
const HOME_ENDPOINT = { url: 'http://127.0.0.1:4317/', team: null };

/**
 * A snapshot carrying automations as the broker projects them.
 *
 * @param automations - Automation records.
 * @param endpoint - Trigger endpoint, if any.
 * @returns Snapshot shape the view reads.
 */
function snapshot(automations: unknown[], endpoint: unknown = HOME_ENDPOINT): unknown {
  return { factory: { automations, triggerEndpoint: endpoint } };
}

const schedule = {
  id: SCHEDULE,
  kind: 'schedule',
  name: 'Weekly audit',
  objective: '# Audit dependencies',
  workflowId: null,
  isEnabled: true,
  revision: 2,
  lastFiredAt: 1,
  cron: '0 9 * * 1',
  timeZone: 'Europe/Berlin',
  nextAt: Date.UTC(2026, 9, 19, 7),
  upcoming: [Date.UTC(2026, 9, 19, 7), 'bad', Date.UTC(2026, 9, 26, 8)],
  fires: [
    { id: 'f1', kind: 'schedule', at: 5, featureId: FEATURE, error: null },
    { id: 'f2', kind: 'manual', at: 4, featureId: null, error: 'Paused.' },
    { id: 'f3', kind: 'nonsense', at: 3 },
  ],
};
const trigger = {
  id: TRIGGER,
  kind: 'trigger',
  name: 'CI failed',
  objective: '# Fix the build',
  workflowId: 'quick',
  isEnabled: false,
  revision: 1,
  lastFiredAt: null,
  path: `/triggers/${TRIGGER}`,
  fires: [],
};

await test('automations are validated record by record and split by kind', () => {
  const model = readAutomations(
    snapshot([schedule, trigger, { kind: 'schedule' }, 'junk', { id: 'x', kind: 'odd', name: 'y' }]),
  );
  assert.equal(model.schedules.length, 1);
  assert.equal(model.triggers.length, 1);
  const [first] = model.schedules;
  assert.ok(first !== undefined);
  assert.deepEqual(
    first.upcoming,
    [Date.UTC(2026, 9, 19, 7), Date.UTC(2026, 9, 26, 8)],
    'Non-numeric fires are dropped.',
  );
  assert.deepEqual(
    first.fires.map((fire) => fire.id),
    ['f1', 'f2'],
    'Unknown fire kinds are dropped.',
  );
  assert.equal(model.triggers[0]?.workflowId, 'quick');
  assert.deepEqual(model.endpoint, { url: 'http://127.0.0.1:4317/', team: null });
  assert.deepEqual(readAutomations(null), { schedules: [], triggers: [], endpoint: null });
  assert.equal(readAutomations(snapshot([], { url: '' })).endpoint, null);
});

await test('cron expressions read as plain language and invalid ones explain themselves', () => {
  const cases: [string, string][] = [
    ['0 9 * * 1-5', 'At 09:00, on Monday to Friday.'],
    ['*/15 * * * *', 'Every 15 minutes, every day.'],
    ['* * * * *', 'Every minute, every day.'],
    ['30 * * * *', 'At 30 minutes past every hour, every day.'],
    ['0 9,17 * * *', 'At 00 minutes past 09:00 and 17:00, every day.'],
    ['0 0 1 jan,jul *', 'At 00:00, on day 1 of the month, in January and July.'],
    ['0 12 13 * fri', 'At 12:00, on day 13 of the month or on Friday.'],
    ['0 0 * * 7', 'At 00:00, on Sunday.'],
    ['@weekly', 'At 00:00, on Sunday.'],
    ['*/30 9-17 * * mon-fri', 'Every 30 minutes during 09:00 to 17:00, on Monday to Friday.'],
    // A day field starting with `*` stays unrestricted, as on the broker: Mondays only, not every day.
    ['0 0 */1 * mon', 'At 00:00, on Monday.'],
    // A stepped day field still constrains: both day fields must match when one starts with `*`.
    ['0 0 */2 * *', 'At 00:00, every 2 days from day 1 of the month.'],
    ['0 0 */2 * mon', 'At 00:00, every 2 days from day 1 of the month and on Monday.'],
    ['0 9 * jan *', 'At 09:00, every day, in January.'],
  ];
  for (const [expression, text] of cases) {
    assert.deepEqual(describeCron(expression), { text, isValid: true }, expression);
  }
  assert.match(describeCron('0 9 * *').text, /five fields/v);
  assert.equal(describeCron('61 * * * *').isValid, false);
  assert.match(describeCron('0 9-5 * * *').text, /runs backwards/v);
  assert.match(describeCron('*/0 * * * *').text, /invalid step/v);
});

await test('fire times show in the schedule zone and fires describe their outcome', () => {
  const at = Date.UTC(2026, 9, 19, 7);
  assert.match(zonedTime(at, 'Europe/Berlin'), /09:00/v);
  assert.match(zonedTime(at, 'America/New_York'), /03:00/v);
  assert.match(zonedTime(at, 'Not/AZone'), /\d{2}:\d{2}/v, 'An unknown zone falls back to the browser zone.');
  assert.equal(
    fireText({ id: '', kind: 'schedule', at, featureId: FEATURE, error: null }),
    'Scheduled: objective filed',
  );
  assert.equal(
    fireText({ id: '', kind: 'trigger', at, featureId: null, error: 'Gated.' }),
    'Webhook: not filed. Gated.',
  );
});

await test('editor drafts validate and save with the revision they started from', () => {
  const model = readAutomations(snapshot([schedule, trigger]));
  const [saved] = model.schedules;
  const [hook] = model.triggers;
  assert.ok(saved !== undefined && hook !== undefined);
  const fresh = draftOf(null);
  assert.equal(fresh.isEnabled, true);
  assert.equal(draftProblem('schedule', fresh), 'Give it a name of 1–120 characters.');
  assert.equal(draftProblem('trigger', { ...fresh, name: 'x', objective: 'y' }), null);
  assert.match(draftProblem('schedule', { ...fresh, name: 'x', objective: 'y', cron: 'nope' }) ?? '', /five fields/v);
  assert.match(draftProblem('schedule', { ...fresh, name: 'x', objective: 'y', timeZone: ' ' }) ?? '', /time zone/v);

  assert.deepEqual(saveInput('schedule', { ...draftOf(saved), name: ' Weekly audit ' }, saved), {
    operation: 'factory_schedule_save',
    input: {
      id: SCHEDULE,
      expectedRevision: 2,
      name: 'Weekly audit',
      objective: '# Audit dependencies',
      workflowId: null,
      isEnabled: true,
      cron: '0 9 * * 1',
      timeZone: 'Europe/Berlin',
    },
  });
  assert.deepEqual(saveInput('trigger', { ...fresh, name: 'Deploy', objective: 'Verify' }, null), {
    operation: 'factory_trigger_save',
    input: { name: 'Deploy', objective: 'Verify', workflowId: null, isEnabled: true, rotateSecret: false },
  });
  assert.deepEqual(toggleInput(hook).input, {
    id: TRIGGER,
    expectedRevision: 1,
    name: 'CI failed',
    objective: '# Fix the build',
    workflowId: 'quick',
    isEnabled: true,
    rotateSecret: false,
  });
  assert.equal(saveInput('trigger', draftOf(hook), hook, true).input['rotateSecret'], true);
});

await test('a newly issued secret is read once with its trigger, and examples quote it safely', () => {
  assert.equal(issuedSecret({ trigger, secret: null }), null);
  assert.deepEqual(issuedSecret({ trigger, secret: 'malt_trg_abc' }), {
    secret: 'malt_trg_abc',
    trigger: { name: 'CI failed', path: `/triggers/${TRIGGER}` },
  });
  assert.deepEqual(issuedSecret({ secret: 's' })?.trigger, { name: 'the trigger', path: '/triggers/<id>' });

  const path = `/triggers/${TRIGGER}`;
  assert.equal(triggerUrl({ url: 'http://127.0.0.1:4317//', team: null }, path), `http://127.0.0.1:4317${path}`);
  assert.match(triggerUrl(null, path), /<broker port>/v);
  const home = triggerExamples({ url: 'http://127.0.0.1:4317', team: null }, path);
  assert.ok(home.curl.includes(`Bearer ${SECRET_PLACEHOLDER}`));
  assert.doesNotMatch(home.curl, /x-agentmesh-team/v);
  assert.match(home.powershell, /Invoke-RestMethod -Method Post/v);
  const team = triggerExamples({ url: 'http://127.0.0.1:4317', team: "o'brien" }, path, 'malt_trg_x');
  assert.match(team.curl, /'x-agentmesh-team: o'\\''brien'/v, 'A quote cannot break out of the shell argument.');
  assert.match(team.powershell, /'x-agentmesh-team' = 'o''brien'/v);
  assert.match(team.curl, /Authorization: Bearer malt_trg_x/v);
});

void test('a minute step that does not divide the hour is not described as a fixed interval', () => {
  assert.notEqual(describeCron('*/40 * * * *').text, 'Every 40 minutes, every day.');
  assert.ok(describeCron('*/40 * * * *').text.includes('40'));
  assert.match(describeCron('*/15 * * * *').text, /15 minutes/v);
});
