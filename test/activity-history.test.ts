/**
 * Direct TypeScript history tests require no compiled browser runtime imports.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ActivityHistory } from '../web/src/history.ts';

/**
 * Produce ascending immutable fixture identities.
 *
 * @param start - First sequence.
 * @param length - Event count.
 * @returns Plain event records.
 */
function events(start: number, length: number): Record<string, unknown>[] {
  return Array.from({ length }, (_, index) => ({ seq: start + index, text: `Event ${String(start + index)}` }));
}

await test('older pages traverse past retention while interleaved live frames stay separate and bounded', async () => {
  const history = new ActivityHistory();
  history.observe(events(501, 200));
  const cursors: number[] = [];
  const read = async (project: string, before: number): Promise<unknown> => {
    cursors.push(before);
    await Promise.resolve();
    return { project, events: events(before - 50, 50), oldestCursor: before - 50, hasMore: true };
  };
  for (let index = 0; index < 6; index += 1) {
    await history.load(read);
    history.observe(events(701 + index * 100, 100));
    const view = history.view();
    assert.equal(view.recent.length, 200);
    assert.equal(view.visible.length, 50);
    assert.ok(view.recent.every((event) => Number(event['seq']) >= 501));
  }
  assert.deepEqual(cursors, [501, 451, 401, 351, 301, 251]);
  assert.deepEqual(history.view().visible, events(201, 50));
  history.observe(events(1, 100));
  assert.deepEqual(
    history.view().visible,
    events(201, 50),
    'An old reconnect snapshot cannot evict the displayed page.',
  );
  history.returnRecent();
  assert.equal(history.view().isOlder, false);
  assert.equal(history.view().recent.length, 200);
  const identities = new Set(history.view().recent.map((event) => event['seq']));
  assert.equal(identities.size, 200);
});

await test('single-flight paging preserves the page and exact retry cursor after failure', async () => {
  const history = new ActivityHistory();
  history.observe(events(101, 10));
  const pending = Promise.withResolvers<unknown>();
  let reads = 0;
  const read = async (): Promise<unknown> => {
    reads += 1;
    return await pending.promise;
  };
  const first = history.load(read);
  await history.load(read);
  assert.equal(reads, 1);
  assert.equal(history.view().isLoading, true);
  pending.resolve({ project: 'home', events: events(51, 50), oldestCursor: 51, hasMore: true });
  await first;
  await history.load(async (_project, before) => {
    await Promise.resolve();
    assert.equal(before, 51);
    throw new Error('Fixture unavailable.');
  });
  assert.equal(history.view().error, 'Fixture unavailable.');
  assert.deepEqual(history.view().visible, events(51, 50));
  await history.load(async (project, before) => {
    assert.equal(before, 51);
    await Promise.resolve();
    return { project, events: events(1, 50), oldestCursor: 1, hasMore: false };
  });
  assert.equal(history.view().hasMore, false);
  assert.equal(history.view().error, null);
  await history.load(read);
  assert.equal(reads, 1, 'Exhausted history does not request another page.');
});

await test('selection generations reject old success, error and finalizers across A-to-B-to-A', async () => {
  const history = new ActivityHistory();
  history.select('a');
  history.observe(events(101, 10));
  const original = history.scope();
  const late = Promise.withResolvers<unknown>();
  const first = history.load(async () => await late.promise);
  history.select('b');
  assert.deepEqual(history.view().recent, []);
  history.select('a');
  assert.equal(history.isCurrent(original), false);
  history.observe(events(201, 10));
  const current = Promise.withResolvers<unknown>();
  const second = history.load(async () => await current.promise);
  late.resolve({ project: 'a', events: events(51, 50), oldestCursor: 51, hasMore: true });
  await first;
  assert.equal(history.view().isLoading, true, 'An old finalizer cannot clear the new request.');
  current.reject(new Error('Current request failed.'));
  await second;
  assert.equal(history.view().error, 'Current request failed.');
  const stale = Promise.withResolvers<unknown>();
  const third = history.load(async () => await stale.promise);
  history.select('b');
  history.observe(events(1, 2));
  stale.reject(new Error('Old project failure.'));
  await third;
  assert.equal(history.view().error, null);
  assert.deepEqual(history.view().recent, events(1, 2));
});

await test('malformed pages never modify displayed history or advance its cursor', async () => {
  const history = new ActivityHistory();
  history.observe(events(101, 10));
  const valid = { project: 'home', events: events(51, 50), oldestCursor: 51, hasMore: true };
  await history.load(async () => {
    await Promise.resolve();
    return valid;
  });
  const invalid: unknown[] = [
    null,
    [],
    { ...valid, project: 'foreign' },
    { ...valid, events: {} },
    { ...valid, events: events(1, 51) },
    { ...valid, hasMore: 'false' },
    { ...valid, events: events(1, 2), oldestCursor: 2 },
    { ...valid, events: [{ seq: 2 }, { seq: 1 }], oldestCursor: 2 },
    { ...valid, events: [{ seq: 1 }, { seq: 1 }], oldestCursor: 1 },
    { ...valid, events: [{ seq: 1.5 }], oldestCursor: 1.5 },
    { ...valid, events: [], oldestCursor: 51 },
  ];
  for (const value of invalid) {
    let requested = 0;
    await history.load(async (_project, before) => {
      requested = before;
      await Promise.resolve();
      return value;
    });
    assert.equal(requested, 51);
    assert.deepEqual(history.view().visible, valid.events);
    assert.notEqual(history.view().error, null);
  }
  assert.throws(() => {
    history.observe([{ seq: 0 }]);
  });
  assert.throws(() => {
    history.observe([{ seq: 1 }, { seq: 1 }]);
  });
  await history.load(async (project, before) => {
    await Promise.resolve();
    return { project, events: [], oldestCursor: before, hasMore: false };
  });
  assert.deepEqual(history.view().visible, []);
  assert.equal(history.view().hasMore, false);
});
