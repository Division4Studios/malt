/** @file Terminal SSE drains one bounded frame or releases a stalled subscriber. */
import assert from 'node:assert/strict';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { test } from 'node:test';

import { writeTerminalPage } from '../src/web/terminal-streams.ts';

import type { TerminalPage } from '../src/factory/terminal-reads.ts';
import type { TestContext } from 'node:test';

/** Metadata fixture contains no native session, process, credential or inference. */
const PAGE: TerminalPage = {
  session: {
    id: 'f27e4b32-90a7-4232-a4bb-54e874f615a8',
    project: 'fixture',
    provider: 'codex',
    worktree: 'fixture',
    branch: 'malt/terminal/fixture',
    base: 'a'.repeat(40),
    baseBranch: 'main',
    state: 'running',
    createdAt: 0,
    updatedAt: 0,
    columns: 80,
    rows: 24,
    inputBytes: 0,
    outputBytes: 0,
    exitCode: null,
    reason: '',
  },
  output: [],
  nextCursor: 0,
  unavailable: false,
};

/**
 * Exercise the real HTTP writer with a deliberately stalled socket boundary.
 *
 * @param t - Owns mock restoration and socket disposal.
 * @returns Actual response and bounded observed writes.
 */
function stalled(t: TestContext): { response: ServerResponse; writes: string[] } {
  const socket = new Socket();
  const request = new IncomingMessage(socket);
  const response = new ServerResponse(request);
  const writes: string[] = [];
  t.mock.method(response, 'write', (chunk: unknown) => {
    writes.push(String(chunk));
    return false;
  });
  t.after(() => {
    response.destroy();
    request.destroy();
    socket.destroy();
  });
  return { response, writes };
}

await test('terminal SSE holds exactly one page until drain and rejects an oversized frame before writing', async (t) => {
  const { response, writes } = stalled(t);
  const controller = new AbortController();
  const pending = writeTerminalPage(response, PAGE, controller.signal);
  assert.equal(response.listenerCount('drain'), 1);
  assert.equal(writes.length, 2, 'One retry header and one page; no polling while backpressured.');
  assert.match(writes[1] ?? '', /: heartbeat/v);
  response.emit('drain');
  await pending;
  assert.equal(response.listenerCount('drain'), 0);

  const oversized = { ...PAGE, output: [{ type: 'data' as const, sequence: 1, text: 'x'.repeat(524_288) }] };
  await assert.rejects(writeTerminalPage(response, oversized, controller.signal), /escaped byte ceiling/v);
  assert.equal(writes.length, 2, 'Oversized output must not reach the socket.');
});

await test('a stalled terminal SSE page expires its real drain deadline and removes listeners', async (t) => {
  const { response, writes } = stalled(t);
  const controller = new AbortController();
  // Keep the test alive while AbortSignal.timeout deliberately uses an unref timer.
  const fallback = setTimeout(() => {
    controller.abort();
  }, 10_000);
  try {
    await assert.rejects(writeTerminalPage(response, PAGE, controller.signal), { name: 'AbortError' });
    assert.equal(controller.signal.aborted, false, 'The production drain deadline must win.');
    assert.equal(writes.length, 2, 'A stalled subscriber retains only the current bounded page.');
    assert.equal(response.listenerCount('drain'), 0);
    assert.equal(response.listenerCount('error'), 0);
  } finally {
    clearTimeout(fallback);
  }
});
