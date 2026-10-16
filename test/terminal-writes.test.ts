/** @file Native input serialization, bounded buffering, cancellation and ambiguous failure. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TerminalWrites } from '../web/src/terminal-writes.ts';

await test('writes serialize and coalesce while cancellation drops every unsent key', async () => {
  const calls: string[] = [];
  const first = Promise.withResolvers<undefined>();
  const second = Promise.withResolvers<undefined>();
  let count = 0;
  const queue = new TerminalWrites({
    isReady: () => true,
    failed: () => assert.fail('No failure expected.'),
    send: async (text) => {
      calls.push(text);
      count += 1;
      await (count === 1 ? first.promise : second.promise);
    },
  });
  assert.equal(queue.append('a'), true);
  queue.append('b');
  queue.append('日');
  assert.deepEqual(calls, ['a']);
  first.resolve(undefined);
  await first.promise;
  await Promise.resolve();
  assert.deepEqual(calls, ['a', 'b日']);
  queue.append('unsent');
  queue.close();
  second.resolve(undefined);
  await second.promise;
  await Promise.resolve();
  assert.deepEqual(calls, ['a', 'b日']);
  assert.equal(queue.append('late'), false);
});

await test('an uncertain input failure reports once and never replays queued or later text', async () => {
  const first = Promise.withResolvers<undefined>();
  const calls: string[] = [];
  let failures = 0;
  const queue = new TerminalWrites({
    isReady: () => true,
    failed: () => {
      failures += 1;
    },
    send: async (text) => {
      calls.push(text);
      await first.promise;
    },
  });
  queue.append('sent once');
  queue.append('never replay');
  first.reject(new Error('Ambiguous transport failure.'));
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(calls, ['sent once']);
  assert.equal(failures, 1);
  assert.equal(queue.append('late'), false);
});

await test('offline or changed-scope input is discarded and Unicode pending bytes stay bounded', async () => {
  let isReady = true;
  const pending = Promise.withResolvers<undefined>();
  const calls: string[] = [];
  const queue = new TerminalWrites({
    isReady: () => isReady,
    failed: () => assert.fail('No failure expected.'),
    send: async (text) => {
      calls.push(text);
      await pending.promise;
    },
  });
  queue.append('in flight');
  queue.append('日'.repeat(5000));
  assert.throws(() => queue.append('日'.repeat(1000)), RangeError);
  isReady = false;
  assert.equal(queue.append('offline'), false);
  pending.resolve(undefined);
  await pending.promise;
  await Promise.resolve();
  isReady = true;
  assert.equal(queue.append('after reconnect'), false);
  assert.deepEqual(calls, ['in flight']);
});
