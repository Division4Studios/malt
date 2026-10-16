/** @file Pure terminal allocation, clipped resize and bounded rendition regressions. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TerminalGrid } from '../web/src/terminal-grid.ts';
import { TerminalParser } from '../web/src/terminal-parser.ts';
import { DEFAULT_TERMINAL_STYLE, terminalStyle } from '../web/src/terminal-style.ts';

await test('grid allocation, scrollback and cursor remain bounded during floods and hostile resize', () => {
  const grid = new TerminalGrid(8, 3);
  grid.move(7, 2);
  for (let index = 0; index < 10_000; index += 1) {
    grid.scroll(0, 2, 1);
  }
  assert.equal(grid.history.length, 500);
  assert.equal(grid.lines.length, 3);
  assert.ok(grid.history.every((row) => row.length === 8));
  grid.resize(2, 1);
  assert.deepEqual(grid.cursor, { x: 1, y: 0 });
  assert.ok(grid.history.every((row) => row.length === 2));
  grid.resize(9999, 9999);
  assert.equal(grid.columns, 500);
  assert.equal(grid.rows, 200);
  assert.equal(grid.lines.length, 200);
  assert.ok(grid.lines.every((row) => row.length === 500));
  grid.resize(NaN, Infinity);
  assert.equal(grid.columns, 1);
  assert.equal(grid.rows, 1);
  grid.dirty.clear();
  grid.move(0, 0);
  assert.deepEqual([...grid.dirty], [0]);
  const alternate = new TerminalGrid(8, 3, false);
  for (let index = 0; index < 600; index += 1) {
    alternate.scroll(0, 2, 1);
  }
  assert.equal(alternate.history.length, 0);
});

await test('SGR colors are numeric/palette values and flags reset independently', () => {
  const styled = terminalStyle(DEFAULT_TERMINAL_STYLE, [1, 2, 3, 4, 7, 8, 9, 31]);
  assert.equal(styled.foreground, '#f27386');
  assert.ok(
    styled.bold &&
      styled.dim &&
      styled.italic &&
      styled.underline &&
      styled.inverse &&
      styled.concealed &&
      styled.strike,
  );
  const resetFlags = terminalStyle(styled, [22, 23, 24, 27, 28, 29]);
  assert.deepEqual(resetFlags, { ...DEFAULT_TERMINAL_STYLE, foreground: '#f27386' });
  assert.deepEqual(terminalStyle(styled, []), DEFAULT_TERMINAL_STYLE);
  assert.equal(terminalStyle(styled, [38, 2, 999, -1, 31, 48, 5, 232]).foreground, 'rgb(255 0 31)');
  assert.equal(terminalStyle(styled, [48, 5, 232]).background, 'rgb(8 8 8)');
  assert.equal(terminalStyle(styled, [38, 5, 21]).foreground, 'rgb(0 0 255)');
  assert.equal(terminalStyle(styled, [97]).foreground, '#ffffff');
  assert.equal(terminalStyle(styled, [39]).foreground, null);
  assert.equal(terminalStyle(styled, [38, 2]).foreground, null);
  assert.deepEqual(terminalStyle(styled, [9999]), styled);
});

await test('colon true-color groups preserve optional color space and following SGR boundaries', () => {
  const parser = new TerminalParser();
  const colors = [
    [38, 2, '', 255, 0, 0],
    [38, 2, 0, 255, 0, 0],
    [38, 2, 255, 0, 0],
  ];
  for (const group of colors) {
    const color = group.join(':');
    const [action] = parser.feed(`\u{1B}[${color};1m`);
    assert.ok(action?.type === 'csi');
    const style = terminalStyle(DEFAULT_TERMINAL_STYLE, action.params, action.subparameters);
    assert.equal(style.foreground, 'rgb(255 0 0)');
    assert.equal(style.bold, true);
  }
  const prior = terminalStyle(DEFAULT_TERMINAL_STYLE, [31, 1]);
  const [unsupported] = parser.feed('\u{1B}[38:2:1:255:0:0;4:3m');
  assert.ok(unsupported?.type === 'csi');
  assert.deepEqual(terminalStyle(prior, unsupported.params, unsupported.subparameters), { ...prior, underline: true });
});
