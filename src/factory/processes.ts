/**
 * Bounded managed process runner. Prompts, logs, structured launch descriptors
 * and outputs stay under the target project's .malt/factory job directory.
 *
 * @file
 */

import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import path from 'node:path';
import { finished } from 'node:stream/promises';

import { SecretRedactor } from '../secrets.ts';
import { writeAtomic } from '../summary.ts';

import { credentialValues } from './authentication.ts';
import { commandInvocation, terminateTree } from './commands.ts';

import type { WriteStream } from 'node:fs';
/** Named percent max bound. */
const PERCENT_MAX = 100;

/** Wrapper entry point, resolved from installed source rather than cwd. */
const HELPER = path.join(import.meta.dirname, 'agent-process.ts');
/** Maximum retained response tail used for structured decoding. */
const TAIL_MAX = 4_194_304;
/** Maximum bytes emitted by one bounded attempt. */
const OUTPUT_MAX = 67_108_864;
/** Grace for orderly wrapper IPC cancellation before forced owned-tree exit. */
const STOP_GRACE_MS = 5000;
/** Default hard Windows native-process/descendant ceiling. */
const DEFAULT_PROCESS_LIMIT = 32;

/** One explicitly authorized, shell-free child process. */
export interface ProcessSpec {
  /** Configured executable. */
  readonly file: string;
  /** Literal arguments. */
  readonly args: readonly string[];
  /** Isolated worktree. */
  readonly cwd: string;
  /** Assignment delivered through stdin. */
  readonly input: string;
  /** Private job artifact directory. */
  readonly artifact: string;
  /** Bounded execution deadline. */
  readonly timeoutMs: number;
  /** Windows Job Object memory ceiling; other platforms use admission controls. */
  readonly memoryMb?: number;
  /** Windows Job Object aggregate CPU ceiling. */
  readonly cpuPercent?: number;
  /** Hard Windows Job Object process count, including the native provider. */
  readonly processLimit?: number;
  /** Cancel this attempt on pause or shutdown. */
  readonly signal: AbortSignal;
  /** Non-secret, project-specific runtime environment overrides. */
  readonly env?: Readonly<Record<string, string>>;
  /** Known local credentials to redact from output; never written into launch descriptors. */
  readonly secrets?: readonly string[];

  /**
   * Granted secret environment variables. They reach the native process
   * through the wrapper's own environment, never a launch descriptor.
   */
  readonly secretEnv?: Readonly<Record<string, string>>;
  /** Record the wrapper PID once launched. */
  readonly onSpawn?: (pid: number) => void;
}
/** Completed process with bounded response tails. */
export interface ProcessResult {
  /** Exit status, or null when interrupted. */
  readonly exitCode: number | null;
  /** Retained standard output tail. */
  readonly stdout: string;
  /** Retained standard error tail. */
  readonly stderr: string;
  /** Whether cancellation/deadline/output bounds stopped the attempt. */
  readonly interrupted: boolean;
}
/** Injectable adapter used by real and fixture providers. */
export type ProcessRunner = (spec: ProcessSpec) => Promise<ProcessResult>;

/**
 * Launch a parent-aware provider or project check and persist its output.
 *
 * @param spec - Authorized command and owned artifact paths.
 * @returns Captured completion, including interrupted attempts.
 */
