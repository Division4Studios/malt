/**
 * The service worker caches only the public shell from one revision, installs
 * it past the HTTP cache, answers offline only from its own revision, keeps an
 * offline-loaded window on that revision, and never touches API traffic; the
 * console sends shell assets `no-cache` and every API response `no-store`.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import vm from 'node:vm';

import { startBroker } from '../src/broker.ts';
import { startWebConsole } from '../src/web/server.ts';

import { brokerUrl, createCleanup, createProject } from './helpers.ts';

/** Origin the worker believes it serves. */
const ORIGIN = 'http://127.0.0.1:4318';
/** Compiled worker, built by `npm run build:web`. */
const WORKER = await readFile('web/dist/sw.js', 'utf8');

/** A `Request` that resolves relative URLs against the worker origin, as a real worker does. */
class WorkerRequest extends Request {
  /**
   * Resolve a relative shell path.
   *
   * @param input - URL or path.
   * @param init - Request options.
   */
  public constructor(input: string, init?: RequestInit) {
    super(new URL(input, ORIGIN), init);
  }
}

/** One loaded worker with its fake platform. */
interface Worker {
  /** Registered event listeners. */
  readonly listeners: Map<string, (event: object) => void>;
  /** Cache storage: cache name → path → body. */
  readonly stores: Map<string, Map<string, string>>;
  /** Requests the worker sent to the network, with their cache mode. */
  readonly fetched: { path: string; cache: string }[];
  /** Whether the network answers. */
  isOnline: boolean;
}

/**
 * The path of a request.
 *
 * @param input - Request.
 * @returns Its URL path.
 */
function pathOf(input: Request): string {
  const url = new URL(input.url);
  return url.pathname;
}

/**
 * Load the compiled worker into an isolated context with fake caches and network.
 *
 * @returns The worker and its platform.
 */
function loadWorker(): Worker {
  const worker: Worker = { listeners: new Map(), stores: new Map(), fetched: [], isOnline: true };
  const cacheFor = (name: string): Map<string, string> => {
    const existing = worker.stores.get(name) ?? new Map<string, string>();
    worker.stores.set(name, existing);
    return existing;
  };
  const network = async (input: Request): Promise<Response> => {
    worker.fetched.push({ path: pathOf(input), cache: input.cache });
    return worker.isOnline
      ? Promise.resolve(new Response(`network ${pathOf(input)}`))
      : Promise.reject(new TypeError('offline'));
  };
  const caches = {
    open: async (name: string) => {
      await tick();
      const store = cacheFor(name);
      return {
        addAll: async (requests: readonly Request[]) => {
          const bodies = await Promise.all(requests.map(async (entry) => (await network(entry)).text()));
          for (const [index, entry] of requests.entries()) {
            store.set(pathOf(entry), bodies[index] ?? '');
          }
        },
        match: async (input: Request) => {
          await tick();
          const body = store.get(pathOf(input));
          return body === undefined ? undefined : new Response(body);
        },
      };
    },
    keys: async () => {
      await tick();
      return worker.stores.keys().toArray();
    },
    delete: async (name: string) => {
      await tick();
      return worker.stores.delete(name);
    },
  };
  // eslint-disable-next-line sonarjs/code-eval -- Runs this repository's own compiled worker in an isolated test context.
  vm.runInNewContext(WORKER, {
    addEventListener: (type: string, listener: (event: object) => void) => {
      worker.listeners.set(type, listener);
    },
    caches,
    fetch: network,
    location: { origin: ORIGIN },
    Request: WorkerRequest,
    Response,
    URL,
    globalThis: {},
  });
  return worker;
}

/**
 * Dispatch a lifecycle event and wait for its work.
 *
 * @param worker - Loaded worker.
 * @param type - `install` or `activate`.
 */
async function lifecycle(worker: Worker, type: string): Promise<void> {
  const work: Promise<unknown>[] = [];
  worker.listeners.get(type)?.({
    waitUntil: (promise: Promise<unknown>) => {
      work.push(promise);
    },
  });
  await Promise.all(work);
}

/**
 * Dispatch a fetch and read the worker's answer.
 *
 * @param worker - Loaded worker.
 * @param input - Request details.
 * @param input.path - Path or absolute URL.
 * @param input.method - HTTP method.
 * @param input.isNavigation - Whether it loads a page.
 * @param input.client - Window id the request belongs to, or will create.
 * @returns Response body, or null when the worker let the browser handle it.
 */
async function dispatchFetch(
  worker: Worker,
  input: { path: string; method?: string; isNavigation?: boolean; client?: string },
): Promise<string | null> {
  const answers: Promise<Response>[] = [];
  const native = new WorkerRequest(input.path, { method: input.method ?? 'GET' });
  const isNavigation = input.isNavigation === true;
  worker.listeners.get('fetch')?.({
    request: Object.defineProperty(native, 'mode', { value: isNavigation ? 'navigate' : 'cors' }),
    clientId: isNavigation ? '' : (input.client ?? ''),
    resultingClientId: isNavigation ? (input.client ?? '') : '',
    respondWith: (promise: Promise<Response>) => {
      answers.push(promise);
    },
  });
  const [answer] = answers;
  return answer === undefined ? null : (await answer).text();
}

