/**
 * Local pull request diffs identify every changed file, including changes Git describes without a hunk.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { gitPath, parseDiff } from '../web/src/diff-parse.ts';

/** Real `git diff -M` output covering hunkless, quoted and delimiter-containing paths. */
const DIFF = [
  'diff --git a/bin.dat b/bin.dat',
  'index bdc955b..8835708 100644',
  'Binary files a/bin.dat and b/bin.dat differ',
  String.raw`diff --git "a/caf\303\251.txt" "b/caf\303\251.txt"`,
  'index b68fde2..ad2705a 100644',
  String.raw`--- "a/caf\303\251.txt"`,
  String.raw`+++ "b/caf\303\251.txt"`,
  '@@ -1 +1,2 @@',
  ' k',
  '+k2',
  'diff --git a/foo b/bar b/foo b/bar',
  'index 5626abf..814f4a4 100644',
  '--- a/foo b/bar\t',
  '+++ b/foo b/bar\t',
  '@@ -1 +1,2 @@',
  ' one',
  '+two',
  'diff --git a/old.txt b/new.txt',
  'similarity index 100%',
  'rename from old.txt',
  'rename to new.txt',
  'diff --git a/script.sh b/script.sh',
  'old mode 100644',
  'new mode 100755',
  'diff --git a/with space.txt b/with space.txt',
  'index f05367e..c2ae087 100644',
  '--- a/with space.txt\t',
  '+++ b/with space.txt\t',
  '@@ -1 +1,2 @@',
  ' sp',
  '+sp2',
  'diff --git a/gone.txt b/gone.txt',
  'deleted file mode 100644',
  'index 1111111..0000000',
  '--- a/gone.txt',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-bye',
].join('\n');

await test('diff parsing keeps hunkless changes and resolves Git-quoted and delimiter-containing paths', () => {
  const files = parseDiff(DIFF);
  assert.deepEqual(
    files.map((file) => file.path),
    ['bin.dat', 'café.txt', 'foo b/bar', 'old.txt → new.txt', 'script.sh', 'with space.txt', 'gone.txt'],
  );
  const [binary, quoted, delimited, renamed, mode, spaced, deleted] = files;
  assert.deepEqual(binary?.notes, ['Binary files a/bin.dat and b/bin.dat differ'], 'A binary change is visible.');
  assert.equal(binary.rows.length, 0);
  assert.deepEqual(renamed?.notes, ['similarity index 100%', 'rename from old.txt', 'rename to new.txt']);
  assert.deepEqual(mode?.notes, ['old mode 100644', 'new mode 100755'], 'An executable bit change is visible.');
  assert.deepEqual([quoted?.added, quoted?.removed, delimited?.added, spaced?.added], [1, 0, 1, 1]);
  assert.deepEqual(
    delimited?.rows.map((row) => [row.kind, row.old, row.new, row.text]),
    [
      ['hunk', '', '', '@@ -1 +1,2 @@'],
      ['ctx', '1', '1', 'one'],
      ['add', '', '2', 'two'],
    ],
  );
  assert.deepEqual([deleted?.removed, deleted?.notes], [1, ['deleted file mode 100644']]);
});

await test('Git path decoding handles octal, single-character escapes and unquoted paths', () => {
  assert.equal(gitPath(String.raw`"a/caf\303\251.txt"`), 'a/café.txt');
  assert.equal(gitPath(String.raw`"a/tab\there\"q\"\\"`), 'a/tab\there"q"\\');
  assert.equal(gitPath('a/plain path'), 'a/plain path');
});

await test('a quoted header path keeps an escaped quote followed by a space', () => {
  const [mode] = parseDiff(
    [String.raw`diff --git "a/a\" b.txt" "b/a\" b.txt"`, 'old mode 100644', 'new mode 100755'].join('\n'),
  );
  assert.equal(mode?.path, 'a" b.txt');
  assert.deepEqual(mode.notes, ['old mode 100644', 'new mode 100755']);
});
