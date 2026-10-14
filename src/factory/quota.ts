/**
 * Shared bounded native account telemetry, without inference or idle polling.
 *
 * @file
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { quotaReadingSchema } from './quota-windows.ts';

import type { MeshConfig } from '../config.ts';
import type { FactoryContext } from './context.ts';
import type { ProcessRunner } from './processes.ts';
import type { QuotaReading } from './quota-windows.ts';

/** Reuse one authenticated CLI observation across projects for five minutes. */
export const QUOTA_REFRESH_MS = 300_000;
/** Strict account-only diagnostic deadline. */
const TIMEOUT_MS = 15_000;
/** Bound executable cache variants; no live entry is discarded. */
const CACHE_LIMIT = 32;
/** Hard Windows diagnostic ceilings; no model is launched by this helper. */
const MEMORY_MB = 512;
/** Aggregate diagnostic CPU ceiling. */
const CPU_PERCENT = 25;
/** Diagnostic descendant process ceiling. */
const PROCESS_LIMIT = 8;
/** Reached default account quota. */
const FULL_PERCENT = 100;
/** Native account requests, never model jobs. */
const cache = new Map<string, { expires: number; result: Promise<QuotaReading | null> }>();

/**
 * Read supported Codex account limits under the existing owned-process runner.
 *
 * @param input - Verified executable, project artifacts and cancellation.
 * @returns Actual quota, or unknown when the native interface is unavailable.
 */
export async function codexQuota(input: {
  mesh: MeshConfig;
  executable: string;
  processes: ProcessRunner;
  signal: AbortSignal;
}): Promise<QuotaReading | null> {
  const previous = cache.get(input.executable);
  if (previous !== undefined && previous.expires > Date.now()) {
    return previous.result;
  }
  if (previous === undefined && cache.size >= CACHE_LIMIT) {
    return null;
  }
  const result = probe(input);
  const entry = { expires: Date.now() + QUOTA_REFRESH_MS, result };
  cache.set(input.executable, entry);
  const reading = await result;
  if (input.signal.aborted && cache.get(input.executable) === entry) {
    cache.delete(input.executable);
  }
  return reading;
}

/**
 * Launch one metadata-only helper with the same descendant cleanup as jobs.
 *
 * @param input - Project-local diagnostics and native executable.
 * @returns Validated scalar telemetry without raw account information.
 */
async function probe(input: {
  mesh: MeshConfig;
  executable: string;
  processes: ProcessRunner;
  signal: AbortSignal;
}): Promise<QuotaReading | null> {
  const result = await input.processes({
    file: process.execPath,
    args: [path.join(import.meta.dirname, 'codex-quota-probe.ts'), input.executable],
    cwd: input.mesh.root,
    input: '',
    artifact: path.join(input.mesh.directory, 'factory', 'quota', randomUUID()),
    signal: input.signal,
    timeoutMs: TIMEOUT_MS,
    memoryMb: MEMORY_MB,
    cpuPercent: CPU_PERCENT,
    processLimit: PROCESS_LIMIT,
    secrets: [input.mesh.token],
  });
  if (result.exitCode !== 0 || result.interrupted) {
    return null;
  }
  try {
    return quotaReadingSchema.parse(JSON.parse(result.stdout.trim()));
  } catch {
    return null;
  }
}

/** One project owns cancellation and observation cadence, without a model role. */
export class QuotaObserver {
  /** Next eligible metadata observation. */
  private nextAt = 0;
  /** Owned diagnostic cancellation, separate from model claims. */
  private controller: AbortController | null = null;

  /** Cancel only this project's in-flight owned metadata probe. */
  public cancel(): void {
    this.controller?.abort();
  }

  /**
   * Observe supported metadata before eligible work, preserving unknown values.
   *
   * @param context - Verified project state and native executable.
   */
  public async observe(context: FactoryContext): Promise<void> {
    const now = context.repository.store.now();
    if (!context.settings.providers.codex.enabled || now < this.nextAt) {
      return;
    }
    this.nextAt = now + QUOTA_REFRESH_MS;
    const controller = new AbortController();
    this.controller = controller;
    try {
      await this.collect(context, controller);
    } finally {
      this.controller = null;
    }
  }

  /**
   * Store only scalar verified account data; raw credentials never enter memory.
   *
   * @param context - Selected project ledger.
   * @param controller - Owned stop boundary.
   */
  private async collect(context: FactoryContext, controller: AbortController): Promise<void> {
    const reading = await codexQuota({
      mesh: context.mesh,
      executable: context.settings.providers.codex.executable,
      processes: context.processes,
      signal: controller.signal,
    });
    if (controller.signal.aborted) {
      return;
    }
    const prior = context.repository.capacity('codex', context.settings);
    context.repository.saveCapacity({
      ...prior,
      subscriptionUsedPercent: reading?.usedPercent ?? null,
      subscriptionResetAt: reading?.resetAt ?? null,
      telemetrySource: reading === null ? null : 'codex-app-server',
      cooldownUntil:
        reading?.usedPercent === FULL_PERCENT
          ? Math.max(prior.cooldownUntil, reading.resetAt ?? this.nextAt)
          : prior.cooldownUntil,
      updatedAt: context.repository.store.now(),
    });
  }
}
