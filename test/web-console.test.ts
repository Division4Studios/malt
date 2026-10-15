/**
 * Real loopback HTTP and broker controls with isolated project-local stores.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { z } from 'zod';

import { startBroker } from '../src/broker.ts';
import { loadConfig } from '../src/config.ts';
import { objectiveQueueSchema } from '../src/factory/objective-queue-schema.ts';
import { FactoryRepository } from '../src/factory/repository.ts';
import { jobSchema, factoryConfigSchema } from '../src/factory/schema.ts';
import { readArtifact } from '../src/web/artifacts.ts';
import { ProjectGateway } from '../src/web/projects.ts';
import { startWebConsole } from '../src/web/server.ts';

import { createCleanup, createProject, brokerUrl } from './helpers.ts';

/** Minimal durable event envelope used to verify native SSE cursor recovery. */
const sequenceSchema = z.object({ seq: z.number() });
/** The backend's bounded event-page boundary. */
const eventPageSchema = z.object({ events: z.array(sequenceSchema), nextCursor: z.number() });
/** One emitted state page. */
const streamPageSchema = z.object({
  events: eventPageSchema,
});
/** Validate the actual factory snapshot fields inspected by controls. */
const factoryViewSchema = z.object({
  features: z.array(z.unknown()),
  active: z.boolean().optional(),
  objectiveQueue: objectiveQueueSchema.optional(),
});
/** Operator snapshot envelope. */
const viewSchema = z.object({ factory: factoryViewSchema });
/** A bounded native artifact response. */
const artifactPageSchema = z.object({ text: z.string(), nextCursor: z.number() });

await test('two local consoles keep independent pairing cookies and reject each other sessions', async (t) => {
  const defer = createCleanup(t);
  const config = createProject(defer);
  const broker = await startBroker(config, { port: 0 });
  defer(async () => broker.close());
  const mesh = { ...config, url: brokerUrl(broker.port) };
  const first = await startWebConsole(mesh, 0);
  const second = await startWebConsole(mesh, 0);
  defer(async () => first.close());
  defer(async () => second.close());
  const pairs = await Promise.all(
    [first, second].map(async (console) => {
      const response = await fetch(`${console.url}/api/pair`, {
        method: 'POST',
        headers: { Origin: console.url, 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: console.pairingCode }),
      });
      assert.equal(response.status, 200);
      return (response.headers.get('set-cookie') ?? '').split(';', 1)[0] ?? '';
    }),
  );
  const firstCookie = pairs[0] ?? '';
  const secondCookie = pairs[1] ?? '';
  assert.notEqual(firstCookie.split('=', 1)[0], secondCookie.split('=', 1)[0]);
  const cookies = `${firstCookie}; ${secondCookie}`;
  assert.equal(
    (await fetch(`${first.url}/api/snapshot?project=home`, { headers: { Origin: first.url, Cookie: cookies } })).status,
    200,
  );
  assert.equal(
    (await fetch(`${second.url}/api/snapshot?project=home`, { headers: { Origin: second.url, Cookie: cookies } }))
      .status,
    200,
  );
  assert.equal(
    (await fetch(`${first.url}/api/snapshot?project=home`, { headers: { Origin: first.url, Cookie: secondCookie } }))
      .status,
    401,
  );
});

