/**
 * DOM-free tests of overview helpers. They import the compiled browser module,
 * so `npm run check` builds web first; a bare `npm test` needs `npm run build:web`.
 *
 * @file
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { objectiveGroups } from '../web/dist/brand-ui.js';

/**
 * Build numbered objectives with one phase.
 *
 * @param prefix - Identifier prefix.
 * @param count - Number of objectives.
 * @param phase - Objective phase.
 * @returns Objective records.
 */
function objectives(prefix: string, count: number, phase: string): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, index) => ({ id: `${prefix}${String(index)}`, phase }));
}

/**
 * Extract identifiers.
 *
 * @param list - Objective records.
 * @returns Identifiers in order.
 */
function ids(list: Record<string, unknown>[]): unknown[] {
  return list.map((item) => item['id']);
}

void test('all 60 unfinished and 20 completed objectives appear once in truthful phase groups', () => {
  const list = [
    ...objectives('q', 10, 'queued'),
    ...objectives('r', 10, 'refining'),
    ...objectives('p', 10, 'provisioning'),
    ...objectives('a', 20, 'active'),
    ...objectives('b', 10, 'blocked'),
    ...objectives('d', 20, 'done'),
    { id: 'old', phase: 'blocked', scopeReplacement: 'new' },
  ];
  const groups = objectiveGroups(list);
  assert.deepEqual(
    groups.map((group) => [group.title, group.items.length]),
    [
      ['Queued', 10],
      ['In progress', 40],
      ['Needs attention', 10],
      ['Completed', 20],
      ['Scope replaced (superseded)', 1],
    ],
  );
  const visible = groups.flatMap((group) => ids(group.items));
  const unique = new Set(visible);
  assert.equal(unique.size, list.length);
  assert.deepEqual(new Set(visible), new Set(ids(list)));
  assert.deepEqual(ids(groups[2]?.items ?? []), ids(objectives('b', 10, 'blocked')));
  assert.deepEqual(ids(groups[3]?.items ?? []), ids(objectives('d', 20, 'done')));
});

void test('empty phase groups have zero counts and replacement wins over completed phase', () => {
  const groups = objectiveGroups([{ id: 'old', phase: 'done', scopeReplacement: 'new' }]);
  assert.deepEqual(
    groups.map((group) => group.items.length),
    [0, 0, 0, 0, 1],
  );
});
