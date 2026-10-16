/**
 * Parent-aware wrapper for one managed provider or validation process. IPC
 * disconnect kills the provider tree if the broker crashes, preventing orphan
 * inference from continuing after its durable lease has been recovered.
 *
 * @file
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { terminateTree } from './commands.ts';
import { ownedLaunchSchema, prepareOwnedInput, ownedInvocation, ownedEnvironment } from './owned-launch.ts';
import { FrameDecoder } from './terminal-frames.ts';
import { stopTerminalGroup } from './terminal-groups.ts';
import { createTerminalInput } from './terminal-input.ts';

import type { TerminalInput } from './terminal-input.ts';

/** Run the owned process, forwarding streams and watching the parent link. */
async function main(): Promise<void> {
  const file = process.argv[2];
  if (file === undefined || process.send === undefined || !hasOwner()) {
    throw new Error('This helper must be launched by the factory with an IPC link.');
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Descriptor is created inside the owning job's private artifact directory.
  const launch = ownedLaunchSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  const checkpoint = (stage: string, helperPid?: number): void => {
    if (!launch.interactive) {
      return;
    }
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixed numeric/category-only startup metadata inside this owned process artifact directory.
    writeFileSync(
      path.join(path.dirname(file), 'wrapper-status.json'),
      JSON.stringify({ stage, at: Date.now(), helperPid }),
      {
        mode: 0o600,
      },
    );
  };
  checkpoint('preparing-input');
  const cancellation = path.join(path.dirname(file), `cancel-${randomUUID()}`);
  // The OS closes this server endpoint even if this wrapper is forcibly terminated.
  const owner = process.platform === 'win32' ? await createTerminalInput(new PassThrough()) : null;
  const channels: { input: TerminalInput | null } = { input: null };
  const runOwned = async (): Promise<void> => {
    const { descriptor: jobFile, pipe: inputPipe } = await prepareOwnedInput(file, launch);
    channels.input = inputPipe;
    checkpoint('input-ready');
    if (!hasOwner()) {
      throw new Error('Factory owner disconnected before native startup.');
    }
    const invocation = ownedInvocation(jobFile, launch, cancellation, owner?.name ?? '');
    const child = spawn(invocation.file, invocation.args, {
      cwd: launch.cwd,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: ownedEnvironment(launch),
    });
    checkpoint('native-spawn-requested', child.pid);
    const completed = new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code: number | null) => {
        process.exitCode = typeof code === 'number' ? code : 1;
        resolve();
      });
    });
    let cliPid: number | null = null;
    let stopping: Promise<void> | null = null;
    const teardown = async (): Promise<void> => {
      stopping ??= (async (): Promise<void> => {
        if (process.platform === 'win32') {
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- Unique private control marker belongs only to this owned Job helper.
          writeFileSync(cancellation, 'stop', { mode: 0o600 });
          await completed;
          return;
        }
        if (cliPid !== null && launch.interactive) {
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
      if (inputPipe === null) {
        process.stdin.pipe(child.stdin);
      } else {
        child.stdin.end();
      }
    } else {
      child.stdin.end(launch.input);
    }
    await completed;
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
  };
  try {
    await runOwned();
  } finally {
    await channels.input?.close();
    await owner?.close();
    await rm(cancellation, { force: true });
    disconnectOwned();
  }
}

/**
 * Read ownership afresh after asynchronous setup rather than preserving static narrowing.
 *
 * @returns Current parent IPC connection state.
 */
function hasOwner(): boolean {
  return process.connected;
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
