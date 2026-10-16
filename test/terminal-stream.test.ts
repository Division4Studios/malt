/** @file Browser-native SSE bounds, scope/cursor validation and backpressured single-flight reads. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { terminalPage, terminalViews } from '../web/src/terminal-contract.ts';
import { TerminalEventDecoder, TerminalStream } from '../web/src/terminal-stream.ts';

/** Public fixture identity carries no native process capability. */
const id = '00000000-0000-4000-8000-000000000001';
/** Stateless native UTF-8 wire encoder. */
const encoder = new TextEncoder();
/** Validated UI metadata is a strict subset of the backend row. */
const session = {
  id,
  provider: 'codex',
  state: 'exited',
  columns: 80,
  rows: 24,
  worktree: '/scratch',
  reason: 'fixture exit',
};

await test('workspace metadata rejects duplicate, malformed and unbounded session lists', () => {
  assert.deepEqual(terminalViews([session]), [session]);
  assert.throws(() => terminalViews([session, session]), /Duplicate/v);
  assert.throws(() => terminalViews({ sessions: [] }), /list/v);
  assert.throws(() => terminalViews(Array.from({ length: 101 }, () => session)), /list/v);
  assert.throws(() => terminalViews([{ ...session, provider: 'shell' }]), /provider/v);
});

/**
 * Build a deterministic native SSE event.
 *
 * @param sequence - Expected monotonic cursor.
 * @returns Actual UTF-8 wire bytes.
 */
function event(sequence: number): Uint8Array {
  const page = { session, output: [{ type: 'data', sequence, text: 'é日' }], nextCursor: sequence, unavailable: false };
  return encoder.encode(`id: ${String(sequence)}\nevent: terminal\ndata: ${JSON.stringify(page)}\n\n: heartbeat\n\n`);
}

await test('SSE decoder is chunk/Unicode safe and refuses oversized or ambiguous frames', () => {
  const bytes = event(1);
  for (let split = 0; split <= bytes.length; split += 1) {
    const decoder = new TerminalEventDecoder();
    const events = [...decoder.push(bytes.subarray(0, split)), ...decoder.push(bytes.subarray(split))];
    assert.equal(events.length, 1);
    assert.equal(events[0]?.id, '1');
    assert.equal(terminalPage(events[0].value, { id, after: 0 }).output[0]?.type, 'data');
  }
  const faulty = new TerminalEventDecoder();
  assert.throws(() => faulty.push(new Uint8Array(1_048_577)), /bound/v);
  assert.throws(() => faulty.push(encoder.encode('event: disconnected\ndata: {}\n\n')), /disconnected/v);
  const duplicate = new TerminalEventDecoder();
  assert.throws(() => duplicate.push(encoder.encode('id: 1\nid: 2\nevent: terminal\ndata: {}\n\n')), /envelope/v);
});

await test('browser replay rejects wrong scopes, skipped/duplicate cursors and excessive entry metadata', () => {
  const page = { session, output: [{ type: 'data', sequence: 1, text: 'safe' }], nextCursor: 1, unavailable: false };
  assert.throws(() => terminalPage(page, { id: 'foreign', after: 0 }), /scope/v);
  assert.throws(() => terminalPage(page, { id, after: 1 }), /cursor/v);
  assert.throws(() => terminalPage({ ...page, nextCursor: 2 }, { id, after: 0 }), /skipped/v);
  assert.throws(
    () => terminalPage({ ...page, output: Array.from({ length: 129 }, () => page.output[0]) }, { id, after: 0 }),
    /scope/v,
  );
  const gap = { ...page, output: [{ type: 'truncated', sequence: 1 }, ...page.output] };
  assert.equal(terminalPage(gap, { id, after: 0 }).output.length, 2);
});

await test('one browser stream waits for each applied page and never creates duplicate fetch loops', async (t) => {
  let fetches = 0;
  const applied: number[] = [];
  const states: string[] = [];
  const blocked = Promise.withResolvers<undefined>();
  const entered = Promise.withResolvers<undefined>();
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    await Promise.resolve();
    fetches += 1;
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('Last-Event-ID'), '0');
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(event(1));
        controller.enqueue(event(2));
        controller.close();
      },
    });
    return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
  });
  const stream = new TerminalStream({
    project: 'home',
    id,
    async page(page) {
      applied.push(page.nextCursor);
      entered.resolve(undefined);
      await blocked.promise;
    },
    state(state) {
      states.push(state);
    },
  });
  t.after(() => {
    blocked.resolve(undefined);
    stream.close();
  });
  const first = stream.run();
  const second = stream.run();
  await entered.promise;
  assert.deepEqual(applied, [1]);
  blocked.resolve(undefined);
  await Promise.all([first, second]);
  assert.equal(fetches, 1);
  assert.deepEqual(applied, [1, 2]);
  assert.equal(states.at(-1), 'ended');
  stream.close();
});

for (const status of [401, 503]) {
  await test(`terminal stream ${String(status)} stops on expired pairing or cancelled reconnect`, async (t) => {
    let fetches = 0;
    const notice = Promise.withResolvers<string>();
    t.mock.method(globalThis, 'fetch', async () => {
      await Promise.resolve();
      fetches += 1;
      return new Response('{}', { status });
    });
    const stream = new TerminalStream({
      project: 'home',
      id,
      async page() {
        await Promise.resolve();
        assert.fail('An error response must never become terminal output.');
      },
      state(state) {
        if (state === 'expired' || state === 'disconnected') {
          notice.resolve(state);
        }
      },
    });
    t.after(() => {
      stream.close();
    });
    const running = stream.run();
    assert.equal(await notice.promise, status === 401 ? 'expired' : 'disconnected');
    stream.close();
    await running;
    assert.equal(fetches, 1);
  });
}
