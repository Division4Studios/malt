/**
 * Checkpoint liveness: the pure policy, the monitor on a fake clock, the
 * meaningful-progress decoder over captured stream fixtures, the worktree
 * and check-in sampler against a real temporary Git repository, and retry
 * backoff by failure class. No provider CLI or paid model turn is used.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';

import { run } from '../src/database.ts';
import { livenessPolicy } from '../src/factory/liveness-schema.ts';
import { checkpointDecision, firstCheckpoint, LivenessMonitor } from '../src/factory/liveness.ts';
import { LINE_BYTES_MAX, ProgressSampler, ProgressSink, StreamTail } from '../src/factory/progress-signals.ts';
import { FactoryRepository } from '../src/factory/repository.ts';
import { classifyAttempt, isBackingOff, retryState, RETRY_POLICY } from '../src/factory/retry-policy.ts';
import { factoryConfigSchema, jobSchema } from '../src/factory/schema.ts';
import { claudeLine, codexLine } from '../src/factory/transcript-events.ts';
import { MeshError } from '../src/protocol.ts';
import { Store } from '../src/store.ts';

import { createCleanup, createProject } from './helpers.ts';

import type { JobLiveness, LivenessPolicy, FailureClass } from '../src/factory/liveness-schema.ts';
import type { ProgressObservation } from '../src/factory/liveness.ts';
import type { FactoryJob } from '../src/factory/schema.ts';

/** One minute. */
const MINUTE = 60_000;
/** Required project commands. */
const COMMANDS = { testCommands: [{ file: process.execPath }], endToEndCommands: [{ file: process.execPath }] };
/** A policy with a ten-minute interval, a five-minute stall window and a 25-minute ceiling. */
const POLICY: LivenessPolicy = { intervalMs: 10 * MINUTE, stallMs: 5 * MINUTE, maxMs: 25 * MINUTE, sampleMs: MINUTE };

/**
 * Write a file inside the test's own temporary project.
 *
 * @param file - Path.
 * @param text - Content.
 */
function write(file: string, text: string): void {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Paths are inside the test's own temporary project.
  writeFileSync(file, text);
}

/**
 * Append to a file inside the test's own temporary project.
 *
 * @param file - Path.
 * @param text - Appended content.
 */
function append(file: string, text: string): void {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Paths are inside the test's own temporary project.
  appendFileSync(file, text);
}

/**
 * Create a directory inside the test's own temporary project.
 *
 * @param directory - Path.
 * @param options - Creation options.
 */
function makeDirectory(directory: string, options?: { recursive: true }): void {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Paths are inside the test's own temporary project.
  mkdirSync(directory, options);
}

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

/**
 * Decode lines into a fresh progress sink.
 *
 * @param decode - Provider decoder.
 * @param events - Stream events.
 * @returns The sink.
 */
function decodeAll(decode: typeof claudeLine, events: readonly unknown[]): ProgressSink {
  const sink = new ProgressSink();
  for (const event of events) {
    decode(sink, JSON.stringify(event));
  }
  return sink;
}

