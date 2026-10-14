/**
 * DOM-free tests of overview helpers. They import the compiled browser module,
 * so `npm run check` builds web first; a bare `npm test` needs `npm run build:web`.
 *
 * @file
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { objectivePreview } from '../web/dist/brand-ui.js';

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

void test('older pending objectives stay ahead of the last completed ones', () => {
  const list = [...objectives('d', 8, 'done'), ...objectives('p', 9, 'active')];
  const result = ids(objectivePreview(list, 4));
  assert.deepEqual(result.slice(0, 9), ['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8']);
  assert.deepEqual(result.slice(9), ['d4', 'd5', 'd6', 'd7']);
});

void test('pending objectives are bounded to fifty', () => {
  assert.equal(objectivePreview(objectives('p', 100, 'queued'), 4).length, 50);
});

void test('scope-replaced objectives are not pending', () => {
  const list = [{ id: 'old', phase: 'blocked', scopeReplacement: { by: 'x' } }, ...objectives('p', 1, 'active')];
  assert.deepEqual(ids(objectivePreview(list, 4)), ['p0']);
});
