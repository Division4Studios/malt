/** @file Private Windows named-pipe input, independent of PowerShell bootstrap stdin. */
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';

import type { Socket } from 'node:net';
import type { Readable } from 'node:stream';

/** Local pipe namespace; its random capability never reaches the browser. */
const PIPE_PREFIX = String.raw`\\.\pipe\malt-terminal-`;

/**
 * Reject remote or caller-selected input endpoints.
 *
 * @param name - Private wrapper argument.
 * @returns Whether it is a local generated capability.
 */
export function isTerminalInputName(name: string): boolean {
  return (
    name.startsWith(PIPE_PREFIX) &&
    /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/v.test(name.slice(PIPE_PREFIX.length))
  );
}

/** One locally owned input capability; no network listener is exposed. */
export interface TerminalInput {
  /** Random named pipe passed only to the contained host. */
  readonly name: string;
  /** Stop forwarding and release both endpoints idempotently. */
  readonly close: () => Promise<void>;
}

/**
 * Keep the helper's stdin closed while the PTY host receives real input on a private channel.
 *
 * @param source - Owned wrapper's framed stdin, never a shell command stream.
 * @returns Connected-server capability and its cleanup.
 */
export async function createTerminalInput(source: Readable): Promise<TerminalInput> {
  const name = `${PIPE_PREFIX}${randomUUID()}`;
  let socket: Socket | null = null;
  const server = createServer((connection) => {
    if (socket !== null) {
      connection.destroy();
      return;
    }
    socket = connection;
    connection.on('error', () => {
      connection.destroy();
    });
    source.pipe(connection);
  });
  server.maxConnections = 1;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ path: name, readableAll: false, writableAll: false }, resolve);
  });
  let closing: Promise<void> | null = null;
  return {
    name,
    /** Release the one owned connection and listening endpoint. */
    async close(): Promise<void> {
      closing ??= new Promise<void>((resolve) => {
        if (socket !== null) {
          source.unpipe(socket);
          socket.destroy();
        }
        server.close(() => {
          resolve();
        });
      });
      await closing;
    },
  };
}