/**
 * The worker's own revision cache name.
 *
 * @returns The cache name compiled into the worker.
 */
function revision(): string {
  const name = /const CACHE = '(?<name>malt-public-shell-[\da-f]+)'/v.exec(WORKER)?.groups?.['name'];
  assert.ok(name !== undefined, 'the build stamps a content revision');
  return name;
}

/**
 * Sorted text values.
 *
 * @param values - Names.
 * @returns Copy sorted by locale-independent comparison.
 */
function sorted(values: Iterable<string>): string[] {
  return [...values].toSorted((left, right) => left.localeCompare(right));
}

await test('install fetches the whole shell past the HTTP cache into this revision, and activation retires older ones', async () => {
  const worker = loadWorker();
  worker.stores.set('malt-public-shell-old', new Map([['/app.js', 'old']]));
  worker.stores.set('mlt-public-shell-legacy', new Map());
  worker.stores.set('unrelated', new Map());
  await lifecycle(worker, 'install');
  const shell = worker.stores.get(revision());
  assert.ok(shell !== undefined);
  assert.ok(shell.has('/') && shell.has('/app.js') && shell.has('/connection-status.js'));
  assert.ok(worker.fetched.length > 0);
  assert.ok(
    worker.fetched.every((entry) => entry.cache === 'reload'),
    'no install reads a stale HTTP cache entry',
  );
  assert.ok(shell.keys().every((path) => !path.startsWith('/api/') && path !== '/sw.js'));
  await lifecycle(worker, 'activate');
  assert.deepEqual(sorted(worker.stores.keys()), sorted([revision(), 'unrelated']));
});

await test('API, worker, query, non-GET and cross-origin requests are never intercepted', async () => {
  const worker = loadWorker();
  await lifecycle(worker, 'install');
  for (const path of ['/api/snapshot?project=home', '/api/stream', '/api/pair', '/sw.js', '/app.js?v=1']) {
    assert.equal(await dispatchFetch(worker, { path }), null, path);
  }
  assert.equal(await dispatchFetch(worker, { path: '/app.js', method: 'POST' }), null);
  assert.equal(await dispatchFetch(worker, { path: 'https://example.com/app.js' }), null);
  assert.equal(await dispatchFetch(worker, { path: '/app.js' }), 'network /app.js');
});

await test('offline answers come only from this revision, and an offline-loaded window stays on it', async () => {
  const worker = loadWorker();
  await lifecycle(worker, 'install');
  await lifecycle(worker, 'activate');
  worker.stores.set('malt-public-shell-other', new Map([['/app.js', 'other revision']]));
  worker.isOnline = false;
  assert.equal(await dispatchFetch(worker, { path: '/', isNavigation: true, client: 'offline' }), 'network /');
  assert.equal(await dispatchFetch(worker, { path: '/app.js', client: 'offline' }), 'network /app.js');
  assert.equal(await dispatchFetch(worker, { path: '/missing.js', client: 'offline' }), null);
  worker.stores.get(revision())?.set('/app.js', 'cached revision');
  worker.isOnline = true;
  assert.equal(
    await dispatchFetch(worker, { path: '/app.js', client: 'offline' }),
    'cached revision',
    'a window loaded offline keeps loading its own revision after the network returns',
  );
  assert.equal(await dispatchFetch(worker, { path: '/app.js', client: 'online' }), 'network /app.js');
});

await test('the console serves the shell no-cache and every API response no-store', async (t) => {
  const defer = createCleanup(t);
  const config = createProject(defer);
  const broker = await startBroker(config, { port: 0 });
  defer(async () => broker.close());
  const web = await startWebConsole({ ...config, url: brokerUrl(broker.port) }, 0);
  defer(async () => web.close());
  for (const path of ['/', '/app.js', '/manifest.webmanifest', '/style.css', '/sw.js']) {
    const response = await fetch(`${web.url}${path}`);

    await response.arrayBuffer();
    assert.equal(response.headers.get('Cache-Control'), 'no-cache', path);
  }
  const anonymous = await fetch(`${web.url}/api/snapshot?project=home`, { headers: { Origin: web.url } });
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.headers.get('Cache-Control'), 'no-store');
  const pair = await fetch(`${web.url}/api/pair`, {
    method: 'POST',
    headers: { Origin: web.url, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: web.pairingCode }),
  });
  assert.equal(pair.headers.get('Cache-Control'), 'no-store');
  const headers = { Origin: web.url, Cookie: (pair.headers.get('set-cookie') ?? '').split(';', 1)[0] ?? '' };
  for (const path of ['/api/snapshot?project=home', '/api/projects', '/api/unknown-route?project=home']) {
    const response = await fetch(`${web.url}${path}`, { headers });

    await response.arrayBuffer();
    assert.equal(response.headers.get('Cache-Control'), 'no-store', path);
  }
  const stream = new AbortController();
  const live = await fetch(`${web.url}/api/stream?project=home`, { headers, signal: stream.signal });
  assert.equal(live.headers.get('Cache-Control'), 'no-store');
  assert.match(live.headers.get('Content-Type') ?? '', /text\/event-stream/v);
  stream.abort();
});
