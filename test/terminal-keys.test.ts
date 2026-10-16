/** @file Native key modes, browser focus escape and bounded control-safe pastes. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { terminalKey, terminalPaste } from '../web/src/terminal-keys.ts';

/** Unmodified focus-scoped observation. */
const plain = { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, isComposing: false };

await test('keyboard uses negotiated cursor modes, modifiers and real VT control bytes', () => {
  assert.equal(terminalKey({ ...plain, key: 'ArrowUp' }, false), '\u{1B}[A');
  assert.equal(terminalKey({ ...plain, key: 'ArrowUp' }, true), '\u{1B}OA');
  assert.equal(terminalKey({ ...plain, key: 'ArrowLeft', ctrlKey: true }, true), '\u{1B}[1;5D');
  assert.equal(terminalKey({ ...plain, key: 'PageDown', shiftKey: true }, false), '\u{1B}[6;2~');
  assert.equal(terminalKey({ ...plain, key: 'F1' }, false), '\u{1B}OP');
  assert.equal(terminalKey({ ...plain, key: 'F12' }, false), '\u{1B}[24~');
  assert.equal(terminalKey({ ...plain, key: 'Enter' }, false), '\r');
  assert.equal(terminalKey({ ...plain, key: 'Tab' }, false), '\t');
  assert.equal(terminalKey({ ...plain, key: 'Tab', shiftKey: true }, false), '\u{1B}[Z');
  assert.equal(terminalKey({ ...plain, key: 'Enter', ctrlKey: true }, false), '\r');
  assert.equal(terminalKey({ ...plain, key: 'Backspace' }, false), '\u{7F}');
  assert.equal(terminalKey({ ...plain, key: 'c', ctrlKey: true }, false), '\u{3}');
  assert.equal(terminalKey({ ...plain, key: '\u{DF}', ctrlKey: true }, false), null);
  assert.equal(terminalKey({ ...plain, key: 'x', altKey: true }, false), '\u{1B}x');
  assert.equal(terminalKey({ ...plain, key: '日' }, false), '日');
});

await test('Escape, OS/browser shortcuts and composing keys retain browser handling', () => {
  for (const key of ['Escape', 'Shift', 'Unidentified']) {
    assert.equal(terminalKey({ ...plain, key }, false), null);
  }
  assert.equal(terminalKey({ ...plain, key: 'r', ctrlKey: true }, false), null);
  assert.equal(terminalKey({ ...plain, key: 'v', ctrlKey: true }, false), null);
  assert.equal(terminalKey({ ...plain, key: 'c', metaKey: true }, false), null);
  assert.equal(terminalKey({ ...plain, key: 'a', isComposing: true }, false), null);
});

await test('paste strips embedded escape/control injection and bounds actual Unicode bytes plus framing', () => {
  assert.equal(terminalPaste('a\r\nb\rc\t日', false), 'a\nb\nc\t日');
  assert.equal(terminalPaste('safe\u{1B}[201~\0\u{9B}', true), '\u{1B}[200~safe[201~\u{1B}[201~');
  assert.equal(terminalPaste('', true), '');
  assert.throws(() => terminalPaste('x'.repeat(16_385), false), RangeError);
  assert.throws(() => terminalPaste('日'.repeat(6000), false), RangeError);
  assert.throws(() => terminalPaste('x'.repeat(16_384), true), RangeError);
  assert.equal(terminalPaste('x'.repeat(16_384), false).length, 16_384);
  assert.equal(terminalPaste('\r\n'.repeat(8193), true), `\u{1B}[200~${'\n'.repeat(8193)}\u{1B}[201~`);
  assert.equal(terminalPaste('\0'.repeat(20_000), true), '');
  assert.throws(() => terminalPaste('\0'.repeat(1_048_577), false), /Raw clipboard/v);
  assert.equal(terminalPaste('a\r\r\nb', false), 'a\n\nb');
});
