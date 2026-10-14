/**
 * Read bounded telemetry from owned process helpers; never enumerate user apps.
 *
 * @file
 */
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import type { FactoryJob } from './schema.ts';

/** Old process samples must never be shown as current usage. */
const MAX_AGE_MS = 6000;
/** Bound the native diagnostic artifact independently of provider output. */
const MAX_BYTES = 32_768;
/** Windows process ceiling matches the managed Job Object configuration. */
const MAX_PROCESSES = 128;
/** Maximum normalized whole-machine CPU percentage. */
const PERCENT_MAX = 100;
/** Scalars for one current owned PID. */
const processSchema = z.object({
  pid: z.number().int().positive(),
  memoryMb: z.number().finite().nonnegative(),
  cpuPercent: z.number().finite().min(0).max(PERCENT_MAX).nullable(),
});
/** Validated scalar-only native sample. No executable paths or arguments. */
const sampleSchema = z.object({
  sampledAt: z.number().int().nonnegative(),
  processes: z.array(processSchema).max(MAX_PROCESSES),
});
/** Explicit browser projection; no arbitrary process fields cross the boundary. */
export const ownedUsageSchema = z.object({ jobId: z.string().uuid(), role: z.string(), sample: sampleSchema.nullable() });
/** Public measurement for one currently running assignment. */
export interface OwnedUsage {
  /** Durable assignment identity; no browser-selected PID. */
  readonly jobId: string;
  /** Logical role owning these processes. */
  readonly role: string;
  /** Scalar sample or explicit unavailable/stale data. */
  readonly sample: z.output<typeof sampleSchema> | null;
}

/**
 * Inspect only fixed diagnostic files belonging to current live claims.
 *
 * @param jobs - Authoritative bounded project job inventory.
 * @param now - Observation time used to reject stale samples.
 * @returns Usage without inventing per-process measurements on other OSes.
 */
export function ownedProcessUsage(jobs: readonly FactoryJob[], now = Date.now()): OwnedUsage[] {
  return jobs
    .filter((job) => job.state === 'running')
    .map((job) => {
      let sample: OwnedUsage['sample'] = null;
      try {
        sample = readSample(job, now);
      } catch {
        // Exits, first samples, OS support and permission errors remain unknown.
      }
      return { jobId: job.id, role: job.role, sample };
    });
}

/**
 * Validate one bounded native artifact and its measurement age.
 *
 * @param job - Backend-owned attempt directory.
 * @param now - Current wall time.
 * @returns Current scalar sample or unknown.
 */
function readSample(job: FactoryJob, now: number): OwnedUsage['sample'] {
  const file = path.join(job.artifact, 'resources.json');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixed diagnostic file under the backend-owned assignment root.
  if (statSync(file).size > MAX_BYTES) {
    return null;
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixed bounded diagnostic file, never a browser-selected path.
  const parsed = sampleSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
  return parsed.success && parsed.data.sampledAt <= now && now - parsed.data.sampledAt <= MAX_AGE_MS
    ? parsed.data
    : null;
}
