/** @file Observable VT grid, alternate-screen restoration and bounded Unicode state. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TerminalParser } from '../web/src/terminal-parser.ts';
import { TerminalScreen } from '../web/src/terminal-screen.ts';

/**
 * Feed real parser actions into a pure screen.
 *
 * @param screen - Test display.
 * @param text - Representative native output.
 */
function feed(screen: TerminalScreen, text: string): void {
  const parser = new TerminalParser();
  screen.apply(parser.feed(text));
}

/**
 * Read observable rows without any DOM or snapshot serialization.
 *
 * @param screen - Current display.
 * @returns Visible text, including blanks.
 */
function rows(screen: TerminalScreen): string[] {
  return screen.grid.lines.map((line) => line.map((cell) => cell.text).join(''));
}

await test('native alternate-screen frame restores primary cursor and contents', () => {
  const screen = new TerminalScreen(10, 3);
  feed(screen, 'main\u{1B}[?1049h\u{1B}[2J\u{1B}[1;1Hfixture\u{1B}[2;3Hready');
  assert.deepEqual(rows(screen), ['fixture   ', '  ready   ', ' '.repeat(10)]);
  feed(screen, '\u{1B}[?1049l');
  assert.equal(rows(screen)[0], 'main      ');
  assert.deepEqual(screen.grid.cursor, { x: 4, y: 0 });
  feed(screen, '\u{1B}[?25l\u{1B}[?2004h\u{1B}[?1h');
  assert.equal(screen.isCursorVisible, false);
  assert.equal(screen.isBracketedPaste, true);
  assert.equal(screen.isApplicationCursor, true);
});

await test('cursor addressing, save/restore and erase obey observable boundaries', () => {
  const screen = new TerminalScreen(8, 3);
  feed(screen, 'abcdefgh\u{1B}[2;3HXYZ\u{1B}7\u{1B}[1;2H\u{1B}[K');
  assert.deepEqual(rows(screen), ['a       ', '  XYZ   ', ' '.repeat(8)]);
  feed(screen, '\u{1B}8!\u{1B}[3;8Hend\u{1B}[2J');
  assert.deepEqual(rows(screen), [' '.repeat(8), ' '.repeat(8), ' '.repeat(8)]);
  feed(screen, '\u{1B}[1;1Hone\r\ntwo\u{1B}[1;2H\u{1B}[1J');
  assert.equal(rows(screen)[0], '  e     ');
  assert.equal(rows(screen)[1], 'two     ');
});

await test('wide glyphs, combining floods, unsafe OSC links and clipped resize remain data', () => {
  const screen = new TerminalScreen(4, 2);
  feed(screen, 'A日B');
  assert.deepEqual(
    screen.grid.lines[0]?.map((cell) => cell.width),
    [1, 2, 0, 1],
  );
  feed(screen, 'Z');
  assert.equal(rows(screen)[1], 'Z   ');
  feed(screen, '\u{301}'.repeat(10_000));
  assert.ok((screen.grid.lines[1]?.[0]?.text.length ?? 0) <= 32);
  feed(screen, '\u{1B}]8;;javascript:alert(1)\u{7}x\u{1B}]8;;\u{7}y');
  assert.equal(screen.grid.lines[1]?.[1]?.link, 'javascript:alert(1)');
  assert.equal(screen.grid.lines[1][2]?.link, null);
  screen.resize(1, 1);
  assert.deepEqual(screen.grid.cursor, { x: 0, y: 0 });
  screen.reset();
  assert.equal(rows(screen)[0], ' ');
});

await test('scroll regions and line edits preserve outside rows without creating history', () => {
  const screen = new TerminalScreen(5, 4);
  feed(screen, 'AAAAA\r\nBBBBB\r\nCCCCC\r\nDDDDD\u{1B}[2;3r\u{1B}[3;1H\n');
  assert.deepEqual(rows(screen), ['AAAAA', 'CCCCC', ' '.repeat(5), 'DDDDD']);
  feed(screen, '\u{1B}[2;1H\u{1B}[L');
  assert.deepEqual(rows(screen), ['AAAAA', ' '.repeat(5), 'CCCCC', 'DDDDD']);
  feed(screen, '\u{1B}[M');
  assert.deepEqual(rows(screen), ['AAAAA', 'CCCCC', ' '.repeat(5), 'DDDDD']);
  assert.equal(screen.grid.history.length, 0);
  feed(screen, '\u{1B}[999999S\u{1B}[999999T\u{1B}[4;1H\u{1B}[L');
  assert.equal(rows(screen)[0], 'AAAAA');
  assert.equal(rows(screen)[3], 'DDDDD');
  assert.equal(screen.grid.lines.length, 4);
});

await test('character edits and resize cannot retain orphan wide halves or grow rows', () => {
  const screen = new TerminalScreen(5, 2);
  feed(screen, 'A日B\u{1B}[1;2H\u{1B}[@');
  assert.equal(rows(screen)[0], 'A 日B');
  feed(screen, '\u{1B}[1;3H\u{1B}[P');
  assert.equal(rows(screen)[0], 'A  B ');
  feed(screen, '\u{1B}[999999@\u{1B}[999999P\u{1B}[999999X');
  assert.ok(screen.grid.lines.every((line) => line.length === 5));
  feed(screen, '\u{1B}[1;1H日');
  screen.resize(1, 1);
  assert.equal(screen.grid.lines[0]?.[0]?.width, 1);
  for (let index = 0; index < 2000; index += 1) {
    feed(screen, 'x\r\n');
  }
  assert.equal(screen.grid.history.length, 500);
});
