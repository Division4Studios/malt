/** @file Isolated native PTY addon host. Stdio contains framed bytes only, never logs. */
import { Buffer } from 'node:buffer';
import { open } from 'node:fs/promises';
import { createConnection } from 'node:net';
import path from 'node:path';

import { encodeFrame, FrameDecoder, MAX_FRAME_BODY } from './terminal-frames.ts';
import { isTerminalInputName } from './terminal-input.ts';
import { terminalArguments, terminalEnvironment, terminalLaunchSchema } from './terminal-launch.ts';

import type { Frame } from './terminal-frames.ts';
import type { TerminalLaunch } from './terminal-launch.ts';
import type * as NativePty from 'node-pty';
import type { IPty } from 'node-pty';

/** Descriptor is metadata only and must fit this bound before reading. */
const DESCRIPTOR_BYTES = 16_384;
/** Fixture is selected only by the private test host invocation, never an operator route. */
const FIXTURE = path.resolve(import.meta.dirname, '../../test/fixtures/terminal-fixture.ts');

/**
 * Write a bounded frame; a slow broker pauses native output until drain.
 *
 * @param frame - Validated host frame.
 * @param terminal - Owned PTY, if started.
 */
function send(frame: Frame, terminal?: IPty): void {
  const isAccepted = process.stdout.write(encodeFrame(frame));
  if (terminal === undefined || isAccepted) {
    return;
  }

  terminal.pause();
  process.stdout.once('drain', () => {
    terminal.resume();
  });
}

/**
 * Report a fixed startup category without provider output.
 *
 * @param code - Fixed failure category.
 * @param message - Safe diagnostic.
 */
function failStartup(code: string, message: string): void {
  send({ type: 'error', code, message });
  process.exitCode = 1;
}

/**
 * Read a bounded, private descriptor. It cannot name arbitrary arguments or environment.
 *
 * @returns Validated launch descriptor.
 * @throws {Error} When the descriptor is missing, oversized or invalid.
 */
async function descriptor(): Promise<TerminalLaunch> {
  const file = process.argv[2];
  if (file === undefined) {
    throw new Error('Missing terminal descriptor.');
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Only the owning wrapper selects this private metadata file.
  await using fd = await open(file, 'r');
  const bytes = Buffer.alloc(DESCRIPTOR_BYTES + 1);
  const { bytesRead: size } = await fd.read(bytes, 0, bytes.length, 0);
  if (size > DESCRIPTOR_BYTES) {
    throw new Error('Oversized terminal descriptor.');
  }
  return terminalLaunchSchema.parse(JSON.parse(bytes.subarray(0, size).toString('utf8')));
}

/** Run exactly one PTY, never a shell or a managed assignment. */
async function main(): Promise<void> {
  const launch = await descriptor();
  const pipeIndex = process.argv.indexOf('--input-pipe');
  const pipe = pipeIndex === -1 ? undefined : process.argv[pipeIndex + 1];
  if (pipeIndex !== -1 && (pipe === undefined || process.platform !== 'win32' || !isTerminalInputName(pipe))) {
    throw new Error('Invalid private terminal input channel.');
  }
  let native: typeof NativePty;
  try {
    native = await import('node-pty');
  } catch {
    failStartup('unsupported_platform', 'Native terminal support is unavailable.');
    return;
  }
  const isFixture = process.argv[3] === '--fixture';
  let terminal: IPty;
  try {
    terminal = native.spawn(
      isFixture ? process.execPath : launch.file,
      isFixture ? [FIXTURE] : terminalArguments(launch),
      {
        name: 'xterm-256color',
        cols: launch.columns,
        rows: launch.rows,
        cwd: launch.cwd,
        env: terminalEnvironment(process.env),
        useConptyDll: false,
      },
    );
  } catch {
    failStartup('unsupported_platform', 'Native terminal could not start.');
    return;
  }
  // ConPTY connects asynchronously: its public PID is zero until the socket is ready.
  let isAnnounced = false;
  const announce = (): void => {
    if (isAnnounced || terminal.pid <= 0) {
      return;
    }

    isAnnounced = true;
    send({ type: 'started', pid: terminal.pid });
  };
  announce();
  const input = pipe === undefined ? process.stdin : createConnection(pipe);
  let isEnded = false;
  const decoder = new FrameDecoder();
  const close = (): void => {
    terminal.kill();
    input.pause();
  };
  const fail = (): void => {
    send({ type: 'error', code: 'protocol_error', message: 'Terminal channel rejected a frame.' });
    close();
  };
  terminal.onData((text) => {
    if (isEnded) {
      return;
    }
    announce();
    const bytes = Buffer.from(text);
    if (bytes.length > MAX_FRAME_BODY) {
      fail();
      return;
    }
    send({ type: 'data', data: bytes }, terminal);
  });
  terminal.onExit((event) => {
    if (isEnded) {
      return;
    }
    isEnded = true;
    send({ type: 'exit', code: event.exitCode, signal: event.signal === undefined ? null : String(event.signal) });
    if (process.platform === 'win32') {
      terminal.kill();
    }
    input.destroy();
    input.unref();
  });
  const apply = (frame: Frame): void => {
    switch (frame.type) {
      case 'input': {
        terminal.write(Buffer.from(frame.data).toString('utf8'));
        break;
      }
      case 'resize': {
        terminal.resize(frame.columns, frame.rows);
        break;
      }
      case 'close': {
        close();
        break;
      }
      case 'data':
      case 'error':
      case 'exit':
      case 'started': {
        fail();
        break;
      }
    }
  };
  input.on('data', (chunk: Buffer) => {
    try {
      const frames = decoder.push(chunk);
      for (const frame of frames) {
        apply(frame);
      }
    } catch {
      fail();
    }
  });
  input.once('end', close);
  input.once('error', close);
  process.once('SIGTERM', close);
  process.stdout.once('error', close);
}

try {
  await main();
} catch {
  failStartup('invalid_launch', 'Terminal launch descriptor was rejected.');
}
