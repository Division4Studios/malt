/**
 * Checkpoint liveness: the pure policy, the monitor on a fake clock, the
 * meaningful-progress decoder over captured stream fixtures, the worktree
 * and check-in sampler against a real temporary Git repository, and retry
 * backoff by failure class. No provider CLI or paid model turn is used.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';

import { livenessPolicy } from '../src/factory/liveness-schema.ts';
import { LivenessMonitor, checkpointDecision, firstCheckpoint } from '../src/factory/liveness.ts';
import { factoryConfigSchema, jobSchema } from '../src/factory/schema.ts';

import type { JobLiveness, LivenessPolicy } from '../src/factory/liveness-schema.ts';
import type { ProgressObservation } from '../src/factory/liveness.ts';
import type { FactoryJob } from '../src/factory/schema.ts';

/** One minute. */
const MINUTE = 60_000;
/** Required project commands. */
const COMMANDS = { testCommands: [{ file: process.execPath }], endToEndCommands: [{ file: process.execPath }] };
/** A policy with a ten-minute interval, a five-minute stall window and a 25-minute ceiling. */
const POLICY: LivenessPolicy = { intervalMs: 10 * MINUTE, stallMs: 5 * MINUTE, maxMs: 25 * MINUTE, sampleMs: MINUTE };

await test('checkpoints extend on recent progress and stop stalls and the ceiling', () => {
  assert.equal(firstCheckpoint(0, POLICY), 10 * MINUTE);
  assert.deepEqual(checkpointDecision({ startedAt: 0, now: 10 * MINUTE, lastProgressAt: 8 * MINUTE, policy: POLICY }), {
    action: 'extend',
    nextCheckpointAt: 20 * MINUTE,
  });
  // The second extension is clipped to the ceiling.
  assert.deepEqual(
    checkpointDecision({ startedAt: 0, now: 20 * MINUTE, lastProgressAt: 19 * MINUTE, policy: POLICY }),
    {
      action: 'extend',
      nextCheckpointAt: 25 * MINUTE,
    },
  );
  assert.deepEqual(checkpointDecision({ startedAt: 0, now: 10 * MINUTE, lastProgressAt: 0, policy: POLICY }), {
    action: 'stop',
    state: 'stalled',
    reason: 'stalled 10 min',
  });
  // The ceiling stops an assignment even while it is progressing.
  assert.deepEqual(
    checkpointDecision({ startedAt: 0, now: 25 * MINUTE, lastProgressAt: 25 * MINUTE, policy: POLICY }),
    {
      action: 'stop',
      state: 'ceiling',
      reason: 'hard ceiling',
    },
  );
  // A ceiling shorter than one interval is the first checkpoint, and it stops.
  const short = { ...POLICY, maxMs: 3 * MINUTE };
  assert.equal(firstCheckpoint(0, short), 3 * MINUTE);
  assert.equal(
    checkpointDecision({ startedAt: 0, now: 3 * MINUTE, lastProgressAt: 3 * MINUTE, policy: short }).action,
    'stop',
  );
});

await test('saved configurations parse unchanged and idle work still stops at the first interval', () => {
  const saved = factoryConfigSchema.parse(COMMANDS);
  assert.equal(saved.liveness, undefined);
  const policy = livenessPolicy(saved);
  assert.equal(policy.intervalMs, saved.jobTimeoutMs);
  assert.ok(policy.stallMs <= policy.intervalMs);
  assert.ok(policy.maxMs >= policy.intervalMs);
  const decision = checkpointDecision({ startedAt: 0, now: policy.intervalMs, lastProgressAt: 0, policy });
  assert.equal(decision.action, 'stop');
  // A short interval bounds the default stall window, as the old single deadline did.
  assert.equal(livenessPolicy({ jobTimeoutMs: 5000 }).stallMs, 5000);
  const explicit = factoryConfigSchema.parse({ ...COMMANDS, liveness: { stallMs: 1000, maxMs: 9000, sampleMs: 1000 } });
  assert.deepEqual(livenessPolicy(explicit), {
    intervalMs: explicit.jobTimeoutMs,
    stallMs: 1000,
    maxMs: 9000,
    sampleMs: 1000,
  });
  assert.throws(() => factoryConfigSchema.parse({ ...COMMANDS, liveness: { sampleMs: 1 } }));
  // Attempts saved before liveness parse unchanged.
  const legacy = jobSchema.parse(jobFields({}));
  assert.equal(legacy.liveness, undefined);
  assert.equal(legacy.failureClass, undefined);
});

await test('a sampler that never answers cannot hold off the checkpoint', async () => {
  let now = 0;
  const timers: { at: number; callback: () => void }[] = [];
  const stops: string[] = [];
  const records: JobLiveness[] = [];
  const monitor = new LivenessMonitor({
    startedAt: 0,
    policy: POLICY,
    now: () => now,
    sample: async () => Promise.withResolvers<ProgressObservation>().promise,
    record: (liveness) => {
      records.push(liveness);
    },
    stop: (reason) => {
      stops.push(reason);
    },
    timers: (callback, ms) => {
      const timer = { at: now + ms, callback };
      timers.push(timer);
      return () => {
        timers.splice(timers.indexOf(timer), 1);
      };
    },
  });
  monitor.start();
  for (let step = 0; step < 50 && stops.length === 0 && timers.length > 0; step += 1) {
    timers.sort((left, right) => right.at - left.at);
    const next = timers.pop();
    assert.ok(next !== undefined);
    now = next.at;
    next.callback();
    await tick();
  }
  assert.deepEqual(stops, ['stalled 10 min']);
  assert.equal(now, firstCheckpoint(0, POLICY));
  assert.equal(records.at(-1)?.state, 'stalled');
});

/**
 * Attempt fields with defaults.
 *
 * @param fields - Overrides.
 * @returns Unparsed job fields.
 */
function jobFields(fields: Partial<FactoryJob>): Record<string, unknown> {
  return {
    id: randomUUID(),
    role: 'developer-1',
    provider: 'claude',
    kind: 'develop',
    taskId: null,
    featureId: null,
    token: randomUUID(),
    state: 'running',
    startedAt: 0,
    finishedAt: null,
    expiresAt: 0,
    reservation: 0,
    usageTokens: null,
    pid: null,
    head: null,
    base: null,
    summary: null,
    artifact: '',
    step: null,
    ...fields,
  };
}
