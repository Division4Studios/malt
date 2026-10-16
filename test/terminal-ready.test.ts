/** @file Silent native startup, bounded readiness and cancellation without paid processes. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { observeTerminalPid } from '../src/factory/terminal-ready.ts';

import type { TerminalClock } from '../src/factory/terminal-lifetime.ts';

await test('a silent native PID is announced independently of output and only once', () => {
  const pending = new Set<() => void>();
  const clock: TerminalClock = {
    later(fire) {
      pending.add(fire);
      return () => {
        pending.delete(fire);
      };
    },
  };
  let pid = 0;
  const announced: number[] = [];
  const readiness = observeTerminalPid(
    () => pid,
    (value) => {
      announced.push(value);
    },
    () => assert.fail('Unexpected timeout'),
    clock,
  );
  assert.equal(pending.size, 1);
  pid = 73;
  for (const fire of pending) {
    pending.delete(fire);
    fire();
  }
  readiness.check();
  assert.deepEqual(announced, [73]);
  assert.equal(pending.size, 0);
});

await test('PID readiness has a fixed deadline and cancellation removes its only timer', () => {
  const pending = new Set<() => void>();
  let elapsed = 0;
  const clock: TerminalClock = {
    later(fire, ms) {
      pending.add(fire);
      elapsed += ms;
      return () => {
        pending.delete(fire);
      };
    },
  };
  let failures = 0;
  const readiness = observeTerminalPid(
    () => 0,
    () => assert.fail('No PID exists'),
    () => {
      failures += 1;
    },
    clock,
  );
  for (let attempt = 0; attempt < 1000 && pending.size > 0; attempt += 1) {
    const fire = pending.values().next().value;
    assert.ok(fire !== undefined);
    pending.delete(fire);
    fire();
    assert.ok(pending.size <= 1);
  }
  assert.equal(failures, 1);
  assert.ok(elapsed <= 10_000);
  assert.equal(pending.size, 0);
  readiness.check();
  assert.equal(failures, 1);
  const cancelled = observeTerminalPid(
    () => 0,
    () => assert.fail('Cancelled'),
    () => assert.fail('Cancelled'),
    clock,
  );
  cancelled.cancel();
  cancelled.check();
  assert.equal(pending.size, 0);
});
