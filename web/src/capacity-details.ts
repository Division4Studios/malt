/**
 * Actual subscription windows and owned process measurements, with honest gaps.
 *
 * @file
 */
import { child, number, records, text, firstText } from './api.js';
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
  return `Observed ${at} ? ${freshness} ? ${source}`;
}

/**
 * Show current owned PIDs; limits are not substituted for measurements.
 *
 * @param target - Machine capacity panel.
 * @param factory - Current authenticated factory snapshot.
 */
export function appendProcessUsage(target: HTMLElement, factory: Data): void {
  const usage = records(factory['processUsage']);
  if (usage.length === 0) {
    return;
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
  for (const item of usage) {
    const processes = records(child(item, 'sample')['processes']);
    if (processes.length === 0) {
      target.append(element('p', 'subtle', `${text(item, 'role')}: process usage unavailable or stale.`));
    }
    for (const process of processes) {
      const row = element('tr');
      const cpu = process['cpuPercent'];
      for (const value of [
        text(item, 'role'),
        String(number(process, 'pid')),
        number(process, 'memoryMb').toFixed(1),
        typeof cpu === 'number' ? `${cpu.toFixed(1)}%` : 'sampling',
      ]) {
        row.append(element('td', '', value));
      }
      body.append(row);
    }
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
