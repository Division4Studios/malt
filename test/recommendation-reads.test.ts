/** @file Paired recommendation inspection, read receipts, MCP interoperability and restart isolation. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { z } from 'zod/v3';

import { startBroker } from '../src/broker.ts';
import { FactoryRepository } from '../src/factory/repository.ts';
import { Store } from '../src/store.ts';
import { startWebConsole } from '../src/web/server.ts';

import { brokerUrl, createCleanup, createProject, startBridge, toolErrorCode, updateConfig } from './helpers.ts';

/** Current counter projection is separate from the stable page content address. */
const countsSchema = z.object({
  total: z.number(),
  unread: z.number(),
  pending: z.number(),
  awaitingHuman: z.number(),
});
/** A bounded list card, not decision authority or an implicit read receipt. */
const itemSchema = z.object({
  id: z.string(),
  revision: z.string(),
  state: z.string(),
  unread: z.boolean(),
  isSummary: z.literal(true),
});
/** Paged projection used by both paired HTTP and actual MCP. */
const pageSchema = z.object({
  items: z.array(itemSchema),
  counts: countsSchema,
  contentRevision: z.string(),
  nextCursor: z.string().nullable(),
});
/** Two observed native tickets; hostile prose remains JSON data. */
const proposal = {
  kind: 'duplicate' as const,
  tickets: [51, 52],
  action: 'Inspect possible duplicate',
  evidence: ['<script>untrusted()</script>'],
  observedIssues: [
    { issue: 51, revision: 'one' },
    { issue: 52, revision: 'two' },
  ],
  survivor: 51,
  transferredAcceptance: ['Preserve behavior.'],
  transferredDependencies: [],
  affectedAssignments: [],
  preview: { before: 'Two overlapping tickets', after: 'Human-reviewed disposition only' },
};

await test('paired pages and exact read receipts reject foreign scopes and interoperate with real MCP', async (t) => {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  const broker = await startBroker(mesh, { port: 0 });
  defer(async () => broker.close());
  const connected = updateConfig(mesh, { url: brokerUrl(broker.port) });
  const { recommendations: ledger } = new FactoryRepository(broker.store);
  const record = ledger.propose(proposal);
  const web = await startWebConsole(connected, 0);
  defer(async () => web.close());
  const pair = await fetch(`${web.url}/api/pair`, {
    method: 'POST',
    headers: { Origin: web.url, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: web.pairingCode }),
  });
  assert.equal(pair.status, 200);
  const headers = {
    Origin: web.url,
    Cookie: (pair.headers.get('set-cookie') ?? '').split(';', 1)[0] ?? '',
    'Content-Type': 'application/json',
  };
  const url = `${web.url}/api/recommendations?project=home`;
  const response = await fetch(url, { headers });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const before = pageSchema.parse(await response.json());
  assert.deepEqual(before.counts, { total: 1, unread: 1, pending: 1, awaitingHuman: 0 });
  assert.equal(ledger.get(record.id)?.unread, true, 'A GET never marks a proposal read.');
  const detail = await fetch(`${web.url}/api/recommendation?project=home&id=${record.id}`, { headers });
  assert.equal(detail.status, 200);
  assert.match(await detail.text(), /untrusted/v);
  const receipt = { id: record.id, revision: record.revision };
  const readUrl = `${web.url}/api/recommendation/read?project=home`;
  const missingCookie = { Origin: web.url, 'Content-Type': 'application/json' };
  assert.equal(
    (await fetch(readUrl, { method: 'POST', headers: missingCookie, body: JSON.stringify(receipt) })).status,
    401,
  );
  assert.equal(
    (
      await fetch(readUrl, {
        method: 'POST',
        headers: { ...headers, Origin: 'https://hostile.invalid' },
        body: JSON.stringify(receipt),
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(`${web.url}/api/recommendation/read?project=foreign`, {
        method: 'POST',
        headers,
        body: JSON.stringify(receipt),
      })
    ).status,
    403,
  );
  assert.equal(ledger.get(record.id)?.unread, true, 'Rejected read mutations cannot hide the pending proposal.');
  for (const attempt of [1, 2]) {
    const read = await fetch(`${web.url}/api/recommendation/read?project=home`, {
      method: 'POST',
      headers,
      body: JSON.stringify(receipt),
    });
    assert.equal(read.status, 200, String(attempt));
    assert.deepEqual(await read.json(), { ...receipt, unread: false });
  }
  const after = pageSchema.parse(await (await fetch(url, { headers })).json());
  assert.equal(after.counts.unread, 0);
  assert.equal(after.contentRevision, before.contentRevision, 'Read counters cannot invalidate stable page content.');
  assert.equal(ledger.get(record.id)?.audit.length, 1);
  const firstDetail = z
    .object({ contentRevision: z.string() })
    .parse(await ledger.inspect({ kind: 'get', id: record.id }));
  ledger.transition({
    id: record.id,
    revision: record.revision,
    state: 'proposed',
    next: 'awaiting_human',
    reason: 'Fixture review queue',
  });
  const changedDetail = z
    .object({ contentRevision: z.string() })
    .parse(await ledger.inspect({ kind: 'get', id: record.id }));
  assert.notEqual(
    changedDetail.contentRevision,
    firstDetail.contentRevision,
    'Lifecycle changes invalidate detail content.',
  );
  ledger.readReceipt(receipt);
  const readDetail = z
    .object({ contentRevision: z.string() })
    .parse(await ledger.inspect({ kind: 'get', id: record.id }));
  assert.equal(readDetail.contentRevision, changedDetail.contentRevision, 'Read-only counters stay separate.');
  const unknown = '0'.repeat(64);
  assert.equal((await fetch(`${web.url}/api/recommendation?project=home&id=${unknown}`, { headers })).status, 404);
  assert.equal((await fetch(`${web.url}/api/recommendations?project=foreign`, { headers })).status, 403);
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { headers: { ...headers, Origin: 'https://hostile.invalid' } })).status, 403);
  for (const suffix of [
    '',
    '?project=home&project=home',
    '?project=home&limit=21',
    '?project=home&limit=%201',
    '?project=home&kind=get',
  ]) {
    assert.equal((await fetch(`${web.url}/api/recommendations${suffix}`, { headers })).status, 400, suffix);
  }
  const bridge = await startBridge(connected, { name: 'read-observer', role: 'observer' });
  defer(async () => bridge.client.close());
  assert.equal(pageSchema.parse(await bridge.call('mesh_factory_recommendations', { kind: 'list' })).counts.total, 1);
  const forbidden = await bridge.callRaw('mesh_factory_recommendation_read', receipt);
  assert.equal(forbidden.isError, true);
  assert.equal(toolErrorCode(forbidden.payload), 'NOT_ORCHESTRATOR');
});

