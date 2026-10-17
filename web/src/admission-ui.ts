/** @file Read-only admission explanations from the same evidence used by dispatch. */
import { child, firstText, records, resourceSummary, text } from './api.js';
import { element } from './worker-ui.js';

import type { Data } from './api.js';
/** Sampling should be frequent; old counters must not look current. */
const STALE_MS = 30_000;
/** Milliseconds per displayed second. */
const SECOND_MS = 1000;
/** Backend gate codes, never executable operator instructions. */
const GATES: Readonly<Record<string, string>> = {
  job_cap: 'Job cap reached: resources.maxActiveJobs.',
  provider_cap: 'Provider cap reached: providers.<name>.concurrency.',
  provider_cooldown: 'Provider cooldown or observed subscription limit reached; wait for actual reset evidence.',
  provider_unavailable: 'No provider is currently eligible; inspect enabled providers and diagnostic policy.',
  cpu: 'CPU pressure: resources.maxCpuPercent.',
  memory: 'Memory pressure: resources.minFreeMemoryMb or resources.minFreeMemoryPercent.',
  none: 'No capacity gate reported. Dispatch still requires eligible work and workflow gates; spare capacity does not guarantee launch.',
};

/**
 * Explain the first capacity gate dispatch stops at.
 *
 * @param code - Backend gate code from the admission evidence.
 * @returns Readable reason, or `null` when no capacity gate applies or the code is unknown.
 */
export function capacityGate(code: string): string | null {
  return code === '' || code === 'none' ? null : (GATES[code] ?? null);
}

/**
 * Render missing numbers honestly, including valid zero readings.
 *
 * @param value - Untrusted numeric field.
 * @returns Finite nonnegative measurement or unknown.
 */
function measured(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? String(Math.round(value)) : 'unknown';
}

/**
 * Describe the sample's own age, without refreshing its observation timestamp.
 *
 * @param factory - Selected project snapshot.
 * @param now - Observation clock, injectable for tests.
 * @returns Counters, provenance age and explicit stale/unknown state.
 */
export function admissionSample(factory: Data, now = Date.now()): string {
  const sample = child(child(factory, 'admission'), 'sample');
  const at = sample['observedAt'];
  const age = typeof at === 'number' && Number.isFinite(at) && at > 0 && at <= now ? now - at : null;
  const status = age !== null && age > STALE_MS ? 'stale' : 'current';
  const freshness = age === null ? 'sample age unknown' : `${String(Math.floor(age / SECOND_MS))}s old · ${status}`;
  return `${resourceSummary({ resources: sample })} · total memory ${measured(sample['totalMemoryMb'])} MiB · ${freshness}`;
}

/**
 * Build plain evidence without reading or exposing another project's identities.
 *
 * @param factory - Selected project's actual admission evidence.
 * @returns Bounded readable lines; opening the panel performs no operations.
 */
export function admissionLines(factory: Data): string[] {
  const admission = child(factory, 'admission');
  const limits = child(admission, 'limits');
  const running = records(admission['running']);
  const total = admission['brokerReservations'];
  const other =
    typeof total === 'number' && Number.isFinite(total) && total >= running.length
      ? String(total - running.length)
      : 'unknown';
  const lines = [
    `Broker reservations ${measured(total)} / resources.maxActiveJobs ${measured(limits['maxActiveJobs'])}. Other broker pipelines/reservations: ${other} (identities private).`,
    `resources.maxCpuPercent ${measured(limits['maxCpuPercent'])}% · resources.minFreeMemoryMb ${measured(limits['minFreeMemoryMb'])} · resources.minFreeMemoryPercent ${measured(limits['minFreeMemoryPercent'])}%.`,
    GATES[text(admission, 'blocker')] ??
      'Admission evidence unavailable; refresh the console or configure the paused factory.',
  ];
  const providers = child(admission, 'providers');
  for (const name of ['codex', 'claude']) {
    const provider = child(child(limits, 'providers'), name);
    const count = running.filter((job) => text(job, 'provider') === name).length;
    lines.push(
      `${name}: ${String(count)} selected-project pipelines · providers.${name}.concurrency ${measured(provider['concurrency'])} · gate ${firstText(text(providers, name), 'none reported or unknown')}.`,
    );
  }
  for (const job of running) {
    const task = records(factory['tasks']).find((item) => item['id'] === job['taskId']);
    const feature = records(factory['features']).find((item) => item['id'] === job['featureId']);
    lines.push(
      `${text(job, 'role')} · ${text(job, 'kind')} · ${text(job, 'state')} · objective: ${firstText(text(feature ?? {}, 'objective'), text(job, 'featureId'), 'unavailable')} · ticket: ${firstText(text(task ?? {}, 'title'), text(job, 'taskId'), 'none')} · process activity, not delivery success.`,
    );
  }
  if (running.length === 0) {
    lines.push('No selected-project pipeline is currently owned. Idle roles use no model process.');
  }
  lines.push('Change admission policy in Project setup while the factory is paused and settled.');
  return lines;
}

/**
 * Mount semantic read-only details without any dispatch or acknowledgement.
 *
 * @param target - Local machine panel.
 * @param factory - Current selected project.
 */
export function appendAdmission(target: HTMLElement, factory: Data): void {
  const sample = element('p', 'subtle', admissionSample(factory));
  sample.dataset['admissionSample'] = 'true';
  const list = element('ul');
  for (const line of admissionLines(factory)) {
    list.append(element('li', 'subtle', line));
  }
  const details = element('details');
  details.append(element('summary', '', 'Why work is running or parked'), list);
  target.append(sample, details);
}
