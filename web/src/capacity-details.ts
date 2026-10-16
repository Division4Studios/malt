/**
 * Actual subscription windows and owned process measurements, with honest gaps.
 *
 * @file
 */
import { child, number, records, text, firstText, resourceSummary } from './api.js';
import { element } from './worker-ui.js';

import type { Data } from './api.js';
/** Names apply only when an actual native duration matches. */
const WINDOW_LABELS: Readonly<Record<number, string>> = { 300: '5-hour window', 10_080: 'Weekly window' };

/**
 * Format native epoch time for the local operator.
 *
 * @param value - Epoch milliseconds.
 * @returns Readable date and time.
 */
function localTime(value: number): string {
  const date = new Date(value);
  return date.toLocaleString();
}

/**
 * Present each observed window without guessing the account's plan limits.
 *
 * @param target - Provider card.
 * @param capacity - Validated backend capacity.
 */
export function appendQuotaWindows(target: HTMLElement, capacity: Data): void {
  const windows = records(capacity['subscriptionWindows']);
  if (windows.length === 0) {
    target.append(element('p', 'subtle', 'Individual subscription windows not reported · usage unknown.'));
    return;
  }
  for (const window of windows) {
    const { minutes } = window;
    const label =
      typeof minutes === 'number' ? (WINDOW_LABELS[minutes] ?? `${String(minutes)} minute window`) : text(window, 'id');
    const reset = window['resetAt'];
    const deadline = typeof reset === 'number' ? localTime(reset) : 'unknown';
    const percent = String(number(window, 'usedPercent'));
    target.append(element('p', 'capacity-details', `${label}: ${percent}% used · resets ${deadline}`));
    target.append(element('p', 'subtle', quotaWindowObservation(window)));
  }
}

/**
 * Report the quota sample's own provenance, never unrelated accounting writes.
 *
 * @param window - One backend-observed subscription window.
 * @returns Per-window timestamp, freshness and source with honest unknowns.
 */
export function quotaWindowObservation(window: Data): string {
  const observed = window['observedAt'];
  const at = typeof observed === 'number' ? localTime(observed) : 'unknown';
  const freshness = firstText(text(window, 'freshness'), 'freshness unknown');
  const source = firstText(text(window, 'source'), 'source unknown');
  return `Observed ${at} | ${freshness} | ${source}`;
}

/**
 * Drop the volatile sampling cycle so a sample-only change never rebuilds the view.
 * Machine resources, per-process usage and the admission sample refresh in place.
 *
 * @param factory - Current authenticated factory snapshot.
 * @returns Factory state that excludes every sample-derived field.
 */
export function stableFactory(factory: Data): Data {
  const stable = Object.fromEntries(
    Object.entries(factory).filter(([key]) => key !== 'resources' && key !== 'processUsage'),
  );
  if (stable['admission'] !== null && typeof stable['admission'] === 'object') {
    stable['admission'] = Object.fromEntries(
      Object.entries(child(stable, 'admission')).filter(([key]) => key !== 'sample'),
    );
  }
  return stable;
}

/**
 * Flatten owned process measurements into displayed table cells.
 *
 * @param factory - Current authenticated factory snapshot.
 * @returns Process rows and roles without any measured process.
 */
export function processUsageRows(factory: Data): { rows: string[][]; unavailable: string[] } {
  const rows: string[][] = [];
  const unavailable: string[] = [];
  const usage = records(factory['processUsage']);
  for (const item of usage) {
    const processes = records(child(item, 'sample')['processes']);
    if (processes.length === 0) {
      unavailable.push(text(item, 'role'));
    }
    for (const process of processes) {
      const cpu = process['cpuPercent'];
      rows.push([
        text(item, 'role'),
        String(number(process, 'pid')),
        number(process, 'memoryMb').toFixed(1),
        typeof cpu === 'number' ? `${cpu.toFixed(1)}%` : 'sampling',
      ]);
    }
  }
  return { rows, unavailable };
}

/**
 * Rebuild only the process sample container, leaving the rest of the view untouched.
 *
 * @param target - Existing process usage container.
 * @param factory - Current authenticated factory snapshot.
 */
export function fillProcessUsage(target: HTMLElement, factory: Data): void {
  const { rows, unavailable } = processUsageRows(factory);
  target.replaceChildren();
  if (records(factory['processUsage']).length === 0) {
    return;
  }
  for (const role of unavailable) {
    target.append(element('p', 'subtle', `${role}: process usage unavailable or stale.`));
  }
  const table = element('table');
  table.append(element('caption', '', 'Owned processes · CPU is percentage of the whole machine'));
  const header = element('tr');
  for (const title of ['Role', 'PID', 'Resident MiB', 'CPU']) {
    const cell = element('th', '', title);
    cell.setAttribute('scope', 'col');
    header.append(cell);
  }
  const head = element('thead');
  head.append(header);
  const body = element('tbody');
  for (const values of rows) {
    const row = element('tr');
    for (const value of values) {
      row.append(element('td', '', value));
    }
    body.append(row);
  }
  table.append(head, body);
  const scroll = element('div', 'process-usage');
  scroll.append(table);
  target.append(
    scroll,
    element(
      'p',
      'subtle',
      'Windows samples come from owned Job Objects. Resident memory can include shared pages. Unavailable measurements stay unknown.',
    ),
  );
}

/**
 * Show current owned PIDs; limits are not substituted for measurements.
 *
 * @param target - Machine capacity panel.
 * @param factory - Current authenticated factory snapshot.
 */
export function appendProcessUsage(target: HTMLElement, factory: Data): void {
  const container = element('div');
  container.dataset['processUsage'] = 'true';
  fillProcessUsage(container, factory);
  target.append(container);
}

/**
 * Refresh measured values without replacing the operator's current view.
 *
 * @param factory - Latest project-scoped snapshot.
 */
export function refreshCapacitySamples(factory: Data): void {
  const resources = document.querySelector('[data-resource-machine]');
  if (resources !== null) {
    resources.textContent = resourceSummary(factory);
  }
  const usage = document.querySelector<HTMLElement>('[data-process-usage]');
  if (usage !== null) {
    fillProcessUsage(usage, factory);
  }
}
