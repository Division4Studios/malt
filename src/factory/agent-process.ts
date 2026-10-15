/**
 * Parent-aware wrapper for one managed provider or validation process. IPC
 * disconnect kills the provider tree if the broker crashes, preventing orphan
 * inference from continuing after its durable lease has been recovered.
 *
 * @file
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { z } from 'zod/v3';

import { subscriptionEnvironment } from './authentication.ts';
import { terminateTree } from './commands.ts';
import { FrameDecoder } from './terminal-frames.ts';
import { stopTerminalGroup } from './terminal-groups.ts';
import { terminalEnvironment } from './terminal-launch.ts';

/** Structured launch descriptor; model credentials are inherited, never saved. */
const launchSchema = z.object({
  file: z.string(),
  args: z.array(z.string()),
  cwd: z.string(),
  input: z.string(),
  env: z.record(z.string()).default({}),
  memoryMb: z.number(),
  cpuPercent: z.number(),
  processLimit: z.number().int().positive(),
  interactive: z.boolean().default(false),
});

/** Run the owned process, forwarding streams and watching the parent link. */
async function main(): Promise<void> {
  const file = process.argv[2];
  if (file === undefined || process.send === undefined || !process.connected) {
    throw new Error('This helper must be launched by the factory with an IPC link.');
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Descriptor is created inside the owning job's private artifact directory.
  const launch = launchSchema.parse(JSON.parse(readFileSync(file, 'utf8')));

  const executable =
    process.platform === 'win32'
      ? path.join(process.env['SystemRoot'] ?? 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : launch.file;
  const args =
    process.platform === 'win32'
      ? [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          path.join(import.meta.dirname, 'windows-job.ps1'),
          file,
        ]
      : launch.args;
  const child = spawn(executable, args, {
    cwd: launch.cwd,
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: launch.interactive
      ? terminalEnvironment(process.env)
      : subscriptionEnvironment({ ...process.env, ...launch.env }),
  });
  let cliPid: number | null = null;
  let stopping: Promise<void> | null = null;
  const teardown = async (): Promise<void> => {
    stopping ??= (async (): Promise<void> => {
      if (cliPid !== null && launch.interactive && process.platform !== 'win32') {
        await stopTerminalGroup(cliPid);
      }
      if (child.pid !== undefined) {
        await terminateTree(child.pid);
      }
    })();
    await stopping;
  };
  const stop = (): void => {
    void teardown();
  };
  process.once('disconnect', stop);
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  child.stdin.on('error', () => {
    /* Exit status is reported through the completion promise. */
  });
  if (launch.interactive) {
    const decoder = new FrameDecoder();
    child.stdout.on('data', (bytes: Uint8Array) => {
      try {
        for (const frame of decoder.push(bytes)) {
          if (frame.type === 'started') {
            cliPid = frame.pid;
          }
        }
      } catch {
        stop();
      }
    });
    process.stdin.pipe(child.stdin);
  } else {
    child.stdin.end(launch.input);
  }
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code: number | null) => {
      process.exitCode = typeof code === 'number' ? code : 1;
      resolve();
    });
  });
  if (launch.interactive) {
    await teardown();
    process.stdin.unpipe(child.stdin);
    process.stdin.destroy();
    process.stdin.unref();
  } else if (process.platform !== 'win32' && child.pid !== undefined) {
    await terminateTree(child.pid);
  }
  process.removeListener('disconnect', stop);
  process.removeListener('SIGTERM', stop);
  process.removeListener('SIGINT', stop);
  disconnectOwned();
}

/** Detach only this owned helper's IPC after its provider has fully stopped. */
function disconnectOwned(): void {
  if (process.connected) {
    process.disconnect();
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${Error.isError(error) ? error.message : 'Managed process failed.'}\n`);
  process.exitCode = 1;
}