await test('only completed tool calls and edits count as Claude and Codex progress', () => {
  const thinking = Array.from({ length: 50 }, (_, index) => {
    return {
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: `step ${String(index)}` },
          { type: 'text', text: 'Working.' },
        ],
      },
    };
  });
  assert.equal(decodeAll(claudeLine, thinking).meaningful, 0, 'thinking and prose bursts are not progress');

  const toolUse = {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] },
  };
  const toolResult = {
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
  };
  const started = decodeAll(claudeLine, [toolUse]);
  assert.equal(started.meaningful, 0, 'a started call is not progress');
  const completed = decodeAll(claudeLine, [toolUse, toolResult, toolResult]);
  assert.equal(completed.meaningful, 1, 'a duplicate completion counts once');
  assert.equal(completed.lastSignal, 'tool Bash');

  const repeated = decodeAll(claudeLine, [
    toolUse,
    toolResult,
    {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm test' } }] },
    },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'ok' }] } },
  ]);
  assert.equal(repeated.meaningful, 1, 'repeated identical output counts once');

  const denied = decodeAll(claudeLine, [
    {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: 'a.ts' } }] },
    },
    {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'w1',
            is_error: true,
            content: "Claude requested permissions to write to a.ts, but you haven't granted it yet.",
          },
        ],
      },
    },
  ]);
  assert.equal(denied.meaningful, 0, 'a permission wait is not progress');
  assert.equal(denied.awaiting, 'Permission not granted for a tool call');

  const question = decodeAll(claudeLine, [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'q1', name: 'AskUserQuestion', input: {} }] } },
  ]);
  assert.equal(question.awaiting, 'Question through AskUserQuestion');

  const codex = decodeAll(codexLine, [
    { type: 'thread.started' },
    { type: 'item.completed', item: { id: 'r1', type: 'reasoning', text: 'thinking' } },
    { type: 'item.started', item: { id: 'c1', type: 'command_execution', command: 'npm test', status: 'in_progress' } },
    {
      type: 'item.completed',
      item: { id: 'c1', type: 'command_execution', command: 'npm test', exit_code: 1, aggregated_output: 'fail' },
    },
    {
      type: 'item.completed',
      item: { id: 'c1', type: 'command_execution', command: 'npm test', exit_code: 1, aggregated_output: 'fail' },
    },
    {
      type: 'item.completed',
      item: { id: 'f1', type: 'file_change', changes: [{ path: 'src/a.ts', kind: 'update' }] },
    },
    { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } },
  ]);
  assert.equal(codex.meaningful, 2, 'a failed check still completed; the duplicate and reasoning do not count');
  assert.equal(codex.lastSignal, 'edit src/a.ts');
  const approval = decodeAll(codexLine, [{ type: 'exec_approval_request', call_id: 'x' }]);
  assert.equal(approval.awaiting, 'Waiting on exec_approval_request');
});

