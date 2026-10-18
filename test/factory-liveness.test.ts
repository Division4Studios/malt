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
import { checkpointDecision, firstCheckpoint, LivenessMonitor } from '../src/factory/liveness.ts';
import { ProgressSink } from '../src/factory/progress-signals.ts';
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

/** A monitor driven by a fake clock and manual timers. */
interface Harness {
  /** Monitor under test. */
  readonly monitor: LivenessMonitor;
  /** Recorded liveness records. */
  readonly records: JobLiveness[];
  /** Stop reasons. */
  readonly stops: string[];
  /** Advance the clock and run one check. */
  readonly advance: (now: number, observation: ProgressObservation) => Promise<void>;
  /** Pending timer delays. */
  readonly delays: number[];
}

/**
 * Build a monitor on the test policy whose clock and samples the test controls.
 *
 * @returns Monitor, its records, stops and timer requests.
 */
function harness(): Harness {
  let clock = 0;
  let next: ProgressObservation = { progress: null, awaiting: null };
  const records: JobLiveness[] = [];
  const stops: string[] = [];
  const delays: number[] = [];
  const monitor = new LivenessMonitor({
    startedAt: 0,
    policy: POLICY,
    now: () => clock,
    sample: async () => {
      await Promise.resolve();
      return next;
    },
    record: (liveness) => {
      records.push(liveness);
    },
    stop: (reason) => {
      stops.push(reason);
    },
    timers: (_callback, ms) => {
      delays.push(ms);
      return () => {
        delays.push(-1);
      };
    },
  });
  monitor.start();
  return {
    monitor,
    records,
    stops,
    delays,
    advance: async (now, observation) => {
      clock = now;
      next = observation;
      await monitor.check();
    },
  };
}

await test('the monitor extends productive work, records awaiting input and stops a stall', async () => {
  const run1 = harness();
  assert.equal(run1.records[0]?.state, 'idle');
  assert.equal(run1.delays[0], MINUTE);
  await run1.advance(8 * MINUTE, { progress: 'tool Bash', awaiting: null });
  assert.equal(run1.monitor.liveness.state, 'progressing');
  assert.equal(run1.monitor.liveness.lastSignal, 'tool Bash');
  await run1.advance(10 * MINUTE, { progress: null, awaiting: null });
  assert.equal(run1.monitor.liveness.extensions, 1);
  assert.equal(run1.monitor.liveness.nextCheckpointAt, 20 * MINUTE);
  assert.deepEqual(run1.stops, []);
  await run1.advance(12 * MINUTE, { progress: null, awaiting: 'Permission not granted for a tool call' });
  assert.equal(run1.monitor.liveness.state, 'awaiting_input');
  await run1.advance(20 * MINUTE, { progress: null, awaiting: null });
  assert.deepEqual(run1.stops, ['stalled 12 min (awaiting input)']);
  assert.equal(run1.monitor.liveness.state, 'stalled');
  assert.equal(run1.records.at(-1)?.stopReason, 'stalled 12 min (awaiting input)');
  const recorded = run1.records.length;
  await run1.advance(30 * MINUTE, { progress: 'tool Bash', awaiting: null });
  assert.equal(run1.records.length, recorded, 'a stopped monitor records nothing more');

  const run2 = harness();
  for (const minute of [9, 19]) {
    await run2.advance(minute * MINUTE, { progress: `tool ${String(minute)}`, awaiting: null });

    await run2.advance((minute + 1) * MINUTE, { progress: null, awaiting: null });
  }
  await run2.advance(25 * MINUTE, { progress: 'tool late', awaiting: null });
  assert.deepEqual(run2.stops, ['hard ceiling']);
  assert.equal(run2.monitor.liveness.extensions, 2);

  const run3 = harness();
  run3.monitor.dispose();
  assert.equal(run3.delays.at(-1), -1, 'dispose cancels the pending wake-up');
  await run3.advance(30 * MINUTE, { progress: null, awaiting: null });
  assert.deepEqual(run3.stops, []);
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

await test('separate patches to one file each count as progress; a repeated item counts once', () => {
  const sink = new ProgressSink();
  const change = [{ path: 'src/a.ts', kind: 'update' }];
  sink.fileChange(change, 'item_1');
  sink.fileChange(change, 'item_2');
  sink.fileChange(change, 'item_2');
  assert.equal(sink.meaningful, 2);
  assert.equal(sink.lastSignal, 'edit src/a.ts');
});
