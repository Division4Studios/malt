/** @file Owned interactive process handle; terminal content is never written to disk. */
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { MeshError } from '../protocol.ts';
import { writeAtomic } from '../summary.ts';

import { terminateTree } from './commands.ts';
import { encodeFrame, FrameDecoder, MAX_FRAME_BODY } from './terminal-frames.ts';
import { terminalLaunchSchema } from './terminal-launch.ts';

import type { Frame } from './terminal-frames.ts';
import type { TerminalLaunchInput } from './terminal-launch.ts';
import type { Readable } from 'node:stream';

/** Grace for the wrapper to release its Job / both Linux process groups. */
const STOP_MS = 8000;
/** Process ceilings include host, conhost, CLI, tools and native cleanup helper. */
const PROCESS_LIMIT = 32;
/** Only the deterministic fixture can expose a bounded startup diagnostic. */
const DIAGNOSTIC_MAX = 500;
/** Only fixture failures expose the first few transport bytes for CI diagnosis. */
const FRAME_PREVIEW = 32;

/** An in-memory handle to exactly one owned native host. */
export interface TerminalProcess {
  /** Completion only after the wrapper and its descendants settle. */
  readonly closed: Promise<void>;
  /** Send a bounded input/control frame to the host. */
  readonly send: (frame: Frame) => void;
  /** Idempotently stop the owned process tree. */
  readonly stop: () => Promise<void>;
}
/** Server-only launch context. No field is accepted from a browser as a descriptor. */
export interface TerminalProcessSpec {
  /** Validated provider and scratch-worktree metadata. */
  readonly launch: TerminalLaunchInput;
  /** Private session metadata directory. */
  readonly artifact: string;
  /** Windows aggregate Job memory ceiling. */
  readonly memoryMb: number;
  /** Windows aggregate Job CPU ceiling. */
  readonly cpuPercent: number;
  /** Operator-configured hard Windows descendant ceiling. */
  readonly processLimit?: number;
  /** Test-only deterministic CLI; never selected by a route or provider configuration. */
  readonly fixture?: boolean;
  /** Test-only fixed numeric evidence around actual native output writes. */
  readonly observePressure?: boolean;
  /** Test-only observation of the exact owned wrapper, never accepted from a browser. */
  readonly onWrapperSpawn?: (pid: number) => void;
  /** Test-only output flow control, never exposed to an operator or provider launch. */
  readonly onOutput?: (output: Readable) => void;
  /** Receive validated native frames in memory. */
  readonly onFrame: (frame: Frame) => void;
}

/**
 * Spawn under the existing parent-aware containment wrapper, without log capture.
 *
 * @param spec - Server-owned launch and resource limits.
 * @returns Live owned handle.
 * @throws {Error} When the process cannot provide the required owned pipes.
 */
export function startTerminalProcess(spec: TerminalProcessSpec): TerminalProcess {
  const launch = terminalLaunchSchema.parse(spec.launch);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Server-owned private session metadata directory.
  mkdirSync(spec.artifact, { recursive: true, mode: 0o700 });
  const hostFile = path.join(spec.artifact, 'terminal-launch.json');
  writeAtomic(hostFile, JSON.stringify(launch));
  const wrapperFile = path.join(spec.artifact, 'owned-launch.json');
  writeAtomic(
    wrapperFile,
    JSON.stringify({
      file: process.execPath,
      args: [
        path.join(import.meta.dirname, 'terminal-host.ts'),
        hostFile,
        ...(spec.fixture === true ? ['--fixture'] : []),
        ...(spec.fixture === true && spec.observePressure === true ? ['--observe-pressure'] : []),
      ],
      cwd: launch.cwd,
      input: '',
      env: {},
      interactive: true,
      memoryMb: spec.memoryMb,
      cpuPercent: spec.cpuPercent,
      processLimit: spec.processLimit ?? PROCESS_LIMIT,
    }),
  );
  const child = spawn(process.execPath, [path.join(import.meta.dirname, 'agent-process.ts'), wrapperFile], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });
  const input = child.stdin;
  if (spec.fixture === true) {
    child.once('spawn', () => {
      const { pid } = child;
      if (pid !== undefined) {
        spec.onWrapperSpawn?.(pid);
      }
    });
  }
  const output = child.stdout;
  if (input === null || output === null) {
    if (child.pid !== undefined) {
      void terminateTree(child.pid);
    }
    throw new Error('Terminal wrapper requires owned pipes.');
  }
  let isSettled = false;
  let diagnostic = '';
  let stopping: Promise<void> | null = null;
  let timer: NodeJS.Timeout | null = null;
  const completion = Promise.withResolvers<undefined>();
  const closed: Promise<void> = completion.promise;
  const finish = (): void => {
    isSettled = true;
    if (timer !== null) {
      clearTimeout(timer);
    }
    completion.resolve(undefined);
  };
  child.once('close', finish);
  child.once('exit', () => {
    if (diagnostic !== '') {
      spec.onFrame({
        type: 'error',
        code: 'host_setup_failed',
        message:
          spec.fixture === true
            ? diagnostic.slice(0, DIAGNOSTIC_MAX)
            : 'The native host wrapper failed during startup.',
      });
    }
    if (stopping === null) {
      return;
    }

    input.destroy();
    output.destroy();
    finish();
  });
  child.once('error', finish);
  child.stderr?.on('data', (bytes: Uint8Array) => {
    diagnostic =
      spec.fixture === true
        ? (diagnostic + Buffer.from(bytes).toString('utf8')).slice(0, DIAGNOSTIC_MAX)
        : 'The native host wrapper reported a startup error.';
  });
  const stop = async (): Promise<void> => {
    stopping ??= (async (): Promise<void> => {
      if (isSettled) {
        return;
      }
      // Cancellation must release a stalled consumer before waiting for owned pipe closure.
      output.resume();
      if (child.connected) {
        child.disconnect();
      }
      input.destroy();
      if (child.exitCode !== null || child.signalCode !== null) {
        output.destroy();
        finish();
        return;
      }
      timer = setTimeout(() => {
        if (isSettled || child.pid === undefined) {
          return;
        }

        const { pid } = child;
        void (async (): Promise<void> => {
          await terminateTree(pid);
          input.destroy();
          output.destroy();
          if (child.exitCode !== null || child.signalCode !== null) {
            finish();
          }
        })();
      }, STOP_MS);
      await closed;
    })();
    return stopping;
  };
  const decoder = new FrameDecoder();
  output.on('data', (bytes: Uint8Array) => {
    try {
      const frames = decoder.push(bytes);
      for (const frame of frames) {
        spec.onFrame(frame);
      }
    } catch {
      spec.onFrame({
        type: 'error',
        code: 'host_protocol_failed',
        message:
          spec.fixture === true
            ? Buffer.from(bytes).subarray(0, FRAME_PREVIEW).toString('hex')
            : 'The native host violated its frame protocol.',
      });
      void stop();
    }
  });
  if (spec.fixture === true) {
    spec.onOutput?.(output);
  }
  input.on('error', () => {
    void stop();
  });
  return {
    closed,
    stop,

    /**
     * Write only while the bounded owned channel is writable.
     *
     * @param frame - Bounded input or control message.
     * @throws {MeshError} When the channel is closed or its queue is full.
     */
    send(frame): void {
      const wire = encodeFrame(frame);
      if (isSettled || !input.writable || input.writableLength + wire.length > MAX_FRAME_BODY) {
        throw new MeshError('FACTORY_GATED', 'Terminal input is closed or backpressured.');
      }
      input.write(wire);
    },
  };
}