await test('actual artifact reads preserve split UTF-8 and reject foreign files and unsafe cursors', async (t) => {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  const broker = await startBroker(mesh, { port: 0 });
  defer(async () => broker.close());
  const config = { ...mesh, url: brokerUrl(broker.port) };
  const repository = new FactoryRepository(broker.store);
  const settings = factoryConfigSchema.parse({
    testCommands: [{ file: process.execPath }],
    endToEndCommands: [{ file: process.execPath }],
  });
  repository.configure(settings);
  const id = randomUUID();
  const artifact = path.join(mesh.directory, 'factory', 'jobs', id);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Create only this disposable managed artifact path.
  await mkdir(artifact, { recursive: true });
  const prefix = 'a'.repeat(65_534);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- The fixed fixture log crosses the actual chunk boundary with a complete Unicode character.
  await writeFile(path.join(artifact, 'stdout.log'), `${prefix}🌌after`);
  const job = jobSchema.parse({
    id,
    role: 'developer-1',
    provider: 'codex',
    kind: 'develop',
    taskId: null,
    featureId: null,
    token: randomUUID(),
    state: 'running',
    startedAt: 1,
    finishedAt: 2,
    expiresAt: 10_000,
    reservation: 0,
    usageTokens: 0,
    pid: null,
    head: null,
    base: null,
    summary: 'Fixture output.',
    artifact,
  });
  assert.equal(repository.claim(job, settings), true);
  assert.equal(repository.finishJob(job, 0, 'succeeded'), true);
  const gateway = new ProjectGateway(config);
  const control = await gateway.control('home', { operation: 'factory_pause', input: {} });
  assert.ok(
    !JSON.stringify(control).includes(job.token),
    'Browser control responses must omit internal claim secrets.',
  );
  const first = artifactPageSchema.parse(await readArtifact(config, { job: id }));
  const next = artifactPageSchema.parse(await readArtifact(config, { job: id, after: first.nextCursor }));
  assert.equal(first.text + next.text, `${prefix}🌌after`);
  await assert.rejects(readArtifact(config, { job: id, after: first.nextCursor + 1 }), { code: 'INVALID_INPUT' });
  await assert.rejects(readArtifact(config, { job: id, file: 'launch.json' }));
  await assert.rejects(readArtifact(config, { job: randomUUID() }), { code: 'NOT_FOUND' });
});

/**
 * Read one actual SSE state frame, then release its owned connection.
 *
 * @param url - Isolated local stream URL.
 * @param headers - Paired session and reconnect cursor.
 * @returns Validated durable event window.
 * @throws {Error} For a missing or oversized stream frame.
 */
async function firstStreamPage(
  url: string,
  headers: Record<string, string>,
): Promise<z.output<typeof streamPageSchema>> {
  const controller = new AbortController();
  const deadline = setTimeout(() => {
    controller.abort();
  }, 10_000);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    assert.equal(response.status, 200);
    assert.ok(response.body !== null);
    return await readStateFrame(response);
  } finally {
    clearTimeout(deadline);
    controller.abort();
  }
}

/**
 * Decode only a bounded native SSE state payload.
 *
 * @param response - Successful streamed response with a nonempty body.
 * @returns Validated state payload.
 * @throws {Error} For missing, oversized or invalid response bytes.
 */
async function readStateFrame(response: Response): Promise<z.output<typeof streamPageSchema>> {
  assert.ok(response.body !== null);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let content = '';
  while (content.length < 262_144) {
    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }
    if (!(chunk.value instanceof Uint8Array)) {
      throw new TypeError('Invalid native SSE byte chunk.');
    }
    content += decoder.decode(chunk.value, { stream: true });
    const frame = content.split('\n\n').find((entry) => entry.includes('event: state\n'));
    const payload = frame?.split('\n').find((line) => line.startsWith('data: '));
    if (payload !== undefined) {
      return streamPageSchema.parse(JSON.parse(payload.slice('data: '.length)));
    }
  }
  throw new Error('Missing bounded SSE state frame.');
}

