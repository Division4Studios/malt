/** @file Fake-clock timeout evidence and cancellation fencing without paid/native processes. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AdmissionPool } from '../src/factory/admission.ts';
import { FactoryRepository } from '../src/factory/repository.ts';
import { factoryConfigSchema } from '../src/factory/schema.ts';
import { TerminalLifetime, terminalPolicySchema } from '../src/factory/terminal-lifetime.ts';
import { TerminalService } from '../src/factory/terminals.ts';
import { Store } from '../src/store.ts';

import { createCleanup, createProject } from './helpers.ts';
import { terminalProject } from './terminal-project.ts';

import type { Frame } from '../src/factory/terminal-frames.ts';
import type { TerminalClock } from '../src/factory/terminal-lifetime.ts';

await test('fake clock distinguishes idle and absolute deadlines and disposes every timer', () => {
  let now = 0;
  const timers = new Map<() => void, number>();
  const clock: TerminalClock = {
    later(callback, ms) {
      timers.set(callback, now + ms);
      return () => {
        timers.delete(callback);
      };
    },
  };
  const reasons: string[] = [];
  const policy = terminalPolicySchema.parse({ idleMs: 1000, maximumMs: 2000 });
  const idle = new TerminalLifetime(
    policy,
    (reason) => {
      reasons.push(reason);
    },
    clock,
  );
  now = 500;
  idle.touch();
  assert.deepEqual(
    timers
      .values()
      .toArray()
      .toSorted((a, b) => a - b),
    [1500, 2000],
  );
  for (const [expire, at] of timers) {
    if (at === 1500) {
      expire();
    }
  }
  assert.deepEqual(reasons, ['idle timeout']);
  assert.equal(timers.size, 0);
  idle.close();
  idle.touch();
  assert.equal(timers.size, 0);
  const absolute = new TerminalLifetime(
    policy,
    (reason) => {
      reasons.push(reason);
    },
    clock,
  );
  now = 1400;
  absolute.touch();
  now = 2300;
  absolute.touch();
  for (const [expire, at] of timers) {
    if (at === 2500) {
      expire();
    }
  }
  assert.deepEqual(reasons, ['idle timeout', 'maximum duration']);
  assert.equal(timers.size, 0);
  absolute.close();
});

await test('pause fences pending preflight and shutdown permanently refuses new starts', async (t) => {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  const store = new Store(mesh);
  defer(() => {
    store.close();
  });
  const repository = new FactoryRepository(store);
  repository.configure(
    factoryConfigSchema.parse({ testCommands: [{ file: 'node' }], endToEndCommands: [{ file: 'node' }] }),
  );
  const pool = new AdmissionPool();
  const gate = Promise.withResolvers<undefined>();
  const service = new TerminalService(mesh, repository, {
    inspectMcp: async () => {
      await Promise.resolve();
      return [];
    },
    pool,
    resources: () => ({ freeMemoryMb: 20_000, totalMemoryMb: 32_000, cpuPercent: 0 }),
    preflight: async () => {
      await gate.promise;
    },
    spawn() {
      assert.fail('Cancellation must prevent native spawn.');
    },
  });
  const pending = service.start({ provider: 'codex', columns: 80, rows: 24 });
  const rejection = assert.rejects(pending, /cancelled/v);
  assert.equal(pool.size, 1);
  const paused = service.closeAll('factory paused');
  gate.resolve(undefined);
  await Promise.all([paused, rejection]);
  assert.equal(pool.size, 0);
  assert.equal(service.size, 0);
  assert.deepEqual(repository.terminals.list(), []);
  await service.closeAll('broker shutdown', true);
  await assert.rejects(service.start({ provider: 'codex', columns: 80, rows: 24 }), /cancelled/v);
});

await test('timeout, pause and shutdown persist distinct causes despite late successful results', async (t) => {
  const { mesh, repository, settings, defer } = await terminalProject(t);
  settings.terminals.idleMs = 1000;
  settings.terminals.maximumMs = 2000;
  repository.configure(settings);
  const timers = new Set<{ fire: () => void; ms: number }>();
  const results: ((frame: Frame) => void)[] = [];
  const service = new TerminalService(mesh, repository, {
    inspectMcp: async () => {
      await Promise.resolve();
      return [];
    },
    pool: new AdmissionPool(),
    resources: () => ({ freeMemoryMb: 20_000, totalMemoryMb: 32_000, cpuPercent: 0 }),
    preflight: async () => {
      await Promise.resolve();
    },
    clock: {
      later(fire, ms) {
        const entry = { fire, ms };
        timers.add(entry);
        return () => {
          timers.delete(entry);
        };
      },
    },
    spawn(spec) {
      const completion = Promise.withResolvers<undefined>();
      results.push(spec.onFrame);
      queueMicrotask(() => {
        spec.onFrame({ type: 'started', pid: 1234 });
      });
      return {
        closed: completion.promise,
        send() {
          assert.fail('No input expected.');
        },
        async stop() {
          completion.resolve(undefined);
          await completion.promise;
        },
      };
    },
  });
  defer(async () => service.closeAll('test cleanup', true));
  for (const [delay, reason] of [
    [1000, 'idle timeout'],
    [2000, 'maximum duration'],
  ] as const) {
    const session = await service.start({ provider: 'codex', columns: 80, rows: 24 });
    const deadline = timers.values().find((entry) => entry.ms === delay);
    assert.ok(deadline !== undefined);
    deadline.fire();

    await Promise.resolve();

    const ended = await service.close(session.id);
    assert.equal(ended.state, 'timed_out');
    assert.equal(ended.reason, reason);
    for (const result of results) {
      result({ type: 'exit', code: 0, signal: null });
    }
    assert.equal(repository.terminals.get(session.id)?.state, 'timed_out');
    assert.equal(timers.size, 0);
  }
  const paused = await service.start({ provider: 'codex', columns: 80, rows: 24 });
  await service.closeAll('factory paused');
  assert.equal(repository.terminals.get(paused.id)?.reason, 'factory paused');
  const shutdown = await service.start({ provider: 'codex', columns: 80, rows: 24 });
  await service.closeAll('broker shutdown', true);
  assert.equal(repository.terminals.get(shutdown.id)?.state, 'cancelled');
  assert.equal(repository.terminals.get(shutdown.id)?.reason, 'broker shutdown');
  assert.equal(timers.size, 0);
});
