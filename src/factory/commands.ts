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

import { trustedExecutable } from '../executables.ts';

import { credentialValues } from './authentication.ts';
import { redactLog } from './ci-logs.ts';

/** Promise-based Node child-process API. */
const executeFile = promisify(execFile);
/** Longest ordinary Git/GitHub operation. */
const COMMAND_TIMEOUT = 120_000;
/** Largest ordinary CLI response. */
const RESPONSE_MAX = 8_388_608;
/** Milliseconds per second, for messages. */
const MS_PER_SECOND = 1000;

/** Longest stderr tail kept for a failed command, in characters. */
const STDERR_TAIL = 4000;

/** What a failed command was and how it ended; safe to persist privately. */
export interface CommandDiagnostics {
  /** Executable name without its directory, such as `git` or `gh`. */
  readonly family: string;
  /** First non-option argument, such as `push`; null when the command had none. */
  readonly subcommand: string | null;
  /** Exit code, or null when the process timed out, was killed or never started. */
  readonly exitCode: number | null;
  /** Whether the bounded timeout stopped it. */
  readonly isTimeout: boolean;
  /** Whether the executable could not be started at all. */
  readonly isLaunchFailure: boolean;
  /** Redacted, bounded end of its standard error. */
  readonly stderrTail: string;
}

/** A failed validation or repository command, retaining local diagnostics. */
export class CommandFailureError extends Error {
  /** Redacted stderr tail for private job artifacts. */
  public readonly diagnostics: string;
  /** Structured command identity and outcome. */
  public readonly command: CommandDiagnostics;

  /**
   * Construct a public error naming the command family and subcommand, never its other arguments or tokens.
   *
   * @param failed - Structured, already redacted diagnostics.
   * @param options - Error cause.
   */
  public constructor(failed: CommandDiagnostics, options?: ErrorOptions) {
    super(`The ${commandLabel(failed)} command ${commandOutcome(failed)}. Inspect the job's failure record.`, options);
    this.name = 'CommandFailureError';
    this.command = failed;
    this.diagnostics = failed.stderrTail;
  }
}

/**
 * The command's family and subcommand, as shown in messages.
 *
 * @param failed - Diagnostics of the command that did not succeed.
 * @returns For example `git push`.
 */
export function commandLabel(failed: Pick<CommandDiagnostics, 'family' | 'subcommand'>): string {
  return failed.subcommand === null ? failed.family : `${failed.family} ${failed.subcommand}`;
}

/**
 * How a failed command ended, in words.
 *
 * @param failed - Diagnostics of the command that did not succeed.
 * @returns For example `failed with exit code 128` or `timed out`.
 */
function commandOutcome(failed: CommandDiagnostics): string {
  if (failed.isLaunchFailure) {
    return 'could not be started';
  }
  if (failed.isTimeout) {
    return `timed out after ${String(COMMAND_TIMEOUT / MS_PER_SECOND)} s`;
  }
  return failed.exitCode === null ? 'was stopped' : `failed with exit code ${String(failed.exitCode)}`;
}

/** Options whose next argument is a value, not a subcommand. */
const VALUE_OPTIONS: ReadonlySet<string> = new Set(['-C', '-c', '--git-dir', '--work-tree', '-R', '--repo']);
/** What a subcommand name looks like; anything else is free text and is not recorded. */
const SUBCOMMAND = /^[a-z][\w\-]{0,39}$/v;

/**
 * The first plain word of an invocation, such as `push` in `git -C repo push origin`.
 *
 * @param args - Literal arguments.
 * @returns Subcommand name, or null when the first non-option argument is not a plain word.
 */
function subcommandOf(args: readonly string[]): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? '';
    if (VALUE_OPTIONS.has(argument)) {
      index += 1;
    } else if (!argument.startsWith('-')) {
      return SUBCOMMAND.test(argument) ? argument : null;
    }
  }
  return null;
}

/**
 * Structured diagnostics for a failed child process.
 *
 * @param file - Configured executable.
 * @param args - Literal arguments; only the first non-option one is kept.
 * @param error - Rejection from `execFile`.
 * @returns Redacted, bounded diagnostics.
 */
export function commandDiagnostics(file: string, args: readonly string[], error: unknown): CommandDiagnostics {
  const failure = (typeof error === 'object' && error !== null ? error : {}) as {
    code?: unknown;
    killed?: unknown;
    signal?: unknown;
    stderr?: unknown;
  };
  // String codes are launch errors (ENOENT, EACCES); an exceeded output buffer means the process did run.
  const isLaunchFailure = typeof failure.code === 'string' && failure.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
  const stderr = typeof failure.stderr === 'string' ? failure.stderr : '';
  return {
    family: path.basename(file).replace(/\.(?:cmd|exe)$/iv, ''),
    subcommand: subcommandOf(args),
    exitCode: typeof failure.code === 'number' ? failure.code : null,
    isTimeout: failure.killed === true && failure.signal !== null && !isLaunchFailure,
    isLaunchFailure,
    stderrTail: redactLog(stderr, credentialValues(process.env)).slice(-STDERR_TAIL),
  };
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
    : { file: trustedExecutable(file), args: [...args] };
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
    throw new CommandFailureError(commandDiagnostics(file, args, error), { cause: error });
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
