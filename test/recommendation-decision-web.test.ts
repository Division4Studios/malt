/** @file Paired-only recommendation authority and HTTP race fencing. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { startBroker } from '../src/broker.ts';
import { rpc } from '../src/client.ts';
import { GitHubDelivery } from '../src/factory/remote.ts';
import { FactoryRepository } from '../src/factory/repository.ts';
import { factoryConfigSchema } from '../src/factory/schema.ts';
import { ProjectGitHub } from '../src/github.ts';
import { startWebConsole } from '../src/web/server.ts';

import { proposal, readObservation } from './fixtures/recommendations.ts';
import { brokerUrl, createCleanup, createProject, updateConfig } from './helpers.ts';

await test('paired-only HTTP decision capability rejects RPC and foreign scopes; approve/reject races have one winner', async (t) => {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  const remote = new GitHubDelivery(mesh, new ProjectGitHub(mesh));
  remote.observedIssue = readObservation;
  const broker = await startBroker(mesh, { port: 0, factoryOptions: () => ({ remote }) });
  defer(async () => broker.close());
  const connected = updateConfig(mesh, { url: brokerUrl(broker.port) });
  const repository = new FactoryRepository(broker.store);
  repository.configure(
    factoryConfigSchema.parse({
      testCommands: [{ file: process.execPath }],
      endToEndCommands: [{ file: process.execPath }],
    }),
  );
  const record = repository.recommendations.propose(proposal);
  repository.recommendations.transition({
    id: record.id,
    revision: record.revision,
    state: 'proposed',
    next: 'awaiting_human',
    reason: 'Fixture submission',
  });
  const web = await startWebConsole(connected, 0, undefined, { recommendation: broker.operatorRecommendationControl });
  defer(async () => web.close());
  const pair = await fetch(`${web.url}/api/pair`, {
    method: 'POST',
    headers: { Origin: web.url, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: web.pairingCode }),
  });
  const headers = {
    Origin: web.url,
    Cookie: (pair.headers.get('set-cookie') ?? '').split(';', 1)[0] ?? '',
    'Content-Type': 'application/json',
  };
  const request = {
    operationId: randomUUID(),
    id: record.id,
    revision: record.revision,
    decision: 'approve',
    rationale: 'Reviewed exact content',
  };
  const url = `${web.url}/api/recommendation/decide?project=home`;
  const post = async (value: unknown, address = url, supplied = headers): Promise<Response> =>
    fetch(address, { method: 'POST', headers: supplied, body: JSON.stringify(value) });
  assert.equal((await post(request, url, { ...headers, Cookie: '' })).status, 401);
  assert.equal((await post(request, url, { ...headers, Origin: 'https://hostile.invalid' })).status, 403);
  assert.equal((await post(request, `${web.url}/api/recommendation/decide?project=foreign`)).status, 403);
  assert.equal((await post({ ...request, rationale: '' })).status, 400);
  const rpcResult = await fetch(`${connected.url}/rpc`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${mesh.token}`,
      'Content-Type': 'application/json',
      'x-agentmesh-project': mesh.projectId,
    },
    body: JSON.stringify({ operation: 'factory_recommendation_decide', input: request }),
  });
  assert.equal(rpcResult.status, 404, 'No agent or MCP transport can name a decision operation.');
  const race = await Promise.all([post(request), post({ ...request, operationId: randomUUID(), decision: 'reject' })]);
  assert.deepEqual(
    race.map((response) => response.status).toSorted((a, b) => a - b),
    [200, 409],
  );
  assert.ok(['approved', 'rejected'].includes(repository.recommendations.get(record.id)?.state ?? ''));
  assert.equal(repository.effects().length, 0);
  await assert.rejects(rpc(connected, 'factory_recommendations', { kind: 'get', id: '0'.repeat(64) }), {
    code: 'NOT_FOUND',
  });
});
