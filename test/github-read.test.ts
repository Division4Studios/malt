/** @file Read-only GraphQL helper: classified failures without remote text, and validated data. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { z } from 'zod/v3';

import { dataOf, readGraphQL } from '../src/github-read.ts';
import { MeshError } from '../src/protocol.ts';

import type { GitHubRunner } from '../src/github.ts';

/**
 * A runner that answers every call with one response.
 *
 * @param response - Remote-shaped JSON, or an error to throw.
 * @returns Fixture runner.
 */
function answering(response: unknown): GitHubRunner {
  return async (args) => {
    assert.deepEqual(args, ['api', 'graphql', '--input', '-']);
    if (Error.isError(response)) {
      throw response;
    }
    return await delay(0, response);
  };
}

await test('a query returns its data, validated against the caller schema', async () => {
  const result = await readGraphQL(answering({ data: { viewer: { login: 'octo' } } }), 'query { viewer { login } }');
  const viewer = z.object({ viewer: z.object({ login: z.string() }) });
  const node = z.object({ node: z.object({}) });
  assert.deepEqual(dataOf(result, viewer), { viewer: { login: 'octo' } });
  assert.equal(dataOf(result, node), null, 'a different shape is no data');
});

await test('failures are classified and their remote text is dropped', async () => {
  const secret = 'Authorization: bearer ghp_fixtureSecret';
  const forbidden = await readGraphQL(answering({ errors: [{ type: 'FORBIDDEN', message: secret }] }), 'query { a }');
  assert.deepEqual(forbidden, { failure: 'forbidden' });
  const scopes = await readGraphQL(
    answering({ errors: [{ type: 'INSUFFICIENT_SCOPES', message: secret }] }),
    'query { a }',
  );
  assert.deepEqual(scopes, { failure: 'forbidden' });
  const missing = await readGraphQL(
    answering({ errors: [{ message: "Field 'views' doesn't exist on type 'ProjectV2'" }] }),
    'query { a }',
  );
  assert.deepEqual(missing, { failure: 'unsupported' });
  const thrown = await readGraphQL(answering(new MeshError('GITHUB_UNAVAILABLE', secret)), 'query { a }');
  assert.deepEqual(thrown, { failure: 'unavailable' });
  assert.deepEqual(await readGraphQL(answering('not json'), 'query { a }'), { failure: 'unavailable' });
  assert.deepEqual(await readGraphQL(answering({}), 'query { a }'), { failure: 'unavailable' });
  assert.equal(dataOf(forbidden, z.unknown()), null);
});
