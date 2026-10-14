/**
 * Native board cursor boundaries and selected-field identity.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readBoard } from '../src/github-board.ts';

await test('board refresh pages within native limits and uses the exact selected workflow field', async () => {
  const requests: Record<string, unknown>[] = [];
  const result = await readBoard({
    project: 'selected-project',
    field: 'selected-field',
    limit: 110,
    graphql: async (_query, variables) => {
      await Promise.resolve();
      requests.push(variables);
      assert.equal(variables['id'], 'selected-project');
      const start = variables['after'] === null ? 0 : 100;
      const length = start === 0 ? 100 : 10;
      return {
        node: {
          items: {
            totalCount: 110,
            pageInfo: { hasNextPage: start === 0, endCursor: String(start + length) },
            nodes: Array.from({ length }, (_, index) => {
              return {
                id: `item-${String(start + index)}`,
                content: {
                  type: 'Issue',
                  number: start + index + 1,
                  title: 'Delivery',
                  body: 'Acceptance',
                  url: 'https://github.com/example/app/issues/1',
                },
                fieldValues: {
                  nodes: [
                    { name: 'Blocked', field: { id: 'unrelated-field', name: 'Status' } },
                    { name: 'Ready', field: { id: 'selected-field', name: 'Status' } },
                  ],
                },
              };
            }),
          },
        },
      };
    },
  });
  assert.equal(result.items.length, 110);
  assert.equal(result.totalCount, 110);
  assert.deepEqual(
    requests.map((request) => request['first']),
    [100, 10],
  );
  assert.equal(result.items[0]?.['mltStatus'], 'Ready');
  assert.ok(result.items.every((item) => item['mltStatus'] === 'Ready'));
});

await test('a nonadvancing native board cursor is rejected rather than polling forever', async () => {
  await assert.rejects(
    readBoard({
      project: 'project',
      field: 'field',
      limit: 100,
      graphql: async () => {
        await Promise.resolve();
        return { node: { items: { totalCount: 1, nodes: [], pageInfo: { hasNextPage: true, endCursor: null } } } };
      },
    }),
    { code: 'GITHUB_UNAVAILABLE' },
  );
});
