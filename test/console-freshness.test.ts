/**
 * Silent-stream recovery stays bounded and cannot launch model work.
 *
 * @file
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { Freshness } from '../web/src/freshness.ts';

await test('silent stream fallback is single-flight, bounded, and resets only on real observations', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const freshness = new Freshness();
  freshness.observe();
  let reads = 0;
  const read = async (): Promise<void> => {
    reads += 1;
    await Promise.resolve();
  };
  await freshness.recover(read);
  assert.equal(reads, 0);
  t.mock.timers.tick(30_000);
  await Promise.all([freshness.recover(read), freshness.recover(read)]);
  assert.equal(reads, 1);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    t.mock.timers.tick(30_000);

    await freshness.recover(read);
  }
  assert.equal(reads, 5, 'Unreachable services must not trigger endless retries.');
  freshness.observe();
  t.mock.timers.tick(30_000);
  await freshness.recover(read);
  assert.equal(reads, 6);
});
