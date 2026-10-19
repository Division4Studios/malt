/**
 * Bare executable names resolve only through absolute PATH directories, so a
 * same-named file in a project working directory is never launched instead.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { trustedExecutable } from '../src/executables.ts';

await test('bare names resolve only through absolute PATH directories', (t) => {
  assert.equal(trustedExecutable('C:/tools/gh.exe'), 'C:/tools/gh.exe', 'a path is launched as given');
  assert.equal(trustedExecutable('./gh'), './gh');
  if (process.platform !== 'win32') {
    assert.equal(trustedExecutable('malt-fixture-tool'), 'malt-fixture-tool', 'other platforms never search the cwd');
    return;
  }
  const installed = mkdtempSync(path.join(tmpdir(), 'malt-exe-'));
  const workspace = mkdtempSync(path.join(tmpdir(), 'malt-workspace-'));
  const savedPath = process.env['PATH'];
  const savedCwd = process.cwd();
  t.after(() => {
    process.env['PATH'] = savedPath;
    process.chdir(savedCwd);
    rmSync(installed, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });
  const name = `malt-fixture-${String(process.pid)}`;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Writes only inside the test's own temporary directories.
  writeFileSync(path.join(workspace, `${name}.exe`), '');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Writes only inside the test's own temporary directories.
  writeFileSync(path.join(installed, `${name}.exe`), '');
  process.chdir(workspace);
  process.env['PATH'] = ['.', 'relative-bin', installed].join(path.delimiter);
  assert.equal(trustedExecutable(name), path.join(installed, `${name}.exe`), 'the workspace copy is never chosen');
});
