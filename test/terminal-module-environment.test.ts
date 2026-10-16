/** @file Bootstrap-only PowerShell isolation cannot change the actual assignment environment. */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { z } from 'zod/v3';

import { runProcess } from '../src/factory/processes.ts';

import { createCleanup, createProject } from './helpers.ts';

const outputSchema = z.object({ module: z.string(), cache: z.string(), cleanup: z.string() });

await test('explicitly empty module variables remain present rather than inheriting helper defaults', async (t) => {
  const mesh = createProject(createCleanup(t));
  const controller = new AbortController();
  const result = await runProcess({
    file: process.execPath,
    args: [
      '-e',
      'console.log(JSON.stringify({module:process.env.PSModulePath,cache:process.env.PSModuleAnalysisCachePath,cleanup:process.env.PSDisableModuleAnalysisCacheCleanup}))',
    ],
    cwd: mesh.root,
    input: '',
    artifact: path.join(mesh.directory, 'empty-module-env'),
    timeoutMs: 15_000,
    signal: controller.signal,
    env: { PSModulePath: '', PSModuleAnalysisCachePath: '', PSDisableModuleAnalysisCacheCleanup: '' },
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(outputSchema.parse(JSON.parse(result.stdout)), { module: '', cache: '', cleanup: '' });
});

await test('owned assignments retain their explicit PowerShell environment outside the helper', async (t) => {
  const mesh = createProject(createCleanup(t));
  const module = path.join(mesh.root, 'custom-modules');
  const cache = path.join(mesh.root, 'custom-analysis-cache');
  const controller = new AbortController();
  const result = await runProcess({
    file: process.execPath,
    args: [
      '-e',
      'console.log(JSON.stringify({module:process.env.PSModulePath,cache:process.env.PSModuleAnalysisCachePath,cleanup:process.env.PSDisableModuleAnalysisCacheCleanup}))',
    ],
    cwd: mesh.root,
    input: '',
    artifact: path.join(mesh.directory, 'module-env'),
    timeoutMs: 15_000,
    signal: controller.signal,
    env: { PSModulePath: module, PSModuleAnalysisCachePath: cache, PSDisableModuleAnalysisCacheCleanup: 'original' },
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(outputSchema.parse(JSON.parse(result.stdout)), { module, cache, cleanup: 'original' });
});

await test(
  'Windows assignment commands can import their configured local PowerShell modules',
  {
    skip: process.platform !== 'win32',
  },
  async (t) => {
    const mesh = createProject(createCleanup(t));
    const modules = path.join(mesh.root, 'modules');
    const directory = path.join(modules, 'MaltFixture');
    const controller = new AbortController();
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Create only this test-owned native module directory.
    mkdirSync(directory, { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- The module contains one fixed fixture function, no downloaded or operator-supplied script.
    writeFileSync(
      path.join(directory, 'MaltFixture.psm1'),
      'function Get-MaltFixtureValue { "module restored" }; Export-ModuleMember -Function Get-MaltFixtureValue',
    );
    const result = await runProcess({
      file: path.join(process.env['SystemRoot'] ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        'Import-Module MaltFixture -ErrorAction Stop; Get-MaltFixtureValue',
      ],
      cwd: mesh.root,
      input: '',
      artifact: path.join(mesh.directory, 'module-import'),
      timeoutMs: 15_000,
      signal: controller.signal,
      env: { PSMODULEPATH: modules },
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'module restored');
  },
);
