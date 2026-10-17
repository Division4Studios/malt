/**
 * DOM-free tests of how the console reads and describes attempt liveness and
 * retry backoff. They import the compiled browser modules from `web/dist`.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { livenessText, readConsole, retryText } from '../web/dist/console-model.js';

/** One minute. */
const MINUTE = 60_000;
/** Fixed clock. */
const NOW = 1000 * MINUTE;

/**
 * A snapshot with one delivery carrying the given running and retry fields.
 *
 * @param running - Running attempt field.
 * @param retry - Retry field.
 * @returns Untrusted snapshot.
 */
function snapshot(running: unknown, retry: unknown): unknown {
  return {
    factory: {
      console: {
        deliveries: [{ taskId: 'task-1', issue: 4, title: 'Fix', steps: [], running, retry, attempts: 1 }],
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
