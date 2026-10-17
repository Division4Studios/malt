/**
 * The "Why work is running or parked" admission section rendered into a
 * text-only DOM, plus the same rendering fed by a real paired loopback
 * snapshot: hostile labels, anonymous other-project counts, keyboard-only
 * use, narrow-screen wrapping, and opening the section without starting any
 * process. Imports compiled modules, so `npm run build:web` runs first.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { z } from 'zod/v3';

import { startBroker } from '../src/broker.ts';
import { FactoryRepository } from '../src/factory/repository.ts';
import { factoryConfigSchema } from '../src/factory/schema.ts';
import { startWebConsole } from '../src/web/server.ts';
import { appendAdmission } from '../web/dist/admission-ui.js';

import { FakeElement, installDom } from './dom-shim.ts';
import { brokerUrl, createCleanup, createProject } from './helpers.ts';

/** Provider caps in served admission evidence. */
const providerLimits = z.object({ codex: z.object({ concurrency: z.number() }) }).passthrough();
/** The admission evidence fields a served snapshot must carry. */
const servedAdmission = z.object({
  sample: z.record(z.unknown()),
  running: z.array(z.unknown()),
  brokerReservations: z.number(),
  limits: z.object({ maxActiveJobs: z.number(), providers: providerLimits }),
});
/** A label that would execute if any view parsed it as markup. */
const HOSTILE = '<img src=x onerror="globalThis.pwnedAdmission=true">';

/**
 * A factory snapshot with the given admission evidence.
 *
 * @param admission - Admission fields.
 * @returns Factory snapshot with two objectives and one delivery.
 */
function factory(admission: Record<string, unknown>): Record<string, unknown> {
  return {
    admission: {
      sample: { observedAt: Date.now(), freeMemoryMb: 6000, totalMemoryMb: 16_000, cpuPercent: 20 },
      limits: { maxActiveJobs: 3, providers: { codex: { concurrency: 1 }, claude: { concurrency: 2 } } },
      running: [],
      brokerReservations: 0,
      providers: { codex: null, claude: null },
      blocker: 'none',
      ...admission,
    },
    features: [
      { id: 'objective-a', objective: HOSTILE },
      { id: 'objective-b', objective: 'Second objective' },
    ],
    tasks: [{ id: 'delivery-a', title: 'First delivery' }],
  };
}

/** Two running jobs of the selected project, from different objectives. */
const overlap = [
  {
    role: 'developer-1',
    kind: 'develop',
    state: 'running',
    provider: 'codex',
    featureId: 'objective-a',
    taskId: 'delivery-a',
  },
  { role: 'product-owner', kind: 'plan', state: 'running', provider: 'claude', featureId: 'objective-b' },
];

/**
 * Render the admission section into a fresh panel.
 *
 * @param state - Factory snapshot.
 * @returns The rendered panel.
 */
function render(state: Record<string, unknown>): FakeElement {
  const panel = new FakeElement('div');
  appendAdmission(panel, state);
  return panel;
}

await test('overlapping objectives list separately with their role, stage and objective', (t) => {
  installDom(t);
  const items = render(factory({ running: overlap, brokerReservations: 2 }))
    .querySelectorAll('li')
    .map((item) => item.textContent);
  assert.ok(
    items.some((line) => line.startsWith('developer-1 · develop · running') && line.includes('First delivery')),
  );
  assert.ok(items.some((line) => line.startsWith('product-owner · plan · running · objective: Second objective')));
  const jobs = items.filter((line) => line.includes(' · running · '));
  assert.equal(jobs.length, 2);
  assert.ok(jobs.every((line) => line.endsWith('process activity, not delivery success.')));
});

await test('hostile labels render as literal text, never as markup', (t) => {
  installDom(t);
  const panel = render(factory({ running: overlap, brokerReservations: 2 }));
  assert.ok(panel.textContent.includes(HOSTILE));
  assert.equal(panel.querySelector('img'), null);
  assert.equal(Reflect.get(globalThis, 'pwnedAdmission'), undefined);
});

await test('other projects appear only as an anonymous count', (t) => {
  installDom(t);
  const text = render(factory({ running: overlap, brokerReservations: 5 })).textContent;
  assert.match(text, /Other broker pipelines\/reservations: 3 \(identities private\)/v);
  const jobLines = render(factory({ running: overlap, brokerReservations: 5 }))
    .querySelectorAll('li')
    .filter((item) => item.textContent.includes('process activity'));
  assert.equal(jobLines.length, overlap.length, 'only the selected project jobs are described');
});

