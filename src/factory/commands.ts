/**
 * Shell-free command execution and process-tree termination for managed jobs.
 * Paths and arguments stay separate; Windows npm runs through its Node entry
 * point rather than unsafe cmd.exe string composition.
 *
 * @file
 */

import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

/** Promise-based Node child-process API. */
const executeFile = promisify(execFile);
/** Longest ordinary Git/GitHub operation. */
const COMMAND_TIMEOUT = 120_000;
/** Largest ordinary CLI response. */
const RESPONSE_MAX = 8_388_608;

/** A failed validation or repository command, retaining local diagnostics. */
export class CommandFailureError extends Error {
  /** Exit diagnostics for private job artifacts. */
  public readonly diagnostics: string;

  /**
   * Construct a public error without interpolating command arguments or tokens.
   *
   * @param executable - Command family.
   * @param options - Private error diagnostics.
   */
  public constructor(executable: string, options: ErrorOptions & { diagnostics: string }) {
    super(`The ${path.basename(executable)} command failed. Inspect the project-local attempt diagnostics.`, options);
    this.name = 'CommandFailureError';
    this.diagnostics = options.diagnostics;
  }
}

/**
 * Resolve npm safely on Windows; native executables use normal PATH lookup.
 *
 * @param file - Configured executable.
 * @param args - Literal argument list.
 * @returns An executable and arguments suitable for shell=false.
 */
export function commandInvocation(file: string, args: readonly string[]): { file: string; args: string[] } {
  return process.platform === 'win32' && (file === 'npm' || file === 'npm.cmd')
    ? {
        file: process.execPath,
        args: [path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'), ...args],
      }
    : { file, args: [...args] };
}

/**
 * Execute a bounded command without a shell or interactive window.
 *
 * @param file - Configured executable.
 * @param args - Literal arguments.
 * @param cwd - Owned project or worktree directory.
 * @param shouldTrim - Metadata commands trim whitespace; immutable blob inspection preserves it.
 * @returns Standard output text.
 * @throws {CommandFailureError} On non-zero exit, timeout or launch failure.
 */
export async function command(file: string, args: readonly string[], cwd: string, shouldTrim = true): Promise<string> {
  const invocation = commandInvocation(file, args);
  try {
    const result = await executeFile(invocation.file, invocation.args, {
      cwd,
      windowsHide: true,
      timeout: COMMAND_TIMEOUT,
      maxBuffer: RESPONSE_MAX,
      encoding: 'utf8',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' },
    });
    return shouldTrim ? result.stdout.trim() : result.stdout;
  } catch (error) {
    const diagnostics =
      Error.isError(error) && 'stderr' in error ? String(error.stderr) : 'The executable could not be started.';
    throw new CommandFailureError(file, { diagnostics });
  }
}

/**
 * Terminate a managed executable and its descendants, including shell tools.
 *
 * @param pid - PID obtained from our own ChildProcess, never a user-supplied PID.
 */
export async function terminateTree(pid: number): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return;
  }
  try {
    if (process.platform === 'win32') {
      const executable = path.join(process.env['SystemRoot'] ?? 'C:/Windows', 'System32', 'taskkill.exe');
      await executeFile(executable, ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    /* The process may have exited between the cancellation and kill. */
  }
}
