/**
 * Real managed process and Windows descendant lifecycle verification.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { z } from 'zod';

import { runProcess } from '../src/factory/processes.ts';

/** Native process fixture artifacts live outside the source repository. */
const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'mlt-process-test-'));
/** Successful subprocess deadline. */
const DEADLINE_MS = 15_000;
/** Give process handles time to close before inspecting descendants. */
const EXIT_GRACE_MS = 500;
/** Owned process identifiers must be validated before liveness inspection. */
const processIdsSchema = z.array(z.number().int().positive());

await test('managed native invocation preserves literal argv, stdin and exit status', async () => {
  const script = path.join(fixtureRoot, 'argv.mjs');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Write only the fixed executable fixture within the disposable process directory.
  writeFileSync(
    script,
    'let input=""; for await (const chunk of process.stdin) input+=chunk; console.log(JSON.stringify({args:process.argv.slice(2),input}));',
  );
  const args = ['a b', 'quote"literal', 'trailing\\', '$(must-not-execute)', ''];
  const controller = new AbortController();
  const result = await runProcess({
    file: process.execPath,
    args: [script, ...args],
    cwd: fixtureRoot,
    input: 'durable assignment',
    artifact: path.join(fixtureRoot, 'argv'),
    timeoutMs: DEADLINE_MS,
    memoryMb: 512,
    cpuPercent: 50,
    signal: controller.signal,
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.interrupted, false);
  assert.deepEqual(JSON.parse(result.stdout), { args, input: 'durable assignment' });
});

await test('cancellation terminates the managed provider and its child process', async () => {
  const marker = path.join(fixtureRoot, 'descendants.json');
  const script = path.join(fixtureRoot, 'parent.mjs');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- The fixed parent fixture launches only its own child for cancellation verification.
  writeFileSync(
    script,
    'import {spawn} from "node:child_process"; import {writeFileSync} from "node:fs"; const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"}); writeFileSync(process.argv[2],JSON.stringify([process.pid,child.pid])); setInterval(()=>{},1000);',
  );
  const controller = new AbortController();
  const running = runProcess({
    file: process.execPath,
    args: [script, marker],
    cwd: fixtureRoot,
    input: '',
    artifact: path.join(fixtureRoot, 'cancel'),
    timeoutMs: DEADLINE_MS,
    memoryMb: 512,
    cpuPercent: 50,
    signal: controller.signal,
  });
  let pids: number[] = [];
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Read only the owned fixture marker; validate identifiers before checking liveness.
      pids = processIdsSchema.parse(JSON.parse(readFileSync(marker, 'utf8')));
      break;
    } catch {
      await delay(100);
    }
  }
  assert.equal(pids.length, 2, 'fixture must launch the provider and descendant before cancellation');
  controller.abort();
  const result = await running;
  assert.equal(result.interrupted, true);
  await delay(EXIT_GRACE_MS);
  for (const pid of pids) {
    assert.throws(() => process.kill(pid, 0), `Managed descendant ${String(pid)} survived cancellation.`);
  }
});

await test('captured native output redacts split project credentials before files and completion are returned', async () => {
  const secret = 'fixture-project-credential-0123456789abcdef';
  const script = path.join(fixtureRoot, 'redaction.mjs');
  const artifact = path.join(fixtureRoot, 'redaction');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Write the fixed owned subprocess fixture, with a deliberately fake credential.
  writeFileSync(
    script,
    'const value=process.argv[2]; process.stdout.write("before "+value.slice(0,12)); setTimeout(()=>{process.stdout.write(value.slice(12)+" after");process.stderr.write(value)},20);',
  );
  const controller = new AbortController();
  const result = await runProcess({
    file: process.execPath,
    args: [script, secret],
    cwd: fixtureRoot,
    input: '',
    artifact,
    secrets: [secret],
    timeoutMs: DEADLINE_MS,
    signal: controller.signal,
    memoryMb: 512,
    cpuPercent: 50,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'before [REDACTED] after');
  assert.equal(result.stderr, '[REDACTED]');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Immediately inspect the flushed owned log to ensure completion never races artifact persistence.
  assert.equal(readFileSync(path.join(artifact, 'stdout.log'), 'utf8'), result.stdout);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- This fixed error log must contain only the redacted fixture credential.
  assert.equal(readFileSync(path.join(artifact, 'stderr.log'), 'utf8'), result.stderr);
});

await test(
  'Windows Job Object bounds native descendants and retires every admitted child',
  { skip: process.platform !== 'win32' },
  async () => {
    const script = path.join(fixtureRoot, 'process-cap.mjs');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- The isolated fixture attempts bounded owned child starts to prove the kernel ceiling.
    writeFileSync(
      script,
      'import {spawn} from "node:child_process";const pids=[];let settled=0;for(let i=0;i<8;i++){try{const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});child.once("spawn",()=>{pids.push(child.pid);finish()});child.once("error",finish)}catch{finish()}}function finish(){if(++settled===8){console.log(JSON.stringify(pids));setTimeout(()=>process.exit(0),50)}}',
    );
    const controller = new AbortController();
    const result = await runProcess({
      file: process.execPath,
      args: [script],
      cwd: fixtureRoot,
      input: '',
      artifact: path.join(fixtureRoot, 'process-cap'),
      timeoutMs: DEADLINE_MS,
      memoryMb: 512,
      cpuPercent: 50,
      processLimit: 3,
      signal: controller.signal,
    });
    assert.equal(result.exitCode, 0, result.stderr);
    const admitted = processIdsSchema.parse(JSON.parse(result.stdout));
    assert.ok(admitted.length > 0);
    assert.ok(
      admitted.length <= 2,
      'The native parent plus admitted descendants must stay within the hard process count.',
    );
    await delay(EXIT_GRACE_MS);
    for (const pid of admitted) {
      assert.throws(() => process.kill(pid, 0), 'Closing the Job Object must retire every owned child.');
    }
  },
);
