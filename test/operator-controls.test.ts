/**
 * Explicit browser controls are single-flight, project-fenced and never replayed.
 *
 * @file
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createOperatorControl } from '../web/src/api.ts';

await test('double clicks send once and late success cannot report into another project', async (t) => {
  const response = Promise.withResolvers<Response>();
  const requests: unknown[] = [];
  t.mock.method(globalThis, 'fetch', async (url: unknown) => {
    requests.push(url);
    return response.promise;
  });
  let project = 'first';
  let refreshes = 0;
  const notices: string[] = [];
  const control = createOperatorControl({
    scope: () => ({ project, isReady: true }),
    openProject: () => {
      assert.fail('Unexpected project selection');
    },
    refresh: async () => {
      await Promise.resolve();
      refreshes += 1;
    },
    notice: (message) => {
      notices.push(message);
    },
  });
  const pending = control('factory_queue', { order: ['a'] });
  await control('factory_queue', { order: ['a'] });
  assert.deepEqual(requests, ['/api/control?project=first']);
  project = 'second';
  response.resolve(new Response('{}'));
  await pending;
  assert.deepEqual(notices, []);
  assert.equal(refreshes, 0);
  await control('factory_queue', { order: ['b'] });
  assert.deepEqual(requests, ['/api/control?project=first', '/api/control?project=second']);
  assert.equal(refreshes, 1);
});

await test('offline controls never queue; a stale revision refreshes without retrying the mutation', async (t) => {
  let requests = 0;
  let refreshes = 0;
  let isReady = false;
  const notices: string[] = [];
  t.mock.method(globalThis, 'fetch', async () => {
    await Promise.resolve();
    requests += 1;
    return Response.json({ error: 'Queue changed; refresh' }, { status: 400 });
  });
  const control = createOperatorControl({
    scope: () => ({ project: 'one', isReady }),
    openProject: () => {
      assert.fail('Unexpected project selection');
    },
    refresh: async () => {
      await Promise.resolve();
      refreshes += 1;
    },
    notice: (message) => {
      notices.push(message);
    },
  });
  await control('factory_queue', {});
  isReady = true;
  assert.equal(requests, 0);
  await control('factory_queue', {});
  assert.equal(requests, 1);
  assert.equal(refreshes, 1);
  assert.deepEqual(notices, ['Queue changed; refresh']);
});

await test('late failure is fenced and explicit project selection uses its scoped handler', async (t) => {
  const response = Promise.withResolvers<Response>();
  let requests = 0;
  let project = 'one';
  t.mock.method(globalThis, 'fetch', async () => {
    requests += 1;
    return response.promise;
  });
  const control = createOperatorControl({
    scope: () => ({ project, isReady: true }),
    openProject: async (workspace) => {
      await Promise.resolve();
      project = workspace;
    },
    refresh: () => {
      assert.fail('A previous project must not refresh the new project');
    },
    notice: () => {
      assert.fail('A previous project must not send feedback to the new project');
    },
  });
  const pending = control('factory_queue', {});
  project = 'two';
  response.resolve(Response.json({ error: 'Old failure' }, { status: 400 }));
  await pending;
  await control('open-project', 'three');
  assert.equal(project, 'three');
  assert.equal(requests, 1);
});
