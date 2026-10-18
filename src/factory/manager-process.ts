/**
 * Owned persistent process for the delivery manager. It runs inside the same
 * containment wrapper as worker jobs (Windows Job Object or POSIX process
 * group, parent-link orphan cleanup, memory and process ceilings) but keeps
 * stdin open so the operator conversation streams into one live session.
 * Output is decoded into bounded lines and redacted before anyone sees it.
 *
 * @file
 */

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { SecretRedactor } from '../secrets.ts';
import { writeAtomic } from '../summary.ts';

import { credentialValues } from './authentication.ts';
import { commandInvocation, terminateTree } from './commands.ts';
import { LineDecoder } from './manager-stream.ts';

/** Containment wrapper shared with worker jobs. */
const HELPER = path.join(import.meta.dirname, 'agent-process.ts');
/** Grace for an orderly exit after stdin closes, before the owned tree is terminated. */
const STOP_GRACE_MS = 5000;
/** Retained standard-error tail for failure diagnostics. */
const STDERR_TAIL = 4000;

/** Launch request for one persistent manager process. */
export interface ManagerProcessSpec {
  /** Native executable. */
  readonly file: string;
  /** Literal arguments. */
  readonly args: readonly string[];
  /** Working directory. */
  readonly cwd: string;
  /** Private artifact directory for this generation. */
  readonly artifact: string;
  /** Windows Job Object memory ceiling in MiB. */
  readonly memoryMb: number;
  /** Hard process ceiling including descendants. */
  readonly processLimit: number;
  /** Non-secret environment overrides. */
  readonly env?: Readonly<Record<string, string>>;
  /** Known credentials removed from every output line. */
  readonly secrets?: readonly string[];
}

/** Observers for one process. */
export interface ManagerProcessObservers {
  /** Each complete, redacted output line. */
  readonly onLine: (line: string) => void;
  /** Exactly one exit notification. */
  readonly onExit: (exit: { code: number | null; stderr: string; isRequested: boolean }) => void;
}

/** Live handle of one persistent manager process. */
export interface ManagerProcess {
  /** Wrapper PID, for display and owned-tree termination. */
  readonly pid: number | null;

  /**
   * Write one complete input line.
   *
   * @param line - Text ending in a newline.
   * @returns Whether the process still accepted input.
   */
  readonly write: (line: string) => boolean;

  /**
   * Close input, wait briefly for an orderly exit, then terminate the owned tree.
   *
   * @returns Resolves after the process has exited.
   */
  readonly stop: () => Promise<void>;
}

/** Injectable launcher; fixtures replace it without spawning a provider. */
export type ManagerLauncher = (spec: ManagerProcessSpec, observers: ManagerProcessObservers) => ManagerProcess;

/**
 * Start a persistent manager process inside the owned containment wrapper.
 *
 * @param spec - Authorized command and limits.
 * @param observers - Line and exit callbacks.
 * @returns Live handle.
 * @throws {Error} When the operating system did not create the process pipes.
 */
export function startManagerProcess(spec: ManagerProcessSpec, observers: ManagerProcessObservers): ManagerProcess {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Generation directory under the selected project's private factory state.
  mkdirSync(spec.artifact, { recursive: true, mode: 0o700 });
  const descriptor = path.join(spec.artifact, 'launch.json');
  const invocation = commandInvocation(spec.file, spec.args);
  writeAtomic(
    descriptor,
    `${JSON.stringify({ ...invocation, cwd: spec.cwd, input: '', env: spec.env ?? {}, memoryMb: spec.memoryMb, cpuPercent: 100, processLimit: spec.processLimit, stream: true }, null, 2)}\n`,
  );
  const child = spawn(process.execPath, [HELPER, descriptor], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });
  const { stdin, stdout, stderr: errors } = child;
  if (stdin === null || stdout === null || errors === null) {
    throw new Error('The manager process pipes were not created.');
  }
  const redactor = new SecretRedactor([...(spec.secrets ?? []), ...credentialValues(process.env)]);
  const decoder = new LineDecoder();
  let stderr = '';
  let isRequested = false;
  let isExited = false;
  let stopping: Promise<void> | null = null;
  const exited = new Promise<void>((resolve) => {
    const finish = (code: number | null): void => {
      if (isExited) {
        return;
      }
      isExited = true;
      observers.onExit({ code, stderr, isRequested });
      resolve();
    };
    child.once('error', () => {
      finish(null);
    });
    child.once('close', finish);
  });
  stdout.setEncoding('utf8');
  errors.setEncoding('utf8');
  stdout.on('data', (chunk: string) => {
    for (const line of decoder.push(chunk)) {
      observers.onLine(redactor.redact(line));
    }
  });
  errors.on('data', (chunk: string) => {
    stderr = `${stderr}${redactor.redact(chunk)}`.slice(-STDERR_TAIL);
  });
  stdin.on('error', () => {
    /* A closed pipe surfaces through the exit notification. */
  });
  return {
    pid: child.pid ?? null,
    write: (line) => !isExited && !isRequested && stdin.writable && stdin.write(line),
    stop: async () => {
      stopping ??= (async (): Promise<void> => {
        isRequested = true;
        stdin.end();
        const timer = setTimeout(() => {
          if (child.connected) {
            child.disconnect();
          }
          if (!isExited && child.pid !== undefined) {
            void terminateTree(child.pid);
          }
        }, STOP_GRACE_MS);
        await exited;
        clearTimeout(timer);
      })();
      await stopping;
    },
  };
}