export async function runProcess(spec: ProcessSpec): Promise<ProcessResult> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Artifacts are confined to the job directory chosen by the factory.
  mkdirSync(spec.artifact, { recursive: true, mode: 0o700 });
  const descriptor = path.join(spec.artifact, 'launch.json');
  const invocation = commandInvocation(spec.file, spec.args);
  writeAtomic(
    descriptor,
    `${JSON.stringify({ ...invocation, cwd: spec.cwd, input: spec.input, env: spec.env ?? {}, memoryMb: spec.memoryMb ?? 0, cpuPercent: spec.cpuPercent ?? PERCENT_MAX, processLimit: spec.processLimit ?? DEFAULT_PROCESS_LIMIT }, null, 2)}\n`,
  );
  return new Promise<ProcessResult>((resolve) => {
    const child = spawn(process.execPath, [HELPER, descriptor], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      ...(spec.secretEnv !== undefined && { env: { ...process.env, ...spec.secretEnv } }),
    });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- An owned private attempt directory receives only a fixed log filename.
    const output = createWriteStream(path.join(spec.artifact, 'stdout.log'), { mode: 0o600 });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- An owned private attempt directory receives only a fixed log filename.
    const errors = createWriteStream(path.join(spec.artifact, 'stderr.log'), { mode: 0o600 });
    let stdout = '';
    let stderr = '';
    const secrets = [...(spec.secrets ?? []), ...credentialValues(process.env), ...Object.values(spec.secretEnv ?? {})];
    const stdoutFilter = new SecretRedactor(secrets);
    const stderrFilter = new SecretRedactor(secrets);
    let bytes = 0;
    let isInterrupted = spec.signal.aborted;
    let isSettled = false;
    let forceTimer: NodeJS.Timeout | null = null;
    const stop = (): void => {
      if (isSettled) {
        return;
      }
      isInterrupted = true;
      if (child.connected) {
        child.disconnect();
      }
      forceTimer ??= setTimeout(() => {
        void (async (): Promise<void> => {
          if (child.pid !== undefined && child.exitCode === null) {
            await terminateTree(child.pid);
          }
          child.stdout?.destroy();
          child.stderr?.destroy();
          finish(null);
        })();
      }, STOP_GRACE_MS);
    };
    const timer = setTimeout(stop, spec.timeoutMs);
    spec.signal.addEventListener('abort', stop, { once: true });
    if (spec.signal.aborted) {
      stop();
    }
    if (child.pid !== undefined) {
      spec.onSpawn?.(child.pid);
    }
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes <= OUTPUT_MAX) {
        const safe = stdoutFilter.write(chunk);
        stdout = (stdout + safe).slice(-TAIL_MAX);
        output.write(safe);
      } else {
        stop();
      }
    });
    child.stderr?.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes <= OUTPUT_MAX) {
        const safe = stderrFilter.write(chunk);
        stderr = (stderr + safe).slice(-TAIL_MAX);
        errors.write(safe);
      } else {
        stop();
      }
    });

    /**
     * Resolve process completion exactly once after all owned stop paths.
     *
     * @param exitCode - Native exit code, absent when startup failed.
     */
    function finish(exitCode: number | null): void {
      if (isSettled) {
        return;
      }
      isSettled = true;
      clearTimeout(timer);
      spec.signal.removeEventListener('abort', stop);
      const finalOutput = stdoutFilter.finish();
      const finalError = stderrFilter.finish();
      stdout = (stdout + finalOutput).slice(-TAIL_MAX);
      stderr = (stderr + finalError).slice(-TAIL_MAX);
      output.end(finalOutput);
      errors.end(finalError);
      if (forceTimer !== null) {
        clearTimeout(forceTimer);
      }
      void resolveAfterFlush({ exitCode, stdout, stderr, interrupted: isInterrupted }, [output, errors], resolve);
    }
    output.on('error', stop);
    errors.on('error', stop);
    child.once('error', () => {
      isInterrupted = true;
      finish(null);
    });
    child.once('close', finish);
    child.once('exit', (code) => {
      if (!isInterrupted) {
        return;
      }

      child.stdout?.destroy();
      child.stderr?.destroy();
      finish(code);
    });
  });
}

/**
 * Do not mark evidence complete until both owned log handles have flushed.
 *
 * @param result - Captured redacted completion.
 * @param streams - Owned output/error artifact writers.
 * @param resolve - Sole process completion resolver.
 */
async function resolveAfterFlush(
  result: ProcessResult,
  streams: readonly WriteStream[],
  resolve: (result: ProcessResult) => void,
): Promise<void> {
  try {
    await Promise.all(streams.map(async (stream) => finished(stream)));
    resolve(result);
  } catch {
    resolve({ ...result, interrupted: true });
  }
}
