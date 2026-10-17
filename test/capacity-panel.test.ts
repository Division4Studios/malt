/**
 * The Provider & local capacity panel rendered into a text-only DOM: reading
 * order, every observation state, hostile labels, live sample replacement,
 * project switching and the narrow-screen rules it depends on. DOM-free in the
 * browser sense: imports compiled modules, so `npm run build:web` runs first.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { refreshCapacitySamples } from '../web/dist/capacity-details.js';
import { capacityView } from '../web/dist/capacity-view.js';

import { FakeElement, fake, installDom, readingOrder } from './dom-shim.ts';

/** A label that would execute if any view parsed it as markup. */
const HOSTILE = '<img src=x onerror="globalThis.pwned=true">';
/** Fixed observation clock. */
const OBSERVED = Date.UTC(2026, 9, 17, 9, 30);

/**
 * A snapshot for one project with the given providers and machine reading.
 *
 * @param project - Project id.
 * @param capacities - Provider capacity records.
 * @param cpu - Sampled CPU percentage.
 * @param processes - Owned processes sampled for developer-1.
 * @returns Console snapshot.
 */
function snapshot(
  project: string,
  capacities: Record<string, unknown>[],
  cpu = 12,
  processes: Record<string, unknown>[] = [],
): Record<string, unknown> {
  return {
    project: { id: project },
    events: [],
    github: {},
    learning: {},
    observedAt: OBSERVED,
    factory: {
      settings: { providers: { codex: { enabled: true }, claude: { enabled: false } } },
      capacities,
      resources: { freeMemoryMb: 8000, cpuPercent: cpu },
      processUsage: processes.length === 0 ? [] : [{ role: 'developer-1', sample: { processes } }],
      admission: { sample: { observedAt: OBSERVED, cpuPercent: cpu, freeMemoryMb: 8000 }, running: [] },
      tasks: [],
    },
  };
}

/** Codex with several windows: zero, saturated, stale, hostile and unknown. */
const codex = {
  provider: 'codex',
  subscriptionUsedPercent: 0,
  usedTokens: 1200,
  reservedTokens: 300,
  subscriptionWindows: [
    { minutes: 300, usedPercent: 0, resetAt: OBSERVED + 3_600_000, observedAt: OBSERVED, freshness: 'current' },
    { minutes: 10_080, usedPercent: 100, resetAt: OBSERVED + 86_400_000, observedAt: OBSERVED, freshness: 'stale' },
    { id: HOSTILE, usedPercent: 'unknown' },
  ],
};
/** Claude disabled, with only a legacy scalar summary. */
const claude = { provider: 'claude', subscriptionUsedPercent: 42, usedTokens: 0, reservedTokens: 0 };

await test('subscription limits come first, then diagnostic usage, then the local machine', (t) => {
  installDom(t);
  const view = fake(capacityView(snapshot('home', [codex, claude])));
  const order = readingOrder(view);
  const limits = order.indexOf('Subscription limits');
  const diagnostic = order.indexOf('Diagnostic usage');
  const machine = order.indexOf('Local machine');
  assert.ok(limits === 0 && limits < diagnostic && diagnostic < machine, order.join('\n'));
  const windowLines = order.filter((line) => line.includes('% used') || line.includes('usage unknown'));
  assert.ok(
    windowLines.every((line) => order.indexOf(line) < diagnostic),
    'every subscription window reads before diagnostic token counts',
  );
  assert.ok(order.slice(diagnostic).some((line) => line.includes('reported tokens')));
});

await test('zero, saturation, stale, missing and legacy observations stay distinct without color', (t) => {
  installDom(t);
  const text = fake(capacityView(snapshot('home', [codex, claude]))).textContent;
  assert.match(text, /5-hour window: 0% used · resets/v);
  assert.match(text, /Weekly window: 100% used · limit reached/v);
  assert.match(text, /\| stale \|/v);
  assert.match(text, /usage unknown · resets unknown/v);
  assert.match(text, /Observed unknown \| freshness unknown \| source unknown/v);
  assert.match(text, /Legacy summary only: 42% used · window duration unavailable/v);
  assert.match(text, /Absolute allowance unavailable/v);
});

