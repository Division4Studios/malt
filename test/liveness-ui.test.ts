/**
 * How the console reads and describes attempt liveness, quota, stop reasons,
 * retry backoff and pending checkpoint decisions, in job details, Sessions and
 * the delivery manager. They import the compiled browser modules from
 * `web/dist`; the manager view renders into the text-only test DOM.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { livenessText, readConsole, retryText } from '../web/dist/console-model.js';
import { attemptOutcome, briefProgress, elapsedText, quotaText, stopText } from '../web/dist/liveness-text.js';
import { ManagerController } from '../web/dist/manager-controller.js';
import { managerView } from '../web/dist/manager-ui.js';

import { fake, installDom } from './dom-shim.ts';

/** One minute. */
const MINUTE = 60_000;
/** Fixed clock. */
const NOW = 1000 * MINUTE;

/**
 * A snapshot with one delivery carrying the given running, retry and stop fields.
 *
 * @param running - Running attempt field.
 * @param retry - Retry field.
 * @param stop - Recorded stop field.
 * @returns Untrusted snapshot.
 */
function snapshot(running: unknown, retry: unknown, stop?: unknown): unknown {
  return {
    factory: {
      console: {
        deliveries: [{ taskId: 'task-1', issue: 4, title: 'Fix', steps: [], running, retry, stop, attempts: 1 }],
        objectives: [],
        inbox: { open: [], answered: [] },
      },
    },
  };
}

await test('the console reads liveness and retry fields and tolerates their absence', () => {
  const liveness = {
    state: 'progressing',
    lastSignal: 'tool Bash',
    lastProgressAt: NOW - 2 * MINUTE,
    awaiting: null,
    nextCheckpointAt: NOW + 8 * MINUTE,
    extensions: 1,
    stopReason: null,
  };
  const [delivery] = readConsole(
    snapshot({ jobId: 'job-1', role: 'developer-1', step: 'implement', liveness }, null),
  ).deliveries;
  assert.deepEqual(delivery?.running?.liveness, liveness);
  assert.equal(delivery.retry, null);
  const [legacy] = readConsole(snapshot({ jobId: 'job-1', role: 'qa-1', step: null }, undefined)).deliveries;
  assert.equal(legacy?.running?.liveness, null, 'records saved before liveness read as unknown');
  const [waiting] = readConsole(snapshot(null, { failureClass: 'stalled', failures: 2, retryAt: 'soon' })).deliveries;
  assert.deepEqual(waiting?.retry, { failureClass: 'stalled', failures: 2, retryAt: null });
});

await test('liveness and retry text name the signal, the wait and the next step', () => {
  const base = {
    state: 'progressing',
    lastSignal: 'tool Bash',
    lastProgressAt: NOW - 2 * MINUTE,
    awaiting: null,
    nextCheckpointAt: NOW + 8 * MINUTE,
    extensions: 0,
    stopReason: null,
  };
  const progressing = livenessText(base, NOW);
  assert.match(progressing, /^Progressing · tool Bash 2m/v);
  assert.match(progressing, /next checkpoint in 8m/v);
  assert.match(livenessText({ ...base, extensions: 2 }, NOW), /extended 2×$/v);
  assert.match(
    livenessText({ ...base, state: 'awaiting_input', awaiting: 'Permission not granted for a tool call' }, NOW),
    /^Awaiting input · Permission not granted for a tool call/v,
  );
  assert.match(livenessText({ ...base, state: 'idle', lastSignal: null }, NOW), /^Idle · no progress yet/v);
  assert.match(
    retryText({ failureClass: 'stalled', failures: 2, retryAt: NOW + 9 * MINUTE }, NOW),
    /^Stalled 2 times · retrying in 9m/v,
  );
  assert.equal(
    retryText({ failureClass: 'invalid_output', failures: 3, retryAt: null }, NOW),
    'Returned no usable result 3 times · out of automatic retries; recover it or change its scope',
  );
  assert.match(retryText({ failureClass: 'unknown', failures: 1, retryAt: NOW }, NOW), /^Failed once/v);
});

/** A running attempt with a fresh quota reading and no liveness yet. */
const RUNNING = {
  jobId: 'job-1',
  role: 'developer-1',
  step: null,
  startedAt: NOW - 12 * MINUTE,
  liveness: null,
  quota: { freshness: 'current', headroomPercent: 60, observedAt: NOW - 2 * MINUTE },
};

