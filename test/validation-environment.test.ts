/**
 * Real owned validation subprocesses retain isolated cache/temp semantics.
 *
 * @file
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import { runProcess } from '../src/factory/processes.ts';
import { validationEnvironment } from '../src/factory/validation-environment.ts';

import { createCleanup, createProject } from './helpers.ts';

await test('validation overrides are project-local and do not mutate the provider environment', async (t) => {
  const config = createProject(createCleanup(t));
  const before = { ...process.env };
  const env = validationEnvironment(config.directory);
  const temporary = path.join(config.directory, 'cache', 'validation-tmp');
  const expected = process.platform === 'win32' ? null : temporary;
  const script = String.raw`
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const cp = require('node:child_process');
    const expected = process.argv[1];
    if (expected !== 'native') {
      assert.equal(os.tmpdir(), expected);
      assert.equal(fs.statSync(expected).mode & 0o777, 0o700);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-'));
      try {
        const file = path.join(dir, 'check.sh');
        fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', {mode: 0o700});
        cp.execFileSync(file);
      } finally { fs.rmSync(dir, {recursive: true, force: true}); }
    }
    assert.equal(process.env.GIT_TERMINAL_PROMPT, '0');
    assert.equal(process.env.GH_PROMPT_DISABLED, '1');
    assert.equal(process.env.NPM_CONFIG_CACHE, process.argv[2]);
  `;
  const controller = new AbortController();
  const result = await runProcess({
    file: process.execPath,
    args: ['-e', script, expected ?? 'native', path.join(config.directory, 'cache', 'npm')],
    cwd: config.directory,
    input: '',
    artifact: path.join(config.directory, 'checks', 'environment'),
    timeoutMs: 30_000,
    signal: controller.signal,
    env,
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.interrupted, false);
  assert.equal(env['TMPDIR'], expected ?? undefined);
  assert.equal(env['TEMP'], undefined);
  assert.equal(env['TMP'], undefined);
  assert.equal(env['NODE_ENV'], undefined);
  assert.ok(JSON.stringify({ ...process.env }) === JSON.stringify(before), 'Parent environment stays unchanged.');
});
