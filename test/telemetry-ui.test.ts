/**
 * DOM-free tests of the sessions and costs view helpers. They import the
 * compiled browser modules, so `npm run check` builds web first.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { JOB_KINDS } from '../src/factory/seats.ts';
import { validatePrices } from '../web/dist/price-editor.js';
import {
  ATTEMPT_KINDS,
  formatCost,
  formatDuration,
  formatTokens,
  formatUsd,
  groupByDay,
  stackBars,
} from '../web/dist/telemetry-format.js';

void test('the attempt kind filter lists exactly the broker kinds, each with a label', () => {
  assert.deepEqual(Object.keys(ATTEMPT_KINDS), [...JOB_KINDS]);
  for (const label of Object.values(ATTEMPT_KINDS)) {
    assert.ok(label.length > 0);
  }
});

void test('formatting keeps unknown values distinct from zero', () => {
  assert.equal(formatUsd(null), 'unpriced');
  assert.equal(formatUsd(0), '$0.00');
  assert.equal(formatUsd(0.0042), '$0.0042');
  assert.equal(formatCost(1.5, 'estimated'), '~$1.50');
  assert.equal(formatCost(1.5, 'reported'), '$1.50');
  assert.equal(formatCost(null, 'unpriced'), 'unpriced');
  assert.equal(formatTokens(null), '—');
  assert.equal(formatTokens(950), '950');
  assert.equal(formatTokens(12_400), '12.4k');
  assert.equal(formatTokens(3_100_000), '3.1M');
  assert.equal(formatDuration(42_000), '42s');
  assert.equal(formatDuration(185_000), '3m 05s');
  assert.equal(formatDuration(3_720_000), '1h 02m');
});

void test('rows group by calendar day in the viewer zone across a DST change', () => {
  const rows = [
    { id: 'c', startedAt: Date.UTC(2026, 2, 9, 3, 30) },
    { id: 'b', startedAt: Date.UTC(2026, 2, 8, 5, 30) },
    { id: 'a', startedAt: Date.UTC(2026, 2, 8, 4, 30) },
  ];
  assert.deepEqual(
    groupByDay(rows, 'America/New_York').map((group) => [group.day, group.rows.map((row) => row.id)]),
    [
      ['2026-03-08', ['c', 'b']],
      ['2026-03-07', ['a']],
    ],
  );
});

void test('stacked bars keep fixed role order and fold specialist seats into Other', () => {
  const { bars, series, max } = stackBars(
    [
      { day: '2026-03-08', totalUsd: 4, byRole: { 'qa-1': 1, 'product-owner': 2, fixer: 0.5, librarian: 0.5 } },
      { day: '2026-03-09', totalUsd: 0, byRole: {} },
    ],
    100,
    2,
  );
  assert.equal(max, 4);
  assert.deepEqual(series, ['product-owner', 'qa-1', 'other']);
  const [first, second] = bars;
  assert.ok(first !== undefined && second !== undefined);
  assert.deepEqual(
    first.segments.map((segment) => [segment.series, segment.value]),
    [
      ['product-owner', 2],
      ['qa-1', 1],
      ['other', 1],
    ],
  );
  assert.equal(first.segments[0]?.y, 100 - 48);
  assert.deepEqual(second.segments, []);
});

void test('price rows require a model and four non-negative prices, without duplicates', () => {
  const row = { model: 'm', input: '3', cachedInput: '0.3', cacheWrite: '3.75', output: '15' };
  assert.deepEqual(validatePrices([row, { model: '', input: '', cachedInput: '', cacheWrite: '', output: '' }]), {
    prices: [{ model: 'm', input: 3, cachedInput: 0.3, cacheWrite: 3.75, output: 15 }],
  });
  assert.ok('error' in validatePrices([{ ...row, output: '-1' }]));
  assert.ok('error' in validatePrices([{ ...row, input: '1e3' }]));
  assert.ok('error' in validatePrices([{ ...row, model: '' }]));
  assert.ok('error' in validatePrices([row, row]));
});