await test('job details read quota and elapsed time, and never invent headroom', () => {
  const [delivery] = readConsole(snapshot(RUNNING, null)).deliveries;
  assert.equal(delivery?.running?.startedAt, NOW - 12 * MINUTE);
  assert.ok(delivery.running.quota !== null);
  assert.equal(quotaText(delivery.running.quota, NOW), 'quota headroom 60% · read 2m 00s ago');
  assert.equal(elapsedText(delivery.running.startedAt, NOW), '12m 00s');
  assert.equal(elapsedText(0, NOW), '—', 'an older broker sends no start time');
  const forged = { ...RUNNING, quota: { freshness: 'current', headroomPercent: 'plenty' } };
  const [unverified] = readConsole(snapshot(forged, null)).deliveries;
  assert.equal(unverified?.running?.quota?.freshness, 'unknown', 'a reading without a number is unknown');
  assert.equal(
    quotaText({ freshness: 'stale', headroomPercent: null, observedAt: NOW }, NOW),
    'quota reading stale, so unknown',
  );
  assert.equal(quotaText(null, NOW), 'quota unknown');
});

await test('job details show the recorded stop reason and a pending decision', () => {
  const [shown] = readConsole(
    snapshot(null, null, { jobId: 'job-2', reason: 'stalled 16 min', at: NOW, isAwaitingDecision: false }),
  ).deliveries;
  assert.ok(shown?.stop !== null && shown?.stop !== undefined);
  assert.equal(stopText(shown.stop), 'stalled 16 min');
  assert.equal(
    stopText({ ...shown.stop, reason: 'hard ceiling', isAwaitingDecision: true }),
    'hard ceiling · awaiting your continue-or-wait decision in the Inbox',
  );
  assert.equal(
    readConsole(snapshot(null, null, { reason: '' })).deliveries[0]?.stop,
    null,
    'a stop without a reason is not shown',
  );
  assert.equal(readConsole(snapshot(null, null)).deliveries[0]?.stop, null, 'an older broker sends no stop');
});

await test('every liveness state reads truthfully, including a checkpoint stopping the attempt', () => {
  const base = {
    state: 'progressing',
    lastSignal: 'tool Bash',
    lastProgressAt: NOW - 2 * MINUTE,
    awaiting: null,
    nextCheckpointAt: NOW + 8 * MINUTE,
    extensions: 0,
    stopReason: null,
  };
  assert.equal(
    livenessText({ ...base, state: 'stalled', stopReason: 'stalled 16 min' }, NOW),
    'Stalled · stopping: stalled 16 min',
  );
  assert.equal(
    livenessText({ ...base, state: 'ceiling', stopReason: 'hard ceiling' }, NOW),
    'At the hard ceiling · stopping: hard ceiling',
  );
  assert.equal(
    livenessText({ ...base, state: 'held', stopReason: 'no extension: codex quota reading is stale' }, NOW),
    'Held at a checkpoint · stopping: no extension: codex quota reading is stale',
  );
});

await test('Sessions shows the recorded stop reason instead of a generic interrupted', () => {
  const row = { state: 'interrupted', liveness: { state: 'stalled', stopReason: 'stalled 16 min' }, checkpoint: null };
  assert.equal(attemptOutcome(row), 'stalled 16 min');
  assert.equal(
    attemptOutcome({ ...row, liveness: { state: 'held', stopReason: 'hard ceiling' }, checkpoint: 'pending' }),
    'hard ceiling · awaiting your decision',
  );
  assert.equal(attemptOutcome({ ...row, liveness: null }), 'interrupted', 'no stop reason was recorded');
  assert.equal(attemptOutcome({ ...row, state: 'running' }), 'running');
});

await test('the manager column shows recorded liveness and quota, or checkpoint and output times before any', () => {
  const quota = { freshness: 'unknown', headroomPercent: null, observedAt: null };
  const liveness = {
    state: 'progressing',
    lastSignal: 'tool Bash',
    lastProgressAt: NOW - 2 * MINUTE,
    awaiting: null,
    nextCheckpointAt: NOW + 8 * MINUTE,
    extensions: 2,
    stopReason: null,
  };
  assert.equal(
    briefProgress({ liveness, quota, isPossiblyStalled: false }, NOW),
    'Progressing · tool Bash 2m 00s ago · next checkpoint in 8m 00s · extended 2× · quota unknown',
  );
  assert.equal(
    briefProgress({ liveness: null, progressAt: NOW - 3 * MINUTE, quota, isPossiblyStalled: true }, NOW),
    'checkpoint 3 min ago · possibly stalled · quota unknown',
  );
  assert.equal(briefProgress({ liveness: null, quota: null }, NOW), 'no evidence yet · quota unknown');
});

