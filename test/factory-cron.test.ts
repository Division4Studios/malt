/** @file Cron schedules: parsing, time zones, daylight saving and day-field rules. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isTimeZone, nextFire, parseCron, upcomingFires } from '../src/factory/cron.ts';

/**
 * Format fire times as ISO strings for readable assertions.
 *
 * @param times - Epoch milliseconds.
 * @returns ISO timestamps.
 */
function iso(times: readonly (number | null)[]): (string | null)[] {
  return times.map((time) => {
    if (time === null) {
      return null;
    }
    const date = new Date(time);
    return date.toISOString();
  });
}
await test('weekday mornings fire in the schedule time zone, across daylight saving', () => {
  const spec = parseCron('0 9 * * mon-fri');
  // Friday 2026-03-06 10:00 UTC; New York switches to daylight time on Sunday 2026-03-08.
  const after = Date.UTC(2026, 2, 6, 10, 0);
  assert.deepEqual(iso(upcomingFires(spec, 'America/New_York', after, 3)), [
    '2026-03-06T14:00:00.000Z',
    '2026-03-09T13:00:00.000Z',
    '2026-03-10T13:00:00.000Z',
  ]);
  const kolkata = nextFire(spec, 'Asia/Kolkata', after);
  assert.deepEqual(iso([kolkata]), ['2026-03-09T03:30:00.000Z']);
});

await test('fields accept steps, lists, names and shorthands', () => {
  const quarter = parseCron('*/15 * * * *');
  assert.deepEqual([...quarter.minute], [0, 15, 30, 45]);
  assert.deepEqual([...parseCron('0 0 1 jan,jul *').month], [1, 7]);
  assert.deepEqual([...parseCron('0 0 * * 7').weekday], [0], 'Seven is Sunday.');
  const monthly = nextFire(parseCron('@monthly'), 'UTC', Date.UTC(2026, 0, 31, 12));
  assert.deepEqual(iso([monthly]), ['2026-02-01T00:00:00.000Z']);
  const nextQuarter = nextFire(quarter, 'UTC', Date.UTC(2026, 0, 1, 0, 15));
  assert.deepEqual(iso([nextQuarter]), ['2026-01-01T00:30:00.000Z']);
});

await test('restricted day of month and weekday match either, as in cron', () => {
  const spec = parseCron('0 12 13 * fri');
  // Thursday 2026-02-12: the next Friday (13th) and the 13th coincide; then Friday the 20th.
  const fires = upcomingFires(spec, 'UTC', Date.UTC(2026, 1, 12), 2);
  assert.deepEqual(iso(fires), ['2026-02-13T12:00:00.000Z', '2026-02-20T12:00:00.000Z']);
});

await test('malformed or impossible schedules are explained or never fire', () => {
  assert.throws(() => parseCron('0 9 * *'), /five fields/v);
  assert.throws(() => parseCron('61 * * * *'), /minute; use 0–59/v);
  assert.throws(() => parseCron('0 9-5 * * *'), /runs backwards/v);
  assert.throws(() => parseCron('*/0 * * * *'), /invalid step/v);
  assert.equal(nextFire(parseCron('0 0 30 feb *'), 'UTC', 0), null);
  assert.equal(isTimeZone('Europe/Berlin'), true);
  assert.equal(isTimeZone('Mars/Olympus'), false);
});
