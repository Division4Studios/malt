/**
 * Exercise the actual workflow shell against trusted and malicious revisions.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { writeAtomic } from '../src/summary.ts';

import { createCleanup, createProject } from './helpers.ts';

await test('workflow classification executes only the trusted base and fails closed when it is absent', (t) => {
  const mesh = createProject(createCleanup(t));
  const cwd = mesh.root;
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- Git operates only in this owned disposable fixture with fixed commands.
  const git = (...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Read only the checked-in workflow beside this test module.
  const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8').replaceAll(
    '\r\n',
    '\n',
  );
  const script = workflow
    .split('        run: |\n', 2)[1]
    ?.split('\n  documentation:', 1)[0]
    ?.replaceAll(/^ {10}/gmv, '');
  assert.ok(script !== undefined);
  const output = path.join(mesh.directory, 'classification.txt');
  const shell =
    process.platform === 'win32'
      ? path.join(process.env['ProgramFiles'] ?? 'C:/Program Files', 'Git', 'bin', 'bash.exe')
      : 'bash';
  const classify = (baseSha: string, headSha: string): string => {
    writeAtomic(output, '');
    execFileSync(shell, ['-c', script], {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: 'pull_request',
        CI_BASE_SHA: baseSha,
        CI_HEAD_SHA: headSha,
        GITHUB_OUTPUT: output.replaceAll('\\', '/'),
        RUNNER_TEMP: mesh.directory.replaceAll('\\', '/'),
      },
    });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Read only this fixture's fixed workflow-output path.
    return readFileSync(output, 'utf8').trim();
  };
  git('init', '--quiet');
  git('config', 'user.name', 'Trusted classifier fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'core.autocrlf', 'false');
  writeAtomic(path.join(cwd, 'README.md'), 'Baseline\n');
  git('add', '.');
  git('commit', '--quiet', '-m', 'No classifier yet');
  const missing = git('rev-parse', 'HEAD');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Create the fixed scripts directory inside the owned fixture.
  mkdirSync(path.join(cwd, 'scripts'));
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Read only the checked-in classifier beside this test module.
  const classifier = readFileSync(new URL('../scripts/ci-changes.ts', import.meta.url), 'utf8');
  writeAtomic(path.join(cwd, 'scripts', 'ci-changes.ts'), classifier);
  git('add', '.');
  git('commit', '--quiet', '-m', 'Trusted classifier');
  const base = git('rev-parse', 'HEAD');
  writeAtomic(path.join(cwd, 'README.md'), 'Documentation update\n');
  git('add', '.');
  git('commit', '--quiet', '-m', 'Docs only');
  const documentation = git('rev-parse', 'HEAD');
  assert.equal(classify(base, documentation), 'docs_only=true');
  writeAtomic(path.join(cwd, 'scripts', 'ci-changes.ts'), 'process.stdout.write("docs_only=true\\n");\n');
  writeAtomic(path.join(cwd, 'program.ts'), 'export const behavior = 2;\n');
  git('add', '.');
  git('commit', '--quiet', '-m', 'Malicious classifier and source');
  const head = git('rev-parse', 'HEAD');
  assert.equal(classify(base, head), 'docs_only=false');
  assert.equal(classify(missing, head), 'docs_only=false');
  assert.equal(classify('--help', head), 'docs_only=false');
});