/** A manager summary with one checkpoint decision and one delivery whose attempt stopped. */
const SUMMARY = {
  status: { session: null, isLive: false },
  brief: {
    done: 0,
    objectives: [],
    decisions: [
      {
        kind: 'checkpoint',
        id: 'job-9',
        title: 'Continue or wait · developer-1 on #9 Parser',
        detail: 'Stopped at a checkpoint: hard ceiling.',
        resolveWith: 'Inbox: Continue 30 min, Continue 60 min or Wait',
        resolveView: 'inbox',
        head: 'head-9',
      },
    ],
    deliveries: [
      {
        issue: 9,
        title: 'Parser',
        stage: 'development',
        developer: 'developer-1',
        branch: 'feat/9',
        head: 'head-9',
        job: null,
        nextAction: 'Waiting to dispatch the developer.',
        lastStop: { jobId: 'job-9', reason: 'hard ceiling', at: NOW, isAwaitingDecision: true },
      },
    ],
  },
};

await test('a pending checkpoint is answered from the manager with fenced, keyboard-reachable buttons', (t) => {
  installDom(t);
  const sent: { operation: string; input: unknown }[] = [];
  const controller = new ManagerController({
    project: () => 'project-1',
    control: async (operation, input) => {
      sent.push({ operation, input });
      await Promise.resolve();
      return true;
    },
    notice: () => {
      /* Notices are not under test. */
    },
    render: () => {
      /* The view is rendered directly. */
    },
  });
  const view = fake(managerView(SUMMARY, controller));
  const card = view.descendants().find((node) => node.cssClass.split(' ').includes('decision-card'));
  assert.ok(card !== undefined);
  const buttons = card.querySelectorAll('button');
  assert.deepEqual(
    buttons.map((node) => node.textContent),
    ['Continue 30 min', 'Continue 60 min', 'Wait'],
  );
  for (const node of buttons) {
    assert.equal(Reflect.get(node, 'type'), 'button', 'a native button, reached and pressed from the keyboard');
    assert.equal(node.getAttribute('tabindex'), null);
  }
  const press = (index: number): void => {
    const node = buttons[index];
    const [handler] = node?.listeners.get('click') ?? [];
    assert.ok(typeof handler === 'function');
    Reflect.apply(handler, node, []);
  };
  press(0);
  press(0);
  press(2);
  assert.deepEqual(
    sent.map((call) => call.operation),
    ['factory_checkpoint_decide', 'factory_checkpoint_decide', 'factory_checkpoint_decide'],
  );
  const [first, again, wait] = sent.map((call) => call.input);
  assert.deepEqual(first, again, 'a retried press repeats the same request, so the broker reports a repeat');
  assert.ok(typeof first === 'object' && first !== null && typeof wait === 'object' && wait !== null);
  assert.deepEqual(
    { ...first, requestId: '' },
    {
      jobId: 'job-9',
      requestId: '',
      expectedHead: 'head-9',
      action: 'continue',
      minutes: 30,
    },
  );
  assert.deepEqual(
    { ...wait, requestId: '' },
    { jobId: 'job-9', requestId: '', expectedHead: 'head-9', action: 'wait' },
  );
  assert.equal(Reflect.get(wait, 'requestId'), Reflect.get(first, 'requestId'), 'one request id per attempt');
  const cells = view.querySelectorAll('td').map((cell) => cell.textContent);
  assert.ok(
    cells.includes(
      'Waiting to dispatch the developer. Last attempt stopped: hard ceiling · awaiting your continue-or-wait decision in the Inbox.',
    ),
    cells.join(' | '),
  );
});

await test('stop reasons and the mission table wrap or scroll on small screens', () => {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Reads only this repository's stylesheets.
  const sessions = readFileSync(new URL('../web/sessions.css', import.meta.url), 'utf8');
  assert.match(sessions, /\.attempt-outcome \{[^\}]*overflow-wrap: anywhere;/v);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Reads only this repository's stylesheets.
  const style = readFileSync(new URL('../web/style.css', import.meta.url), 'utf8');
  assert.match(style, /\.mission-table \{[^\}]*overflow-x: auto;/v);
});