await test('disabled providers stay identifiable but are never presented as runnable capacity', (t) => {
  installDom(t);
  const view = fake(capacityView(snapshot('home', [codex, claude])));
  const cards = view.querySelectorAll('div').filter((node) => node.cssClass === 'capacity');
  assert.equal(cards.length, 2);
  const disabled = cards.find((card) => card.textContent.startsWith('CLAUDE'));
  assert.ok(disabled !== undefined);
  assert.match(disabled.textContent, /Disabled · not eligible for dispatch/v);
  assert.equal(disabled.querySelector('meter'), null, 'no usage meter suggests runnable capacity');
  const enabled = cards.find((card) => card.textContent.startsWith('CODEX'));
  assert.equal(enabled?.querySelector('meter')?.getAttribute('aria-label'), 'codex reported subscription usage');
});

await test('hostile window labels render as literal text, never as markup', (t) => {
  installDom(t);
  const view = fake(capacityView(snapshot('home', [codex])));
  assert.ok(view.textContent.includes(HOSTILE));
  assert.equal(view.querySelector('img'), null);
  assert.equal(Reflect.get(globalThis, 'pwned'), undefined);
});

await test('a live sample refresh updates readings and process rows in place and keeps every other node', (t) => {
  const dom = installDom(t);
  const before = [{ pid: 7, memoryMb: 100, cpuPercent: 10 }];
  const view = fake(capacityView(snapshot('home', [codex], 12, before)));
  dom.body.append(view);
  const machine = dom.querySelector('[data-resource-machine]');
  const processes = dom.querySelector('[data-process-usage]');
  assert.ok(processes !== null);
  const outside = view.descendants().filter((node) => node !== processes && !processes.descendants().includes(node));
  assert.match(machine?.textContent ?? '', /CPU 12%/v);
  assert.match(processes.textContent, /developer-17100\.010\.0%/v);
  const after = [
    { pid: 7, memoryMb: 120, cpuPercent: 55 },
    { pid: 9, memoryMb: 30, cpuPercent: null },
  ];
  refreshCapacitySamples(snapshot('home', [codex], 77, after)['factory']);
  assert.equal(dom.querySelector('[data-resource-machine]'), machine, 'the same reading node is updated');
  assert.match(machine?.textContent ?? '', /CPU 77%/v);
  assert.equal(dom.querySelector('[data-process-usage]'), processes, 'the same process container is refilled');
  assert.deepEqual(
    processes.querySelectorAll('tr').map((row) => row.textContent),
    ['RolePIDResident MiBCPU', 'developer-17120.055.0%', 'developer-1930.0sampling'],
  );
  assert.deepEqual(
    view.descendants().filter((node) => node !== processes && !processes.descendants().includes(node)),
    outside,
    'nothing outside the process container was rebuilt by a sample',
  );
});

await test('switching project replaces the mounted panel; nothing is retained from the previous project', (t) => {
  const dom = installDom(t);
  const host = new FakeElement('div');
  dom.body.append(host);
  const alpha = snapshot('alpha', [{ ...codex, subscriptionWindows: [{ id: 'alpha-only' }] }], 12, [
    { pid: 41, memoryMb: 64, cpuPercent: 3 },
  ]);
  host.append(fake(capacityView(alpha)));
  assert.match(dom.body.textContent, /alpha-only/v);
  // The shell's render: refresh samples in the mounted view, then replace the view for the new snapshot.
  const beta = snapshot('beta', [], 66);
  refreshCapacitySamples(beta['factory']);
  host.replaceChildren(fake(capacityView(beta)));
  assert.doesNotMatch(dom.body.textContent, /41|CODEX|alpha-only/v);
  assert.match(dom.body.textContent, /Configure subscription providers and local resource limits in Project setup/v);
  assert.equal(dom.body.querySelectorAll('[data-resource-machine]').length, 1);
  assert.match(dom.querySelector('[data-resource-machine]')?.textContent ?? '', /CPU 66%/v);
});

await test('narrow screens wrap long observations and scroll the process table inside the panel', () => {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Reads only this repository's stylesheet.
  const css = readFileSync(new URL('../web/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.capacity-details \{[^\}]*overflow-wrap: anywhere;[^\}]*\}/v);
  assert.match(css, /\.capacity-details \{[^\}]*flex-wrap: wrap;[^\}]*\}/v);
  assert.match(css, /\.process-usage \{[^\}]*overflow-x: auto;[^\}]*\}/v);
});
