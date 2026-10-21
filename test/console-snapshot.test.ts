/** @file The console's live snapshot asks for the local delivery ledger only when the policy uses local delivery. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { z } from 'zod/v3';

import { startBroker } from '../src/broker.ts';
import { ProjectGateway } from '../src/web/projects.ts';

import { brokerUrl, createCleanup, createProject } from './helpers.ts';

/** The snapshot field under test. */
const snapshotSchema = z.object({ local: z.unknown() });

/**
 * Run a callback with debug logging captured instead of printed.
 *
 * @param action - Work whose diagnostics to capture.
 * @returns The captured stderr lines and the action's result.
 */
async function captureLog<T>(action: () => Promise<T>): Promise<{ readonly lines: string[]; readonly result: T }> {
  const lines: string[] = [];
  const { stderr, env } = process;
  const write = stderr.write.bind(stderr);
  const level = env['AGENTMESH_LOG_LEVEL'];
  env['AGENTMESH_LOG_LEVEL'] = 'debug';
  stderr.write = (chunk: string | Uint8Array): boolean => {
    lines.push(String(chunk));
    return true;
  };
  try {
    return { lines, result: await action() };
  } finally {
    stderr.write = write;
    if (level === undefined) {
      delete env['AGENTMESH_LOG_LEVEL'];
    } else {
      env['AGENTMESH_LOG_LEVEL'] = level;
    }
  }
}

await test('an unconfigured project snapshot never calls factory_local', async (t) => {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  const broker = await startBroker(mesh, { port: 0 });
  defer(async () => broker.close());
  const gateway = new ProjectGateway({ ...mesh, url: brokerUrl(broker.port) });
  const { lines, result } = await captureLog(async () => gateway.snapshot('home'));
  assert.equal(snapshotSchema.parse(result).local, null);
  assert.ok(
    lines.some((line) => line.includes('"operation":"factory_status"')),
    'The snapshot was observed.',
  );
  assert.ok(
    lines.every((line) => !line.includes('"operation":"factory_local"')),
    'Without a local-delivery policy the console must not poll the local ledger.',
  );
});