await test('oversized private proposals remain preserved while list and read receipts stay bounded', (t) => {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  const store = new Store(mesh);
  defer(() => {
    store.close();
  });
  const { recommendations: ledger } = new FactoryRepository(store);
  const large = ledger.propose({ ...proposal, evidence: Array.from({ length: 20 }, () => 'x'.repeat(16_000)) });
  const page = ledger.inspect({ kind: 'list' });
  assert.ok(JSON.stringify(page).length < 20_000, 'List cards do not copy complete private evidence.');
  assert.throws(() => ledger.inspect({ kind: 'get', id: large.id }), { code: 'FACTORY_GATED' });
  assert.equal(ledger.get(large.id)?.body.evidence[0]?.length, 16_000);
  assert.deepEqual(ledger.readReceipt({ id: large.id, revision: large.revision }), {
    id: large.id,
    revision: large.revision,
    unread: false,
  });
  assert.equal(ledger.get(large.id)?.state, 'proposed', 'A read receipt never approves oversized content.');
});

await test('current revision counts, bounded pages and historical reads survive SQLite restart', (t) => {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  let store = new Store(mesh);
  defer(() => {
    store.close();
  });
  let { recommendations: ledger } = new FactoryRepository(store);
  const first = ledger.propose(proposal);
  ledger.transition({
    id: first.id,
    revision: first.revision,
    state: 'proposed',
    next: 'awaiting_human',
    reason: 'Human decision needed.',
  });
  ledger.markRead(first.id, first.revision);
  const other = ledger.propose({
    ...proposal,
    tickets: [61, 62],
    observedIssues: [
      { issue: 61, revision: 'a' },
      { issue: 62, revision: 'b' },
    ],
    survivor: 61,
  });
  store.close();
  store = new Store(mesh);
  const reopenedRepository = new FactoryRepository(store);
  ledger = reopenedRepository.recommendations;
  const page = pageSchema.parse(ledger.inspect({ kind: 'list', limit: 1 }));
  assert.deepEqual(page.counts, { total: 2, unread: 1, pending: 2, awaitingHuman: 1 });
  assert.equal(page.items.length, 1);
  assert.ok(page.nextCursor !== null);
  const final = pageSchema.parse(ledger.inspect({ kind: 'list', limit: 1, after: page.nextCursor }));
  assert.equal(final.items.length, 1);
  assert.notEqual(final.items[0]?.id, page.items[0]?.id);
  assert.equal(final.nextCursor, null);
  const revised = ledger.propose({ ...proposal, evidence: ['Revised evidence.'] });
  assert.throws(() => ledger.readReceipt({ id: first.id, revision: first.revision }), { code: 'FACTORY_GATED' });
  const historical = z
    .object({ recommendation: z.object({ revision: z.string(), state: z.string() }) })
    .parse(ledger.inspect({ kind: 'get', id: first.id, revision: first.revision }));
  assert.equal(historical.recommendation.state, 'stale');
  assert.equal(ledger.get(revised.id)?.unread, true);
  const foreignMesh = createProject(defer);
  const foreignStore = new Store(foreignMesh);
  defer(() => {
    foreignStore.close();
  });
  const { recommendations: foreign } = new FactoryRepository(foreignStore);
  assert.throws(() => foreign.inspect({ kind: 'get', id: other.id }), { code: 'NOT_FOUND' });
  assert.equal(pageSchema.parse(foreign.inspect({ kind: 'list' })).counts.total, 0);
});
