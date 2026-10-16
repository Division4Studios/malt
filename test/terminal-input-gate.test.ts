/** @file Numeric-only traffic limits with deterministic refill and backwards-clock fencing. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TERMINAL_INPUT_BYTES, TerminalInputGate } from '../src/factory/terminal-input-gate.ts';

await test('terminal input has bounded payload, burst, throughput and independent resize rate', () => {
  const gate = new TerminalInputGate(1000);
  for (let index = 0; index < 4; index += 1) {
    gate.take('input', TERMINAL_INPUT_BYTES, 1000);
  }
  assert.throws(() => {
    gate.take('input', 1, 1000);
  }, /traffic limit/v);
  assert.throws(() => {
    gate.take('input', 1, 0);
  }, /traffic limit/v);
  gate.take('input', TERMINAL_INPUT_BYTES, 2000);
  assert.throws(() => {
    gate.take('input', TERMINAL_INPUT_BYTES + 1, 3000);
  }, /payload limit/v);
  assert.throws(() => {
    gate.take('input', 0, 3000);
  }, /payload limit/v);
  for (let index = 0; index < 20; index += 1) {
    gate.take('resize', 0, 2000);
  }
  assert.throws(() => {
    gate.take('resize', 0, 2000);
  }, /traffic limit/v);
  gate.take('resize', 0, 2050);
  gate.take('input', TERMINAL_INPUT_BYTES, 3000);
});