await test('SSE reconnect resumes every durable event across more than one recent window', async (t) => {
  const defer = createCleanup(t);
  const config = createProject(defer);
  const broker = await startBroker(config, { port: 0 });
  defer(async () => broker.close());
  const console = await startWebConsole({ ...config, url: brokerUrl(broker.port) }, 0);
  defer(async () => console.close());
  for (let index = 0; index < 125; index += 1) {
    broker.store.transaction(() => {
      broker.store.event('STREAM_FIXTURE', null, { index });
    });
  }
  const pair = await fetch(`${console.url}/api/pair`, {
    method: 'POST',
    headers: { Origin: console.url, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: console.pairingCode }),
  });
  assert.equal(pair.status, 200);
  const headers = { Origin: console.url, Cookie: (pair.headers.get('set-cookie') ?? '').split(';', 1)[0] ?? '' };
  const url = `${console.url}/api/stream?project=home`;
  const recent = await firstStreamPage(url, headers);
  assert.equal(recent.events.events.length, 50);
  const observed: number[] = [];
  let cursor = 0;
  while (cursor < recent.events.nextCursor) {
    const page = await firstStreamPage(url, { ...headers, 'Last-Event-ID': String(cursor) });
    assert.ok(page.events.nextCursor > cursor);
    observed.push(...page.events.events.map((event) => event.seq));
    cursor = page.events.nextCursor;
  }
  assert.equal(observed.length, 125);
  assert.deepEqual(
    observed,
    Array.from({ length: 125 }, (_, index) => index + 1),
  );
  const empty = await firstStreamPage(url, { ...headers, 'Last-Event-ID': String(cursor) });
  assert.equal(empty.events.events.length, 0);
  assert.equal(empty.events.nextCursor, cursor);
});

await test('large SSE snapshots drain and retain the same connection for subsequent updates', async (t) => {
  const defer = createCleanup(t);
  const config = createProject(defer);
  const broker = await startBroker(config, { port: 0 });
  defer(async () => broker.close());
  const console = await startWebConsole({ ...config, url: brokerUrl(broker.port) }, 0);
  defer(async () => console.close());
  broker.store.transaction(() => {
    broker.store.event('LARGE_STREAM_FIXTURE', null, { evidence: 'x'.repeat(40_000) });
  });
  const pair = await fetch(`${console.url}/api/pair`, {
    method: 'POST',
    headers: { Origin: console.url, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: console.pairingCode }),
  });
  assert.equal(pair.status, 200);
  const controller = new AbortController();
  const deadline = setTimeout(() => {
    controller.abort();
  }, 10_000);
  try {
    const response = await fetch(`${console.url}/api/stream?project=home`, {
      headers: { Origin: console.url, Cookie: (pair.headers.get('set-cookie') ?? '').split(';', 1)[0] ?? '' },
      signal: controller.signal,
    });
    await assertSustainedStream(response);
  } finally {
    clearTimeout(deadline);
    controller.abort();
  }
});

/**
 * Verify oversized first frames do not close a real subscriber connection.
 *
 * @param response - Paired native SSE response.
 */
async function assertSustainedStream(response: Response): Promise<void> {
  assert.equal(response.status, 200);
  assert.ok(response.body !== null);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let content = '';
  while (content.split('event: state\n').length < 3 && content.length < 262_144) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false, 'A large first snapshot must not terminate its live stream.');
    if (!(chunk.value instanceof Uint8Array)) {
      throw new TypeError('Invalid native SSE byte chunk.');
    }
    content += decoder.decode(chunk.value, { stream: true });
  }
  assert.ok(content.length > 16_384, 'The test must exceed the socket high-water mark.');
  assert.equal(content.split('event: state\n').length, 3);
}

/**
 * Preserve a hostile Host header that native fetch normalizes away.
 *
 * @param url - Owned loopback service.
 * @returns Actual raw HTTP response status.
 */
async function hostileHostStatus(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { headers: { Host: 'hostile.invalid' } }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.once('error', reject);
    request.end();
  });
}

