/** @file Real native PTY keystrokes and resize without inference or a shell. */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { terminateTree } from '../src/factory/commands.ts';
import { encodeFrame, FrameDecoder } from '../src/factory/terminal-frames.ts';
import { terminalArguments, terminalEnvironment, terminalLaunchSchema } from '../src/factory/terminal-launch.ts';

import { createCleanup, createProject, until } from './helpers.ts';

import type { Frame } from '../src/factory/terminal-frames.ts';

const HOST = path.resolve('src/factory/terminal-host.ts');
const descriptor = { provider: 'codex' as const, file: 'codex', cwd: process.cwd(), columns: 80, rows: 24 };

await test('terminal launch rejects arguments/env/shell executables and strips credential inheritance', () => {
  assert.throws(() => terminalLaunchSchema.parse({ ...descriptor, file: 'powershell.exe' }));
  assert.throws(() => terminalLaunchSchema.parse({ ...descriptor, args: ['; rm -rf /'] }));
  assert.throws(() => terminalLaunchSchema.parse({ ...descriptor, env: { OPENAI_API_KEY: 'secret' } }));
  assert.throws(() => terminalLaunchSchema.parse({ ...descriptor, file: 'codex.cmd' }));
  const env = terminalEnvironment({
    PATH: 'safe-path',
    HOME: 'safe-home',
    OPENAI_API_KEY: 'bad',
    GH_TOKEN: 'bad',
    AGENTMESH_TOKEN: 'bad',
    CLAUDE_CODE_SKIP_PROMPT_HISTORY: '0',
  });
  assert.equal(env['PATH'], 'safe-path');
  assert.equal(env['CLAUDE_CODE_SKIP_PROMPT_HISTORY'], '1');
  assert.equal(env['OPENAI_API_KEY'], undefined);
  assert.equal(env['GH_TOKEN'], undefined);
  assert.equal(env['AGENTMESH_TOKEN'], undefined);
  assert.deepEqual(terminalArguments({ ...descriptor, provider: 'claude', file: 'claude' }), [
    '--restricted',
    '--strict-mcp-config',
    '--permission-mode',
    'manual',
  ]);
  assert.ok(terminalArguments(descriptor).includes('forced_login_method="chatgpt"'));
});

await test('isolated host uses a real PTY for fixture keystrokes and native resize', { timeout: 15_000 }, async (t) => {
  const defer = createCleanup(t);
  const project = createProject(defer);
  const file = path.join(project.root, 'launch.json');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Test-owned temporary project receives only fixed metadata.
  writeFileSync(file, JSON.stringify(descriptor));
  const child = spawn(process.execPath, [HOST, file, '--fixture'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  defer(async () => {
    if (child.pid !== undefined) {
      return terminateTree(child.pid);
    }
  });
  const ended = once(child, 'exit');
  const frames: Frame[] = [];
  const decoder = new FrameDecoder();
  let text = '';
  let diagnostics = '';
  child.stderr.on('data', (data: Buffer) => {
    diagnostics += data.toString();
  });
  child.stdout.on('data', (data: Buffer) => {
    for (const frame of decoder.push(data)) {
      frames.push(frame);
      if (frame.type === 'data') {
        text += Buffer.from(frame.data).toString();
      }
    }
  });
  await until(() => text.includes('SIZE 80 24') || frames.some((frame) => frame.type === 'error'), 10_000);
  assert.ok(text.includes('SIZE 80 24'), JSON.stringify({ frames, diagnostics }));
  assert.equal(frames[0]?.type, 'started');
  child.stdin.write(encodeFrame({ type: 'input', data: Buffer.from('hello\r') }));
  await until(() => text.includes('ECHO "hello"'));
  child.stdin.write(encodeFrame({ type: 'resize', columns: 120, rows: 40 }));
  child.stdin.write(encodeFrame({ type: 'input', data: Buffer.from('size\r') }));
  await until(() => text.includes('SIZE 120 40'));
  child.stdin.write(encodeFrame({ type: 'input', data: Buffer.from('quit\r') }));
  try {
    await until(() => frames.some((frame) => frame.type === 'exit'));
  } catch {
    assert.fail(JSON.stringify({ text, types: frames.map((frame) => frame.type) }));
  }
  await ended;
  assert.ok(frames.some((frame) => frame.type === 'exit' && frame.code === 0));
  assert.equal(diagnostics, '');
});

await test('unavailable native addon returns a typed error without spawning a PTY', async (t) => {
  const defer = createCleanup(t);
  const project = createProject(defer);
  const file = path.join(project.root, 'launch.json');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixed metadata file inside the test-owned temporary project.
  writeFileSync(file, JSON.stringify(descriptor));
  const preload = pathToFileURL(path.resolve('test/fixtures/terminal-no-addon.ts')).href;
  const child = spawn(process.execPath, ['--import', preload, HOST, file, '--fixture'], { windowsHide: true });
  defer(async () => {
    if (child.pid !== undefined) {
      return terminateTree(child.pid);
    }
  });
  const decoder = new FrameDecoder();
  const frames: Frame[] = [];
  child.stdout.on('data', (data: Buffer) => {
    frames.push(...decoder.push(data));
  });
  await once(child, 'exit');
  assert.equal(child.exitCode, 1);
  assert.deepEqual(frames, [
    { type: 'error', code: 'unsupported_platform', message: 'Native terminal support is unavailable.' },
  ]);
});
