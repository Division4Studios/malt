/**
 * Local admission control independent of paid model turns. CPU samples use
 * platform OS counters, including Windows; memory pressure parks role slots.
 * Admission evidence is read-only: building it never samples the probe,
 * claims a job, records telemetry or acknowledges an instruction.
 *
 * @file
 */

import os from 'node:os';

import { providerBlockers } from './scheduler.ts';
import { PROVIDERS } from './schema.ts';

import type { AdmissionPool } from './admission.ts';
import type { FactoryRepository } from './repository.ts';
import type { ProviderBlocker } from './scheduler.ts';
import type { FactoryConfig, FactoryJob, Provider } from './schema.ts';

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
/** One cached measurement with its supervisor-clock observation time. */
export interface ResourceSample extends ResourceSnapshot {
  /** When the stateful probe produced these counters. */
  readonly observedAt: number;
}
/** Structured reason the next eligible assignment remains parked. */
export type AdmissionBlocker =
  'job_cap' | 'memory' | 'cpu' | 'provider_cap' | 'provider_cooldown' | 'provider_unavailable' | 'none';
/** Operator text for machine resource blockers. */
const RESOURCE_MESSAGES = {
  job_cap: 'The local managed-job concurrency cap is reached.',
  memory: 'Low free physical memory; new roles are parked.',
  cpu: 'High CPU utilization; new roles are parked.',
} as const;

/**
 * Sole owner of a supervisor's stateful probe. Only the scheduling cycle
 * advances its CPU baseline; status readers see the cached sample.
 */
export class ResourceSampler {
  /** Stateful OS adapter. */
  private readonly probe: ResourceProbe;
  /** Latest sample; CPU stays unknown until a second sample exists. */
  private current: ResourceSample;

  /**
   * Take the baseline sample when the supervisor is constructed.
   *
   * @param probe - Stateful OS adapter.
   * @param now - Supervisor clock.
   */
  public constructor(probe: ResourceProbe, now: number) {
    this.probe = probe;
    this.current = this.measure(now);
  }

  /**
   * Latest cached sample, without touching the probe.
   *
   * @returns Measured counters with their observation time.
   */
  public get latest(): ResourceSample {
    return this.current;
  }

  /**
   * Advance the probe once; callers must own the scheduling cycle.
   *
   * @param now - Supervisor clock.
   * @returns Fresh sample.
   */
  public sample(now: number): ResourceSample {
    this.current = this.measure(now);
    return this.current;
  }

  /**
   * Read the probe once; invalid CPU readings stay unknown rather than zero.
   *
   * @param now - Supervisor clock.
   * @returns Normalized sample.
   */
  private measure(now: number): ResourceSample {
    const measured = this.probe();
    const cpu = measured.cpuPercent;
    return {
      freeMemoryMb: measured.freeMemoryMb,
      totalMemoryMb: measured.totalMemoryMb,
      cpuPercent: cpu !== null && Number.isFinite(cpu) && cpu >= 0 && cpu <= PERCENT ? cpu : null,
      observedAt: now,
    };
  }
}

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
 * Classify the machine resource gate that parks a new assignment.
 *
 * @param config - Project resource limits.
 * @param snapshot - Actual OS counters.
 * @param activeJobs - Running model/check pipelines.
 * @returns Structured blocker, null when capacity is available.
 */
export function resourceBlockerCode(
  config: FactoryConfig,
  snapshot: ResourceSnapshot,
  activeJobs: number,
): keyof typeof RESOURCE_MESSAGES | null {
  const limits = config.resources;
  if (activeJobs >= limits.maxActiveJobs) {
    return 'job_cap';
  }
  if (
    snapshot.freeMemoryMb < limits.minFreeMemoryMb ||
    (snapshot.freeMemoryMb / snapshot.totalMemoryMb) * PERCENT < limits.minFreeMemoryPercent
  ) {
    return 'memory';
  }
  return snapshot.cpuPercent !== null && snapshot.cpuPercent > limits.maxCpuPercent ? 'cpu' : null;
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
  const code = resourceBlockerCode(config, snapshot, activeJobs);
  return code === null ? null : RESOURCE_MESSAGES[code];
}

