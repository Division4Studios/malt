/**
 * Listening, closing and port lookup for the broker's HTTP server.
 *
 * @file
 */
import { once } from 'node:events';

import type http from 'node:http';

/**
 * Start listening, resolving once bound or rejecting on a bind error.
 *
 * @param server - The HTTP server.
 * @param port - The port to bind.
 * @param host - The interface to bind.
 * @returns A promise settled when listening starts or fails.
 */
export async function listen(server: http.Server, port: number, host: string): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<undefined>();
  server.once('error', reject);
  server.listen(port, host, () => {
    server.removeListener('error', reject);
    resolve(undefined);
  });
  return promise;
}

/**
 * Stop accepting connections and wait for in-flight requests to finish.
 *
 * @param server - The HTTP server.
 */
export async function closeServer(server: http.Server): Promise<void> {
  // Subscribe before closing so the 'close' event cannot be missed.
  const closed = once(server, 'close');
  server.close();
  await closed;
}

/**
 * Read the TCP port a listening server is bound to.
 *
 * @param server - The broker's server, after `listen` succeeded.
 * @returns The TCP port number, which the OS chose when port 0 was requested.
 * @throws {Error} When the server is not bound to a TCP address.
 */
export function boundPortOf(server: http.Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Broker is not listening on a TCP port.');
  }
  return address.port;
}
