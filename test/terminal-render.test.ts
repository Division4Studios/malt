/** @file Literal text/link policy and dirty-row frame budgets without DOM dependencies. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BLANK_CELL } from '../web/src/terminal-grid.ts';
import { TerminalParser } from '../web/src/terminal-parser.ts';
import { nextTerminalRow, TerminalRenderer, terminalLink, terminalRuns } from '../web/src/terminal-render-model.ts';
import { TerminalScreen } from '../web/src/terminal-screen.ts';

import type { TerminalCell } from '../web/src/terminal-grid.ts';

await test('out-of-order dirty rows retain numeric DOM insertion order', () => {
  const mounted: number[] = [];
  for (const index of [9, 7, 0, 4, 11, 1]) {
    const next = nextTerminalRow(mounted, index);
    mounted.splice(next === null ? mounted.length : mounted.indexOf(next), 0, index);
  }
  assert.deepEqual(mounted, [0, 1, 4, 7, 9, 11]);
});

await test('terminal targets accept only absolute HTTP(S) without controls or userinfo', () => {
  for (const target of [
    null,
    'javascript:alert(1)',
    'data:text/html,<script>x</script>',
    'file:///private',
    'blob:https://example.com/id',
    '//example.com',
    'https://user:secret@example.com',
    'https:\n//example.com',
  ]) {
    assert.equal(terminalLink(target), null, target ?? 'absent');
  }
  assert.equal(terminalLink('https://github.com/Division4Studios/malt'), 'https://github.com/Division4Studios/malt');
  assert.equal(terminalLink('http://127.0.0.1:4318/'), 'http://127.0.0.1:4318/');
});

await test('HTML remains literal run text and cursor/wide cells retain separate boundaries', () => {
  const html = '<img src=x onerror=alert(1)><script>bad()</script>';
  const cells: TerminalCell[] = Array.from(html, (text) => ({ ...BLANK_CELL, text, link: 'javascript:alert(1)' }));
  const runs = terminalRuns(cells, -1);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.text, html);
  assert.equal(terminalLink(runs[0].link), null);
  assert.equal(terminalRuns(cells, 2).length, 3);
  const screen = new TerminalScreen(6, 2);
  const parser = new TerminalParser();
  screen.apply(parser.feed('A日B'));
  const wide = terminalRuns(screen.grid.lines[0] ?? [], -1);
  assert.equal(wide.map((run) => run.text).join(''), 'A日B  ');
  assert.equal(wide.filter((run) => run.isWide).length, 1);
});

await test('renderer updates dirty rows only and bounds one frame to eight rows', () => {
  const changed: number[] = [];
  const summaries: string[] = [];
  const renderer = new TerminalRenderer({
    row(index) {
      changed.push(index);
    },
    trim() {
      /* Native DOM row retirement is checked by browser integration. */
    },
    announce(message) {
      summaries.push(message);
    },
  });
  const screen = new TerminalScreen(10, 12);
  assert.equal(renderer.render(screen), true);
  assert.equal(changed.length, 8);
  assert.equal(renderer.render(screen), false);
  assert.equal(changed.length, 12);
  renderer.render(screen);
  assert.equal(changed.length, 12);
  const parser = new TerminalParser();
  screen.apply(parser.feed('x'));
  renderer.render(screen);
  assert.deepEqual(changed.slice(12), [0]);
  assert.match(summaries.at(-1) ?? '', /row 1, column 2/v);
  screen.resize(4, 1);
  assert.equal(renderer.render(screen), false);
  assert.equal(changed.at(-1), 0);
});