await test('paired browser controls persist objectives, isolate projects and reject hostile origins', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mlt-web-test-'));
  const target = mkdtempSync(path.join(os.tmpdir(), 'mlt-web-target-'));
  const initial = loadConfig(root, { create: true });
  const broker = await startBroker(initial, { port: 0 });
  const mesh = { ...initial, url: `http://127.0.0.1:${String(broker.port)}` };
  const console = await startWebConsole(mesh, 0);
  t.after(async () => {
    await console.close();
    await broker.close();
  });
  const { url } = console;
  const shell = await fetch(url, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(shell.status, 200);
  assert.match(shell.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/v);
  assert.equal((await fetch(`${url}/api/snapshot?project=home`)).status, 401);
  const badPair = await fetch(`${url}/api/pair`, {
    method: 'POST',
    headers: { Origin: 'https://hostile.invalid', 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: console.pairingCode }),
  });
  assert.equal(badPair.status, 403);
  const pair = await fetch(`${url}/api/pair`, {
    method: 'POST',
    headers: { Origin: url, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: console.pairingCode }),
  });
  assert.equal(pair.status, 200);
  const cookie = pair.headers.get('set-cookie') ?? '';
  assert.match(cookie, /HttpOnly; SameSite=Strict/v);
  const headers = { Origin: url, Cookie: cookie.split(';', 1)[0] ?? '', 'Content-Type': 'application/json' };
  const mutation = await fetch(`${url}/api/control?project=home`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      operation: 'factory_request',
      input: { objective: 'Verify the durable operator control.' },
    }),
  });
  assert.equal(mutation.status, 200);
  const view = await fetch(`${url}/api/snapshot?project=home`, { headers });
  assert.equal(view.headers.get('cache-control'), 'no-store');
  const snapshot = viewSchema.parse(await view.json());
  assert.equal(snapshot.factory.features.length, 1);
  assert.equal(snapshot.factory.active, false);
  const queue = snapshot.factory.objectiveQueue;
  assert.ok(queue !== undefined);
  const focusedFeatureId = queue.order[0];
  assert.ok(focusedFeatureId !== undefined);
  const queueBody = JSON.stringify({
    operation: 'factory_queue',
    input: { order: queue.order, expectedRevision: queue.revision, focusedFeatureId },
  });
  const reorder = await fetch(`${url}/api/control?project=home`, { method: 'POST', headers, body: queueBody });
  assert.equal(reorder.status, 200);
  const queuedView = viewSchema.parse(await (await fetch(`${url}/api/snapshot?project=home`, { headers })).json());
  assert.equal(queuedView.factory.objectiveQueue?.focusedFeatureId, focusedFeatureId);
  const stale = await fetch(`${url}/api/control?project=home`, { method: 'POST', headers, body: queueBody });
  assert.equal(stale.status, 400);

  const opened = await fetch(`${url}/api/projects`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ workspace: target }),
  });
  const project = z.object({ id: z.string() }).parse(await opened.json());
  const other = await fetch(`${url}/api/snapshot?project=${encodeURIComponent(project.id)}`, { headers });
  const isolated = viewSchema.parse(await other.json());
  assert.equal(isolated.factory.features.length, 0);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Verify only this test's known target database path.
  assert.ok(existsSync(path.join(target, '.malt', 'state', 'mesh.db')));
  const hostile = await fetch(`${url}/api/control?project=home`, {
    method: 'POST',
    headers: { ...headers, Origin: 'https://hostile.invalid' },
    body: JSON.stringify({ operation: 'factory_pause', input: {} }),
  });
  assert.equal(hostile.status, 403);
  const crossSite = await fetch(`${url}/api/snapshot?project=home`, {
    headers: { ...headers, 'Sec-Fetch-Site': 'cross-site' },
  });
  assert.equal(crossSite.status, 403);
  assert.equal(await hostileHostStatus(`${url}/`), 403);
  const privateState = await fetch(`${url}/api/snapshot?project=home`, { headers });
  const body = await privateState.text();
  assert.ok(!body.includes(mesh.token));
  const instruction = {
    operation: 'factory_instruct',
    input: { requestId: randomUUID(), role: 'product-owner', body: 'Revise the acceptance boundary.', replan: true },
  };
  const firstInstruction = await fetch(`${url}/api/control?project=home`, {
    method: 'POST',
    headers,
    body: JSON.stringify(instruction),
  });
  assert.equal(firstInstruction.status, 200);
  const committed = await firstInstruction.json();
  const beforeRetry = await firstStreamPage(`${url}/api/stream?project=home`, headers);
  const repeated = await fetch(`${url}/api/control?project=home`, {
    method: 'POST',
    headers,
    body: JSON.stringify(instruction),
  });
  assert.equal(repeated.status, 200);
  assert.deepEqual(await repeated.json(), committed);
  const afterRetry = await firstStreamPage(`${url}/api/stream?project=home`, headers);
  assert.equal(
    afterRetry.events.nextCursor,
    beforeRetry.events.nextCursor,
    'Retry must not repeat scope fencing or notifications.',
  );
  const changed = await fetch(`${url}/api/control?project=home`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...instruction, input: { ...instruction.input, body: 'Different scope.' } }),
  });
  assert.equal(changed.status, 400);
  const logout = await fetch(`${url}/api/logout`, { method: 'POST', headers, body: '{}' });
  assert.equal(logout.status, 200);
  assert.equal((await fetch(`${url}/api/snapshot?project=home`, { headers })).status, 401);
});

