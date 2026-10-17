/**
 * DOM-free tests of the delivery diff view model. They import the compiled
 * browser module, so `npm run check` builds web first; a bare `npm test`
 * needs `npm run build:web`.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  LARGE_FILE_LINES,
  countText,
  diffRoute,
  fileNotes,
  isLargeFile,
  readDiffPatch,
  readDiffSummary,
  statusText,
  summaryNotes,
  totalsText,
  truncationText,
} from '../web/dist/diff-model.js';

const TASK = '44444444-4444-4444-8444-444444444444';
const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);

/** A broker summary with every change kind. */
const SUMMARY = {
  taskId: TASK,
  state: 'ready',
  base: BASE,
  head: HEAD,
  files: [
    {
      path: 'src/app.ts',
      oldPath: null,
      status: 'modified',
      additions: 12,
      deletions: 3,
      isBinary: false,
      baseMode: '100644',
      headMode: '100755',
      similarity: null,
    },
    {
      path: 'docs/new.md',
      oldPath: 'docs/old.md',
      status: 'renamed',
      additions: 0,
      deletions: 0,
      isBinary: false,
      baseMode: '100644',
      headMode: '100644',
      similarity: 96,
    },
    {
      path: 'logo.png',
      oldPath: null,
      status: 'added',
      additions: null,
      deletions: null,
      isBinary: true,
      baseMode: '000000',
      headMode: '100644',
      similarity: null,
    },
    { path: '', status: 'modified' },
    { path: 'odd.txt', status: 'exploded' },
    'not a record',
  ],
  totals: { files: 1203, additions: 12, deletions: 3 },
  privateChanges: 2,
  isTruncated: true,
};

await test('summaries keep only well-formed files and describe each change', () => {
  const summary = readDiffSummary(SUMMARY);
  assert.ok(summary.state === 'ready');
  assert.deepEqual(
    summary.files.map((file) => file.path),
    ['src/app.ts', 'docs/new.md', 'logo.png'],
  );
  const [modified, renamed, binary] = summary.files;
  assert.ok(modified !== undefined && renamed !== undefined && binary !== undefined);
  assert.equal(statusText(modified), 'Modified');
  assert.equal(statusText(renamed), 'Renamed from docs/old.md (96% similar)');
  assert.equal(statusText(binary), 'Added');
  assert.equal(countText(modified), '+12 −3');
  assert.equal(countText(binary), 'Binary');
  assert.deepEqual(fileNotes(modified), ['Mode 100644 → 100755']);
  assert.deepEqual(fileNotes(binary), ['Binary content; no line diff.']);
  assert.deepEqual(fileNotes(renamed), []);
  assert.equal(totalsText(summary), '1203 files changed · +12 −3');
  assert.deepEqual(summaryNotes(summary), [
    'Showing the first 3 of 1203 changed files.',
    '2 private runtime or credential paths changed and are not shown.',
  ]);
});

await test('unavailable or malformed results become a plain reason', () => {
  assert.deepEqual(readDiffSummary({ taskId: TASK, state: 'unavailable', reason: 'No source yet.' }), {
    state: 'unavailable',
    reason: 'No source yet.',
  });
  assert.deepEqual(readDiffSummary(null), { state: 'unavailable', reason: 'The diff could not be read.' });
  assert.deepEqual(readDiffPatch([]), { state: 'unavailable', reason: 'The diff could not be read.' });
});

await test('patches parse into numbered rows with header notes and truncation', () => {
  const patch = readDiffPatch({
    taskId: TASK,
    state: 'ready',
    base: BASE,
    head: HEAD,
    path: 'src/app.ts',
    patch: [
      'diff --git a/src/app.ts b/src/app.ts',
      'old mode 100644',
      'new mode 100755',
      'index 1111111..2222222',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -1,2 +1,2 @@',
      ' keep',
      '-before',
      '+after',
      '',
    ].join('\n'),
    isTruncated: true,
    bytes: 600_000,
  });
  assert.ok(patch.state === 'ready');
  assert.deepEqual(
    patch.rows.map((row) => [row.kind, row.old, row.new, row.text]),
    [
      ['hunk', '', '', '@@ -1,2 +1,2 @@'],
      ['ctx', '1', '1', 'keep'],
      ['del', '2', '', 'before'],
      ['add', '', '2', 'after'],
    ],
  );
  assert.ok(patch.notes.some((note) => note.includes('100755')));
  assert.equal(truncationText(patch), 'Showing the first part of a 586 KiB patch.');
  const skipped = readDiffPatch({ ...patch, state: 'ready', patch: '', isTruncated: true, bytes: null });
  assert.ok(skipped.state === 'ready');
  assert.match(truncationText(skipped) ?? '', /too much to show/v);
  const complete = readDiffPatch({ state: 'ready', path: 'a', patch: '', isTruncated: false, bytes: 0 });
  assert.ok(complete.state === 'ready');
  assert.equal(truncationText(complete), null);
});

await test('routes carry the project, delivery and an optional path', () => {
  assert.equal(diffRoute('home', TASK), `/api/delivery-diff?project=home&taskId=${TASK}`);
  assert.equal(
    diffRoute('a b', TASK, 'src/a&b.ts'),
    `/api/delivery-diff?project=a+b&taskId=${TASK}&path=src%2Fa%26b.ts`,
  );
  const small = readDiffSummary(SUMMARY);
  assert.ok(small.state === 'ready');
  const [first] = small.files;
  assert.ok(first !== undefined);
  assert.equal(isLargeFile(first), false);
  assert.equal(isLargeFile({ ...first, additions: LARGE_FILE_LINES, deletions: 1 }), true);
});
