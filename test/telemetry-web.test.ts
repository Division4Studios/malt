/**
 * Read-only telemetry routes through the paired console and the broker:
 * attempt listings, transcripts and costs, strict query validation, and the
 * revision-fenced price control.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { z } from 'zod/v3';

import { startBroker } from '../src/broker.ts';
import { run } from '../src/database.ts';
import { jobSchema } from '../src/factory/schema.ts';
import { attemptPageSchema, costSummarySchema, transcriptPageSchema } from '../src/factory/telemetry-schema.ts';
import { startWebConsole } from '../src/web/server.ts';

import { brokerUrl, createCleanup, createProject } from './helpers.ts';

/**
 * Pair a browser session with the local console.
 *
 * @param url - Console origin.
 * @param code - Pairing code.
 * @returns Headers carrying the paired session.
 */
async function pair(url: string, code: string): Promise<Record<string, string>> {
  const response = await fetch(`${url}/api/pair`, {
    method: 'POST',
    headers: { Origin: url, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  assert.equal(response.status, 200);
  return {
    Origin: url,
    Cookie: (response.headers.get('set-cookie') ?? '').split(';', 1)[0] ?? '',
    Connection: 'close',
  };
}

await test('telemetry routes read attempts, transcripts and costs with strict queries', async (t) => {
  const defer = createCleanup(t);
  const config = createProject(defer);
  const broker = await startBroker(config, { port: 0 });
  defer(async () => broker.close());
  const web = await startWebConsole({ ...config, url: brokerUrl(broker.port) }, 0);
  defer(async () => web.close());
  const headers = await pair(web.url, web.pairingCode);
  const id = randomUUID();
  const artifact = path.join(config.directory, 'factory', 'jobs', id);
  const job = jobSchema.parse({
    id,
    role: 'qa-1',
    provider: 'claude',
    kind: 'review',
    taskId: null,
    featureId: null,
    token: randomUUID(),
    state: 'succeeded',
    startedAt: Date.now() - 5000,
    finishedAt: Date.now() - 1000,
    expiresAt: 0,
    reservation: 0,
    usageTokens: null,
    pid: null,
    head: null,
    base: null,
    summary: 'Reviewed the change.',
    artifact,
    step: null,
  });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- The artifact is inside the test's own project.
  mkdirSync(artifact, { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- The artifact is inside the test's own project.
  writeFileSync(
    path.join(artifact, 'stdout.log'),
    [
      { type: 'assistant', message: { content: [{ type: 'text', text: '<b>not html</b>' }] } },
      { type: 'result', is_error: false, result: 'ok', total_cost_usd: 0.5, num_turns: 1 },
    ]
      .map((event) => JSON.stringify(event))
      .join('\n'),
  );
  run(broker.store.db, 'INSERT INTO factory_jobs VALUES(?,?,?,?)', job.id, job.role, job.state, JSON.stringify(job));

  /**
   * Fetch one route, with the paired session unless other headers are given.
   *
   * @param route - Path and query.
   * @param requestHeaders - Optional replacement headers.
   * @returns HTTP response.
   */
  const get = async (route: string, requestHeaders?: Record<string, string>): Promise<Response> =>
    await fetch(`${web.url}${route}`, { headers: requestHeaders ?? headers });
  const attempts = await get('/api/attempts?project=home&role=qa-1&limit=10');
  assert.equal(attempts.status, 200);
  assert.equal(attempts.headers.get('cache-control'), 'no-store');
  const page = attemptPageSchema.parse(await attempts.json());
  assert.deepEqual(
    page.attempts.map((row) => [row.id, row.metrics.cost.source, row.metrics.cost.usd]),
    [[id, 'reported', 0.5]],
  );
  const transcript = transcriptPageSchema.parse(await (await get(`/api/transcript?project=home&job=${id}`)).json());
  assert.equal(transcript.nodes[0]?.text, '<b>not html</b>');
  const costs = costSummarySchema.parse(
    await (await get('/api/costs?project=home&days=30&timeZone=Europe%2FBerlin')).json(),
  );
  assert.equal(costs.totals.costUsd, 0.5);
  assert.equal(costs.prices.revision, 0);

  for (const route of [
    '/api/attempts',
    '/api/attempts?project=home&limit=0',
    '/api/attempts?project=home&limit=101',
    '/api/attempts?project=home&limit=x',
    '/api/attempts?project=home&role=bogus',
    '/api/attempts?project=home&since=-1',
    '/api/attempts?project=home&cursor=bad',
    '/api/attempts?project=home&unknown=1',
    '/api/attempts?project=home&role=qa-1&role=qa-2',
    '/api/transcript?project=home',
    '/api/transcript?project=home&job=not-a-uuid',
    `/api/transcript?project=home&job=${id}&cursor=1.5`,
    `/api/transcript?project=home&job=${id}&limit=501`,
    '/api/costs?project=home&days=3',
    '/api/costs?project=home&timeZone=Mars%2FOlympus',
    '/api/costs?project=home&days=7&days=30',
  ]) {
    assert.equal((await get(route)).status, 400, route);
  }
  assert.equal((await get(`/api/transcript?project=home&job=${randomUUID()}`)).status, 404);
  assert.equal((await get('/api/attempts?project=missing')).status, 403);
  assert.equal((await get('/api/nothing-here?project=home')).status, 404);
  assert.equal((await get('/api/costs?project=home', { Origin: web.url })).status, 401);

  /**
   * Save prices through the operator control path.
   *
   * @param input - Price list and the revision the editor loaded.
   * @returns HTTP status.
   */
  const savePrices = async (input: unknown): Promise<number> => {
    const response = await fetch(`${web.url}/api/control?project=home`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        operation: 'factory_prices',
        input,
      }),
    });
    return response.status;
  };
  const prices = [{ model: 'claude-fixture', input: 3, cachedInput: 0.3, cacheWrite: 3.75, output: 15 }];
  assert.equal(await savePrices({ prices, expectedRevision: 0 }), 200);
  assert.equal(await savePrices({ prices, expectedRevision: 0 }), 400, 'A stale editor revision is rejected.');
  assert.equal(await savePrices({ prices: [{ model: 'x' }], expectedRevision: 1 }), 400);
  const saved = z
    .object({ prices: z.object({ revision: z.number() }) })
    .parse(await (await get('/api/costs?project=home')).json());
  assert.equal(saved.prices.revision, 1);
});
