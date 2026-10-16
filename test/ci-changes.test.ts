/**
 * CI selection must never hide executable changes behind documentation edits.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { isDocumentationDiff, isDocumentationOnly } from '../scripts/ci-changes.ts';

await test('only human-facing Markdown qualifies; instructions and mixed changes run all checks', () => {
  assert.equal(isDocumentationOnly(['README.md', 'docs/wiki/Home.md', 'docs/a guide.md']), true);
  assert.equal(isDocumentationOnly(['SPONSORING.md']), true);
  for (const file of [
    'src/README.md',
    'AGENTS.md',
    'CLAUDE.md',
    'prompt.md',
    'docs/AGENTS.md',
    'docs/examples/SKILL.md',
    'resources/factory-skills/shared/SKILL.md',
    '.github/workflows/ci.yml',
    '.github/copilot-instructions.md',
    '.github/DISCUSSION_TEMPLATE/ideas.yml',
    'package-lock.json',
    'web/app.ts',
    'docs/image.svg',
    'docs/../src/code.md',
    'docs/a\nb.md',
  ]) {
    assert.equal(isDocumentationOnly(['README.md', file]), false, file);
  }
  assert.equal(isDocumentationOnly([]), false);
});

await test('real Git diffs include rename sources, deletes and every file; failures use full CI', () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'malt-ci-'));
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- Operator-installed Git runs only against this disposable fixture without a shell.
  const git = (...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  try {
    git('init', '--quiet');
    git('config', 'user.name', 'CI fixture');
    git('config', 'user.email', 'ci@example.invalid');
    git('config', 'core.autocrlf', 'false');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixed child of this test's freshly created temporary root.
    mkdirSync(path.join(cwd, 'docs'));
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixed fixture file inside the owned temporary repository.
    writeFileSync(path.join(cwd, 'README.md'), 'initial\n');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixed fixture file inside the owned temporary repository.
    writeFileSync(path.join(cwd, 'program.ts'), 'export const example = 1;\n');
    git('add', '.');
    git('commit', '--quiet', '-m', 'base');
    const base = git('rev-parse', 'HEAD');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixed fixture file inside the owned temporary repository.
    writeFileSync(path.join(cwd, 'README.md'), 'updated\n');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixed fixture file inside the owned temporary repository.
    writeFileSync(path.join(cwd, 'docs', 'a guide.md'), 'guide\n');
    git('add', '.');
    git('commit', '--quiet', '-m', 'docs');
    const head = git('rev-parse', 'HEAD');
    for (const event of ['pull_request', 'push', 'merge_group']) {
      assert.equal(isDocumentationDiff(event, base, head, cwd), true, event);
    }
    assert.equal(isDocumentationDiff('workflow_dispatch', base, head, cwd), false);
    assert.equal(isDocumentationDiff('push', '0'.repeat(40), head, cwd), false);
    assert.equal(isDocumentationDiff('push', base, '--help', cwd), false);
    assert.equal(isDocumentationDiff('push', base, 'f'.repeat(40), cwd), false);
    assert.equal(isDocumentationDiff('push', base, base, cwd), false);
    rmSync(path.join(cwd, 'docs', 'a guide.md'));
    git('add', '.');
    git('commit', '--quiet', '-m', 'remove guide');
    assert.equal(isDocumentationDiff('push', head, git('rev-parse', 'HEAD'), cwd), true);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Both rename paths are fixed files in this owned fixture repository.
    renameSync(path.join(cwd, 'program.ts'), path.join(cwd, 'docs', 'program.md'));
    git('add', '.');
    git('commit', '--quiet', '-m', 'rename source into docs');
    assert.equal(isDocumentationDiff('pull_request', base, git('rev-parse', 'HEAD'), cwd), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