await test('the stream tail carries split lines and skips oversized ones within bounded reads', async (t) => {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  const file = path.join(mesh.directory, 'stdout.log');
  const lines: string[] = [];
  const tail = new StreamTail(file, (line) => {
    lines.push(line);
  });
  await tail.poll();
  assert.deepEqual(lines, [], 'a missing log reads as empty');
  const event = JSON.stringify({ type: 'result', text: 'é done' });
  write(file, event.slice(0, 10));
  await tail.poll();
  assert.deepEqual(lines, [], 'a partial line waits for its end');
  append(file, `${event.slice(10)}\n`);
  await tail.poll();
  assert.deepEqual(lines, [event]);
  append(file, `${'x'.repeat(LINE_BYTES_MAX + 10)}\n{"type":"after"}\n`);
  await tail.poll();
  assert.equal(tail.oversized, 1);
  assert.deepEqual(lines, [event, '{"type":"after"}']);
  write(file, '{"type":"rotated"}\n');
  await tail.poll();
  assert.deepEqual(lines.slice(-1), ['{"type":"rotated"}'], 'a replaced log is read from its start');
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

/**
 * Run Git in a test repository.
 *
 * @param cwd - Repository.
 * @param args - Git arguments.
 */
function git(cwd: string, args: readonly string[]): void {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- Shell-free Git against the test's own temporary repository.
  execFileSync('git', ['-c', 'user.name=MALT', '-c', 'user.email=malt@example.invalid', ...args], {
    cwd,
    stdio: 'ignore',
  });
}

await test('the sampler sees edits, commits, check-ins and decoded tool completions, not idle trees', async (t) => {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  const store = new Store(mesh);
  defer(() => {
    store.close();
  });
  // Opening the repository creates the factory tables.
  const repository = new FactoryRepository(store);
  const worktree = path.join(mesh.root, 'worktree');
  makeDirectory(worktree);
  git(worktree, ['init', '-q']);
  write(path.join(worktree, 'a.txt'), 'one\n');
  git(worktree, ['add', '.']);
  git(worktree, ['commit', '-q', '-m', 'start']);
  const artifact = path.join(mesh.directory, 'factory', 'jobs', 'sampled');
  makeDirectory(artifact, { recursive: true });
  const job = jobSchema.parse(jobFields({ artifact }));
  run(store.db, 'INSERT INTO factory_jobs VALUES(?,?,?,?)', job.id, job.role, job.state, JSON.stringify(job));
  assert.equal(repository.jobs().length, 1);
  const sampler = new ProgressSampler({ store, jobId: job.id, provider: 'claude', artifact, worktree: () => worktree });
  assert.deepEqual(await sampler.sample(), { progress: null, awaiting: null }, 'the first sample is a baseline');
  assert.equal((await sampler.sample()).progress, null, 'an unchanged tree is not progress');
  write(path.join(worktree, 'a.txt'), 'two\n');
  assert.equal((await sampler.sample()).progress, 'tracked edit');
  git(worktree, ['commit', '-q', '-am', 'second']);
  assert.equal((await sampler.sample()).progress, 'commit');
  run(store.db, 'INSERT INTO factory_progress VALUES(?,?,?)', job.id, 'started', 'Started.');
  assert.equal((await sampler.sample()).progress, null, "the supervisor's start notice is not a check-in");
  run(store.db, 'INSERT INTO factory_progress VALUES(?,?,?)', job.id, 'reproduced', 'Reproduced the bug.');
  assert.equal((await sampler.sample()).progress, 'check-in reproduced');
  const events = [
    {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.txt' } }] },
    },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'two' }] } },
  ];
  write(path.join(artifact, 'stdout.log'), `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
  assert.equal((await sampler.sample()).progress, 'tool Read');
  append(path.join(artifact, 'stdout.log'), '{"type":"assistant","message":{"content":[]}}\n'.repeat(20));
  assert.equal((await sampler.sample()).progress, null, 'log growth alone is not progress');
});

await test('failures are classified and retried with per-class backoff and caps', () => {
  const base = {
    waiting: null,
    reason: null,
    isCoolingDown: false,
    isResultMissing: false,
    stopReason: null,
    isStopping: false,
  };
  assert.equal(classifyAttempt({ ...base, state: 'succeeded' }), null);
  assert.equal(classifyAttempt({ ...base, state: 'failed', waiting: 'Waiting for checks.' }), 'gate');
  assert.equal(classifyAttempt({ ...base, state: 'failed', error: new MeshError('FACTORY_GATED', 'Gate.') }), 'gate');
  assert.equal(classifyAttempt({ ...base, state: 'interrupted', isCoolingDown: true }), 'rate_limit');
  assert.equal(classifyAttempt({ ...base, state: 'failed', reason: 'Usage limit reached.' }), 'rate_limit');
  assert.equal(classifyAttempt({ ...base, state: 'interrupted', stopReason: 'stalled 30 min' }), 'stalled');
  assert.equal(classifyAttempt({ ...base, state: 'interrupted', isStopping: true }), 'cancelled');
  assert.equal(classifyAttempt({ ...base, state: 'failed', isResultMissing: true }), 'invalid_output');
  assert.equal(classifyAttempt({ ...base, state: 'failed', reason: 'spawn ENOENT' }), 'transient');

  const taskId = randomUUID();
  const scope = { kind: 'review' as const, taskId, featureId: null, head: 'h1', step: 'qa-1' };

  /**
   * A finished review attempt.
   *
   * @param finishedAt - Settlement time.
   * @param failureClass - Recorded class, if any.
   * @param state - Final state.
   * @returns Parsed attempt.
   */
  const attempt = (
    finishedAt: number,
    failureClass?: FailureClass,
    state: FactoryJob['state'] = 'failed',
  ): FactoryJob => {
    return jobSchema.parse(
      jobFields({
        kind: 'review',
        role: 'qa-1',
        taskId,
        head: 'h1',
        step: 'qa-1',
        state,
        finishedAt,
        ...(failureClass !== undefined && { failureClass }),
      }),
    );
  };
  const timing = { now: 0, reconcileMs: 30_000 };
  assert.equal(retryState([], scope, timing.reconcileMs), null);
  assert.deepEqual(retryState([attempt(0)], scope, timing.reconcileMs), {
    failureClass: 'transient',
    failures: 1,
    retryAt: 30_000,
  });
  assert.equal(
    retryState([attempt(0, undefined, 'interrupted')], scope, timing.reconcileMs),
    null,
    'legacy interruptions retry now',
  );
  const transient = [attempt(0, 'transient'), attempt(1000, 'transient'), attempt(2000, 'transient')];
  assert.equal(
    retryState(transient, scope, timing.reconcileMs)?.retryAt,
    2000 + (RETRY_POLICY.transient.baseMs ?? 0) * 4,
  );
  const stalled = [attempt(0, 'stalled'), attempt(1, 'stalled'), attempt(2, 'stalled')];
  assert.deepEqual(retryState(stalled, scope, timing.reconcileMs), {
    failureClass: 'stalled',
    failures: 3,
    retryAt: null,
  });
  assert.ok(
    isBackingOff(stalled, scope, { ...timing, now: Number.MAX_SAFE_INTEGER }),
    'exhausted retries stay stopped',
  );
  assert.ok(!isBackingOff(stalled, { ...scope, head: 'h2' }, timing), 'a new head resets retries');
  assert.ok(!isBackingOff([...stalled, attempt(3, undefined, 'succeeded')], scope, timing), 'a success resets retries');
  const gates = Array.from({ length: 10 }, (_, index) => attempt(index, 'gate'));
  assert.equal(
    retryState(gates, scope, timing.reconcileMs)?.retryAt,
    9 + 30_000,
    'gates wait one reconcile interval, forever',
  );
  assert.ok(!isBackingOff([attempt(0, 'cancelled')], scope, timing), 'cancelled work retries as soon as it resumes');
  const mixed = [attempt(0, 'stalled'), attempt(1, 'stalled'), attempt(2, 'transient')];
  assert.equal(retryState(mixed, scope, timing.reconcileMs)?.failures, 1, 'a different class starts a new count');
});

await test('a wait raised after progress in one poll survives out-of-band progress', async (t) => {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  // The repository creates the factory tables.
  const { store } = new FactoryRepository(new Store(mesh));
  defer(() => {
    store.close();
  });
  const job = jobSchema.parse(jobFields({ artifact: mesh.directory }));
  run(store.db, 'INSERT INTO factory_jobs VALUES(?,?,?,?)', job.id, job.role, job.state, JSON.stringify(job));
  const sampler = new ProgressSampler({
    store,
    jobId: job.id,
    provider: 'claude',
    artifact: mesh.directory,
    worktree: () => null,
  });
  const events = [
    {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] },
    },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'q1', name: 'AskUserQuestion', input: {} }] } },
  ];
  const log = events.map((event) => `${JSON.stringify(event)}\n`);
  write(path.join(mesh.directory, 'stdout.log'), log.join(''));
  run(store.db, 'INSERT INTO factory_progress VALUES(?,?,?)', job.id, 'tests-pass', '{}');
  const observed = await sampler.sample();
  assert.notEqual(observed.progress, null);
  assert.equal(observed.awaiting, 'Question through AskUserQuestion');
  assert.equal((await sampler.sample()).awaiting, 'Question through AskUserQuestion', 'later idle polls keep the wait');
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

await test('separate patches to one file each count as progress; a repeated item counts once', () => {
  const sink = new ProgressSink();
  const change = [{ path: 'src/a.ts', kind: 'update' }];
  sink.fileChange(change, 'item_1');
  sink.fileChange(change, 'item_2');
  sink.fileChange(change, 'item_2');
  assert.equal(sink.meaningful, 2);
  assert.equal(sink.lastSignal, 'edit src/a.ts');
});