/** One served event with its decoded payload. */
const historyEventSchema = z.object({ seq: z.number(), type: z.string(), data: z.record(z.unknown()) });
/** One backward history page as served to the browser. */
const historySchema = z
  .object({
    project: z.string(),
    events: z.array(historyEventSchema),
    hasMore: z.boolean(),
    oldestCursor: z.number(),
  })
  .strict();
/** A validated backward history page. */
type History = z.output<typeof historySchema>;

/**
 * Pair a fresh browser session with an isolated console.
 *
 * @param url - Owned loopback console.
 * @param code - Its pairing code.
 * @returns Same-origin session headers.
 */
async function pairBrowser(url: string, code: string): Promise<Record<string, string>> {
  const pair = await fetch(`${url}/api/pair`, {
    method: 'POST',
    headers: { Origin: url, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  assert.equal(pair.status, 200);
  return { Origin: url, Cookie: (pair.headers.get('set-cookie') ?? '').split(';', 1)[0] ?? '' };
}

/**
 * Read one validated backward page through the authenticated route.
 *
 * @param url - Owned loopback console.
 * @param headers - Paired session.
 * @param query - Exact history query string.
 * @returns The validated page.
 */
async function historyPage(url: string, headers: Record<string, string>, query: string): Promise<History> {
  const response = await fetch(`${url}/api/history?${query}`, { headers });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-type') ?? '', /^application\/json/v);
  return historySchema.parse(await response.json());
}

/**
 * Walk every older page from an exclusive cursor to the beginning.
 *
 * @param read - Reads one page for a cursor.
 * @param before - Initial exclusive cursor.
 * @returns Pages in traversal order, ending with one extra empty request.
 */
async function walkHistory(read: (before: number) => Promise<History>, before: number): Promise<History[]> {
  const pages = [await read(before)];
  while (pages.at(-1)?.hasMore === true) {
    pages.push(await read(pages.at(-1)?.oldestCursor ?? 0));
  }
  pages.push(await read(pages.at(-1)?.oldestCursor ?? 0));
  return pages;
}

/**
 * Summarize page boundaries for exact comparison.
 *
 * @param pages - Traversed pages.
 * @returns Size, lookahead and cursor of each page.
 */
function boundaries(pages: History[]): [number, boolean, number][] {
  return pages.map((page) => [page.events.length, page.hasMore, page.oldestCursor]);
}

await test('backward history pages reach the beginning without shifting or moving the stream cursor', async (t) => {
  const defer = createCleanup(t);
  const config = createProject(defer);
  const broker = await startBroker(config, { port: 0 });
  defer(async () => broker.close());
  const console = await startWebConsole({ ...config, url: brokerUrl(broker.port) }, 0);
  defer(async () => console.close());
  const headers = await pairBrowser(console.url, console.pairingCode);
  const read = async (before: number, limit = 30): Promise<History> =>
    historyPage(console.url, headers, `project=home&before=${String(before)}&limit=${String(limit)}`);
  const top = Number.MAX_SAFE_INTEGER;
  assert.deepEqual(await read(top), { project: 'home', events: [], hasMore: false, oldestCursor: top });
  assert.deepEqual(await read(0), { project: 'home', events: [], hasMore: false, oldestCursor: 0 });
  const hostile = '</script><script>alert(1)</script>\0"\\<img src=x onerror=1>';
  for (let index = 0; index < 125; index += 1) {
    broker.store.transaction(() => {
      broker.store.event('HISTORY_FIXTURE', null, { index, text: hostile });
    });
  }
  const recent = await firstStreamPage(`${console.url}/api/stream?project=home`, headers);
  const oldestShown = recent.events.events[0]?.seq ?? 0;
  assert.equal(oldestShown, 76);
  const first = await read(oldestShown);
  assert.deepEqual(
    first.events.map((event) => event.seq),
    Array.from({ length: 30 }, (_, index) => index + 46),
  );
  assert.equal(first.events[0]?.data['text'], hostile, 'Hostile event text must remain verbatim JSON data.');
  for (let index = 0; index < 5; index += 1) {
    broker.store.transaction(() => {
      broker.store.event('HISTORY_LIVE', null, { index });
    });
  }
  assert.deepEqual(await read(oldestShown), first, 'Appended events must not shift an older page.');
  const partial = await walkHistory(read, oldestShown);
  assert.deepEqual(boundaries(partial), [
    [30, true, 46],
    [30, true, 16],
    [15, false, 1],
    [0, false, 1],
  ]);
  const seqs = partial.flatMap((page) => page.events.map((event) => event.seq));
  assert.deepEqual(
    seqs.toSorted((left, right) => left - right),
    Array.from({ length: 75 }, (_, index) => index + 1),
    'Backward pages must neither skip nor duplicate events.',
  );
  for (const page of partial) {
    const order = page.events.map((event) => event.seq);
    assert.deepEqual(
      order,
      order.toSorted((left, right) => left - right),
    );
  }
  assert.deepEqual(boundaries(await walkHistory(async (before) => read(before, 25), oldestShown)), [
    [25, true, 51],
    [25, true, 26],
    [25, false, 1],
    [0, false, 1],
  ]);
  const resumed = await firstStreamPage(`${console.url}/api/stream?project=home`, {
    ...headers,
    'Last-Event-ID': String(recent.events.nextCursor),
  });
  assert.deepEqual(
    resumed.events.events.map((event) => event.seq),
    [126, 127, 128, 129, 130],
    'Backward reads must not move the live stream cursor.',
  );
  const legacy = broker.store.execute('events', { after: 0, limit: 50, recent: true }, null);
  assert.ok('nextCursor' in legacy && legacy.nextCursor === 130);
});

await test('history rejects malformed, ambiguous, unauthorized and mutating requests', async (t) => {
  const defer = createCleanup(t);
  const config = createProject(defer);
  const broker = await startBroker(config, { port: 0 });
  defer(async () => broker.close());
  const console = await startWebConsole({ ...config, url: brokerUrl(broker.port) }, 0);
  defer(async () => console.close());
  broker.store.transaction(() => {
    broker.store.event('HISTORY_FIXTURE', null, {});
  });
  const headers = await pairBrowser(console.url, console.pairingCode);
  const status = async (query: string, init: RequestInit = {}): Promise<number> =>
    (await fetch(`${console.url}/api/history?${query}`, { headers, ...init })).status;
  for (const query of [
    'before=5',
    'project=home',
    'project=&before=5',
    'project=home&before=-1',
    'project=home&before=1.5',
    'project=home&before=1e2',
    'project=home&before=',
    'project=home&before=%205',
    'project=home&before=abc',
    'project=home&before=9007199254740993',
    'project=home&before=5&limit=0',
    'project=home&before=5&limit=101',
    'project=home&before=5&limit=x',
    'project=home&before=5&before=6',
    'project=home&project=home&before=5',
    'project=home&before=5&after=0',
    'project=home&before=5&recent=true',
  ]) {
    assert.equal(await status(query), 400, query);
  }
  const unknown = await fetch(`${console.url}/api/history?project=missing&before=5`, { headers });
  assert.equal(unknown.status, 403);
  assert.match(z.object({ error: z.string() }).parse(await unknown.json()).error, /Select an available project/v);
  assert.equal(await status('project=home&before=5', { headers: { Origin: console.url } }), 401);
  for (const hostile of [{ Origin: 'https://hostile.invalid' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    assert.equal(await status('project=home&before=5', { headers: { ...headers, ...hostile } }), 403);
  }
  const before = broker.store.execute('events', { after: 0, limit: 100 }, null);
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const init = { method, headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}' };
    assert.notEqual(await status('project=home&before=5', init), 200, method);
  }
  assert.deepEqual(broker.store.execute('events', { after: 0, limit: 100 }, null), before);
  for (const input of [
    { before: 5, after: 0, limit: 10 },
    { before: 5, recent: false, limit: 10 },
    { before: 5, limit: 101 },
    { before: 2 ** 53, limit: 10 },
    { before: -1, limit: 10 },
  ]) {
    assert.throws(() => broker.store.execute('events', input, null), { code: 'INVALID_INPUT' });
  }
});

await test('two projects with overlapping sequence numbers keep separate backward histories', async (t) => {
  const defer = createCleanup(t);
  const config = createProject(defer);
  const target = mkdtempSync(path.join(os.tmpdir(), 'mlt-history-target-'));
  defer(() => {
    rmSync(target, { recursive: true, force: true });
  });
  const broker = await startBroker(config, { port: 0 });
  defer(async () => broker.close());
  const console = await startWebConsole({ ...config, url: brokerUrl(broker.port) }, 0);
  defer(async () => console.close());
  const headers = await pairBrowser(console.url, console.pairingCode);
  const opened = await fetch(`${console.url}/api/projects`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspace: target }),
  });
  const other = z.object({ id: z.string() }).parse(await opened.json()).id;
  const team = broker.teams.get(other);
  assert.ok(team !== undefined);
  for (let index = 0; index < 40; index += 1) {
    for (const [store, owner] of [
      [broker.store, 'home'],
      [team.store, other],
    ] as const) {
      store.transaction(() => {
        store.event('HISTORY_OWNER', null, { owner });
      });
    }
  }
  const sequences = new Map<string, Set<number>>();
  for (const project of ['home', other]) {
    const query = (before: number): string =>
      `project=${encodeURIComponent(project)}&before=${String(before)}&limit=15`;
    const pages = await walkHistory(
      async (before) => historyPage(console.url, headers, query(before)),
      Number.MAX_SAFE_INTEGER,
    );
    assert.ok(pages.length >= 4 && pages.at(-1)?.events.length === 0);
    assert.ok(pages.every((page) => page.project === project));
    const events = pages.flatMap((page) => page.events);
    const owners = events.filter((event) => event.type === 'HISTORY_OWNER').map((event) => event.data['owner']);
    assert.deepEqual(
      owners,
      Array.from({ length: 40 }, () => (project === 'home' ? 'home' : other)),
    );
    sequences.set(project, new Set(events.map((event) => event.seq)));
  }
  const home = sequences.get('home') ?? new Set();
  assert.ok(
    [...(sequences.get(other) ?? [])].some((seq) => home.has(seq)),
    'The fixture must exercise overlapping project sequence numbers.',
  );
});