/**
 * Combine machine and provider gates in dispatch order.
 *
 * @param config - Effective broker-wide policy.
 * @param snapshot - Cached OS counters.
 * @param activeJobs - Broker-wide owned pipelines.
 * @param providers - Per-provider blockers from the dispatch conditions.
 * @returns First gate dispatch would stop at, or none.
 */
export function admissionBlocker(
  config: FactoryConfig,
  snapshot: ResourceSnapshot,
  activeJobs: number,
  providers: Readonly<Record<Provider, ProviderBlocker | null>>,
): AdmissionBlocker {
  const resource = resourceBlockerCode(config, snapshot, activeJobs);
  if (resource !== null) {
    return resource;
  }
  const reasons = Object.values(providers);
  if (reasons.includes(null)) {
    return 'none';
  }
  if (reasons.includes('concurrency')) {
    return 'provider_cap';
  }
  return reasons.some((reason) => reason === 'cooldown' || reason === 'subscription')
    ? 'provider_cooldown'
    : 'provider_unavailable';
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

/** One pipeline owned by the selected project's supervisor. */
export type OwnedPipeline = Pick<
  FactoryJob,
  'id' | 'role' | 'kind' | 'provider' | 'state' | 'featureId' | 'taskId' | 'startedAt'
>;
/** Bounded admission evidence exposed through factory status. */
export interface AdmissionEvidence {
  /** Cached measurement from the latest scheduling cycle. */
  readonly sample: ResourceSample;
  /** Effective configured ceilings, absent before setup. */
  readonly limits: {
    readonly maxActiveJobs: number;
    readonly maxCpuPercent: number;
    readonly minFreeMemoryMb: number;
    readonly minFreeMemoryPercent: number;
    readonly providers: Record<Provider, { readonly enabled: boolean; readonly concurrency: number }>;
  } | null;
  /** This project's owned pipelines, including teardown. */
  readonly running: OwnedPipeline[];
  /** Anonymous broker-wide reservation count across all projects. */
  readonly brokerReservations: number;
  /** Per-provider dispatch conditions, absent before setup. */
  readonly providers: Record<Provider, ProviderBlocker | null> | null;
  /** First gate dispatch would stop at, absent before setup. */
  readonly blocker: AdmissionBlocker | null;
}

/**
 * Explain admission with the same policy, provider and resource rules dispatch uses.
 *
 * @param repository - Selected project's durable ledger.
 * @param pool - Broker-wide admission pool.
 * @param sample - Cached measurement; the probe is never called here.
 * @param owned - Pipelines owned by this project's supervisor.
 * @returns Evidence that reveals other projects only as a count.
 */
export function admissionEvidence(
  repository: FactoryRepository,
  pool: AdmissionPool,
  sample: ResourceSample,
  owned: ReadonlyMap<string, unknown>,
): AdmissionEvidence {
  const settings = repository.config();
  const running = repository
    .jobs()
    .filter((job) => owned.has(job.id))
    .map(({ id, role, kind, provider, state, featureId, taskId, startedAt }) => {
      return {
        id,
        role,
        kind,
        provider,
        state,
        featureId,
        taskId,
        startedAt,
      };
    });
  const base = { sample, running, brokerReservations: pool.size };
  if (settings === null) {
    return { ...base, limits: null, providers: null, blocker: null };
  }
  const policy = pool.policy(settings);
  const now = repository.store.now();
  const providers = providerBlockers({
    config: policy,
    capacities: pool.preview(
      PROVIDERS.map((name) => repository.capacity(name, settings, false)),
      now,
    ),
    jobs: pool.jobs(),
    now,
  });
  const { maxActiveJobs, maxCpuPercent, minFreeMemoryMb, minFreeMemoryPercent } = policy.resources;
  const limit = (name: Provider): { enabled: boolean; concurrency: number } => {
    return {
      enabled: policy.providers[name].enabled,
      concurrency: policy.providers[name].concurrency,
    };
  };
  return {
    ...base,
    limits: {
      maxActiveJobs,
      maxCpuPercent,
      minFreeMemoryMb,
      minFreeMemoryPercent,
      providers: { codex: limit('codex'), claude: limit('claude') },
    },
    providers,
    blocker: admissionBlocker(policy, sample, pool.size, providers),
  };
}