await test('each parked reason, unknown evidence and older snapshots render without throwing', (t) => {
  installDom(t);
  for (const [blocker, expected] of [
    ['job_cap', 'resources.maxActiveJobs'],
    ['provider_cap', 'providers.<name>.concurrency'],
    ['provider_cooldown', 'cooldown'],
    ['cpu', 'resources.maxCpuPercent'],
    ['memory', 'resources.minFreeMemoryMb'],
    ['provider_unavailable', 'No provider is currently eligible'],
    ['none', 'spare capacity does not guarantee launch'],
  ] as const) {
    assert.ok(render(factory({ blocker })).textContent.includes(expected), blocker);
  }
  const unknown = render({ admission: { sample: { cpuPercent: null } } }).textContent;
  assert.match(unknown, /CPU sampling \/ unknown/v);
  assert.match(unknown, /sample age unknown/v);
  assert.match(render({}).textContent, /Admission evidence unavailable/v);
});

await test('the section is a native disclosure usable with the keyboard alone and starts nothing', (t) => {
  installDom(t);
  const fetches = t.mock.method(globalThis, 'fetch', async () => {
    await Promise.resolve();
    throw new Error('The admission section must not fetch.');
  });
  const panel = render(factory({ running: overlap, brokerReservations: 2 }));
  const details = panel.querySelector('details');
  assert.ok(details !== null);
  const summary = details.querySelector('summary');
  assert.equal(summary?.textContent, 'Why work is running or parked');
  const [first] = details.children;
  assert.equal(first, summary, 'the summary is the first, focusable child');
  for (const node of panel.descendants()) {
    assert.equal(node.getAttribute('tabindex'), null, `${node.tagName} keeps native focus order`);
    assert.equal(node.listeners.size, 0, `${node.tagName} needs no script to open`);
  }
  Reflect.set(details, 'open', true);
  assert.equal(fetches.mock.callCount(), 0, 'rendering and opening make no request and launch no process');
});

await test('long admission lines wrap on narrow screens', () => {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Reads only this repository's stylesheet.
  const css = readFileSync(new URL('../web/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.subtle \{[^\}]*overflow-wrap: anywhere;[^\}]*\}/v);
});

await test('a real paired loopback snapshot renders admission evidence and keeps it project-scoped', async (t) => {
  installDom(t);
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  const broker = await startBroker(mesh, { port: 0 });
  defer(async () => broker.close());
  const repository = new FactoryRepository(broker.store);
  repository.configure(
    factoryConfigSchema.parse({
      testCommands: [{ file: process.execPath }],
      endToEndCommands: [{ file: process.execPath }],
      resources: { maxActiveJobs: 3 },
      providers: { codex: { executable: 'fixture', concurrency: 2 }, claude: { executable: 'fixture' } },
    }),
  );
  const web = await startWebConsole({ ...mesh, url: brokerUrl(broker.port) }, 0);
  defer(async () => web.close());
  const pair = await fetch(`${web.url}/api/pair`, {
    method: 'POST',
    headers: { Origin: web.url, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: web.pairingCode }),
  });
  assert.equal(pair.status, 200);
  const headers = { Origin: web.url, Cookie: (pair.headers.get('set-cookie') ?? '').split(';', 1)[0] ?? '' };
  const response = await fetch(`${web.url}/api/snapshot?project=home`, { headers });
  assert.equal(response.status, 200);
  const body: unknown = await response.json();
  assert.ok(typeof body === 'object' && body !== null && 'factory' in body);
  const { factory: served } = body;
  assert.ok(typeof served === 'object' && served !== null && 'admission' in served);
  const admission = servedAdmission.parse(served.admission);
  assert.equal(admission.limits.maxActiveJobs, 3, 'limits come from the broker, not a console default');
  assert.equal(admission.limits.providers.codex.concurrency, 2);
  assert.deepEqual(admission.running, []);
  const text = render({ ...served }).textContent;
  assert.match(text, /Broker reservations \d+ \/ resources\.maxActiveJobs 3\./v);
  assert.match(text, /codex: 0 selected-project pipelines · providers\.codex\.concurrency 2/v);
  assert.match(text, /No selected-project pipeline is currently owned/v);
  assert.equal((await fetch(`${web.url}/api/snapshot?project=elsewhere`, { headers })).status, 403);
});
