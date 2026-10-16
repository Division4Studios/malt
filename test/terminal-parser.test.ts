/**
 * Tests of the browser VT parser. The module is pure TypeScript with no DOM use, so
 * Node imports the source directly.
 *
 * @file
 */

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';

import {
  MAX_DCS_LENGTH,
  MAX_OSC_LENGTH,
  MAX_PARAMS,
  MAX_PARAM_VALUE,
  TerminalParser,
} from '../web/src/terminal-parser.ts';

import type { TerminalAction } from '../web/src/terminal-parser.ts';

/**
 * Merge adjacent print actions, which chunk boundaries may split.
 *
 * @param actions - Raw actions.
 * @returns Normalized actions.
 */
function normalize(actions: TerminalAction[]): TerminalAction[] {
  const out: TerminalAction[] = [];
  for (const action of actions) {
    const previous = out.at(-1);
    if (action.type === 'print' && previous?.type === 'print') {
      previous.text += action.text;
    } else {
      out.push(structuredClone(action));
    }
  }
  return out;
}

const SAMPLE = Buffer.from(
  'héllo\u{1B}[1;31mred\u{1B}[0m\u{1B}[?25l\u{1B}[;5H\u{1B}]0;title\u{7}\u{1B}]8;;http://x\u{1B}\\link\u{1B}Pq#1\u{1B}\\' +
    '\u{1B}(B\u{1B}[38:2:1:2:3m\r\n日本語😀\u{1B}[2 q\u{1B}Xignored\u{1B}\\\u{1B}[1\u{18}ok\u{1B}_apc\u{7}\u{1B}\\',
);

await test('every split point yields the same actions as unsplit input', () => {
  const initial = new TerminalParser();
  const whole = normalize(initial.feed(SAMPLE));
  assert.ok(whole.some((a) => a.type === 'csi'));
  assert.ok(whole.some((a) => a.type === 'osc'));
  assert.ok(whole.some((a) => a.type === 'dcs'));
  for (let index = 1; index < SAMPLE.length; index += 1) {
    const parser = new TerminalParser();
    const split = normalize([...parser.feed(SAMPLE.subarray(0, index)), ...parser.feed(SAMPLE.subarray(index))]);
    assert.deepEqual(split, whole, `split at ${String(index)}`);
  }
  const byteParser = new TerminalParser();
  const bytewise = normalize([...SAMPLE].flatMap((byte) => byteParser.feed(Uint8Array.of(byte))));
  assert.deepEqual(bytewise, whole);
});

await test('parses CSI parameters, prefixes and defaults', () => {
  const parser = new TerminalParser();
  const actions = parser.feed('\u{1B}[?1;;3h');
  assert.deepEqual(actions, [{ type: 'csi', prefix: '?', params: [1, -1, 3], intermediates: '', final: 'h' }]);
});

await test('CAN aborts a sequence and OSC ends on BEL or ST', () => {
  const parser = new TerminalParser();
  const actions = parser.feed('\u{1B}[12\u{18}A\u{1B}]2;a\u{7}\u{1B}]2;b\u{1B}\\');
  assert.deepEqual(actions, [
    { type: 'print', text: 'A' },
    { type: 'osc', data: '2;a', truncated: false },
    { type: 'osc', data: '2;b', truncated: false },
  ]);
});

await test('oversized parameters, OSC and DCS are bounded', () => {
  const parser = new TerminalParser();
  const [csi] = parser.feed(`\u{1B}[${'9'.repeat(40)};${'1;'.repeat(100)}m`);
  assert.equal(csi?.type, 'csi');
  assert.equal(csi.params.length, MAX_PARAMS);
  assert.equal(csi.params[0], MAX_PARAM_VALUE);
  const [osc] = parser.feed(`\u{1B}]0;${'a'.repeat(MAX_OSC_LENGTH * 3)}\u{7}`);
  assert.ok(osc?.type === 'osc');
  assert.equal(osc.data.length, MAX_OSC_LENGTH);
  assert.equal(osc.truncated, true);
  const [dcs] = parser.feed(`\u{1B}Pq${'b'.repeat(MAX_DCS_LENGTH * 3)}\u{1B}\\`);
  assert.ok(dcs?.type === 'dcs');
  assert.equal(dcs.data.length, MAX_DCS_LENGTH);
  assert.equal(dcs.truncated, true);
});

await test('excess intermediates are ignored without emitting a sequence', () => {
  const parser = new TerminalParser();
  assert.deepEqual(parser.feed('\u{1B}[   mX'), [{ type: 'print', text: 'X' }]);
  assert.deepEqual(parser.feed('\u{1B}   cX'), [{ type: 'print', text: 'X' }]);
});

/**
 * Check retained fields against their independent parser ceilings.
 *
 * @param action - One completed parsed action.
 * @returns Whether every retained field obeys its ceiling.
 */
function isBounded(action: TerminalAction): boolean {
  switch (action.type) {
    case 'osc': {
      return action.data.length <= MAX_OSC_LENGTH;
    }
    case 'dcs': {
      return action.data.length <= MAX_DCS_LENGTH;
    }
    case 'csi': {
      return action.params.length <= MAX_PARAMS;
    }
    case 'print':
    case 'execute':
    case 'esc': {
      return true;
    }
  }
}

await test('1 MB of random bytes parses with bounded memory and no exception', () => {
  const bytes = randomBytes(1024 * 1024);
  // Bias toward escape introducers so sequences are exercised, not just text.
  for (let index = 0; index < bytes.length; index += 7) {
    bytes[index] = 0x1b;
  }
  const parser = new TerminalParser();
  let count = 0;
  for (let index = 0; index < bytes.length; index += 4096) {
    const actions = parser.feed(bytes.subarray(index, index + 4096));
    for (const action of actions) {
      count += 1;
      assert.ok(isBounded(action));
    }
  }
  assert.ok(count > 0);
  const unterminated = new TerminalParser();
  unterminated.feed(`\u{1B}]${'z'.repeat(1024 * 1024)}`);
  assert.deepEqual(unterminated.feed('\u{7}'), [{ type: 'osc', data: 'z'.repeat(MAX_OSC_LENGTH), truncated: true }]);
});
