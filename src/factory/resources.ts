/**
 * Local admission control independent of paid model turns. CPU samples use
 * platform OS counters, including Windows; memory pressure parks role slots.
 *
 * @file
 */

import os from 'node:os';

import type { FactoryConfig } from './schema.ts';

/** Bytes per MiB for explicit memory budgets. */
const MIB = 1_048_576;
/** Convert an OS counter ratio to a percentage. */
const PERCENT = 100;
/** Stop owned pipelines at half the configured memory admission floor. */
const CRITICAL_RATIO = 0.5;
/** Current machine-wide admission evidence. */
export interface ResourceSnapshot {
  /** Free physical memory. */
  readonly freeMemoryMb: number;
  /** Total physical memory. */
  readonly totalMemoryMb: number;
  /** Aggregate CPU percentage, unknown before a second sample. */
  readonly cpuPercent: number | null;
}
/** Injectable OS evidence for deterministic scheduling tests. */
export type ResourceProbe = () => ResourceSnapshot;

/**
 * Build a nonblocking OS sampler; no PowerShell monitoring process is spawned.
 *
 * @returns Resource sampler with CPU delta history.
 */
export function resourceProbe(): ResourceProbe {
  let previous: { total: number; idle: number } | null = null;
  return () => {
    const times = { total: 0, idle: 0 };
    for (const cpu of os.cpus()) {
      for (const value of Object.values(cpu.times)) {
        times.total += value;
      }
      times.idle += cpu.times.idle;
    }
    const delta = previous === null ? 0 : times.total - previous.total;
    const cpuPercent = previous === null || delta <= 0 ? null : PERCENT * (1 - (times.idle - previous.idle) / delta);
    previous = times;
    return { freeMemoryMb: os.freemem() / MIB, totalMemoryMb: os.totalmem() / MIB, cpuPercent };
  };
}

/**
 * Explain why a new assignment must remain parked, without killing user apps.
 *
 * @param config - Project resource limits.
 * @param snapshot - Actual OS counters.
 * @param activeJobs - Running model/check pipelines.
 * @returns Admission blocker, null when capacity is available.
 */
export function resourceBlocker(config: FactoryConfig, snapshot: ResourceSnapshot, activeJobs: number): string | null {
  const limits = config.resources;
  if (activeJobs >= limits.maxActiveJobs) {
    return 'The local managed-job concurrency cap is reached.';
  }
  if (
    snapshot.freeMemoryMb < limits.minFreeMemoryMb ||
    (snapshot.freeMemoryMb / snapshot.totalMemoryMb) * PERCENT < limits.minFreeMemoryPercent
  ) {
    return 'Low free physical memory; new roles are parked.';
  }
  return snapshot.cpuPercent !== null && snapshot.cpuPercent > limits.maxCpuPercent
    ? 'High CPU utilization; new roles are parked.'
    : null;
}

/**
 * Detect critical memory pressure separately from temporary CPU admission waits.
 *
 * @param config - Explicit project admission floors.
 * @param snapshot - Actual machine counters, without a polling subprocess.
 * @returns Whether owned pipelines should stop and preserve their handoff.
 */
export function hasCriticalMemoryPressure(config: FactoryConfig, snapshot: ResourceSnapshot): boolean {
  const limits = config.resources;
  return (
    snapshot.freeMemoryMb < limits.minFreeMemoryMb * CRITICAL_RATIO ||
    (snapshot.freeMemoryMb / snapshot.totalMemoryMb) * PERCENT < limits.minFreeMemoryPercent * CRITICAL_RATIO
  );
}
