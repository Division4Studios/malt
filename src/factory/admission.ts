/**
 * Shared admission across project supervisors in one local broker process.
 *
 * @file
 */

import { MeshError } from '../protocol.ts';

import type { Capacity, FactoryConfig, FactoryJob } from './schema.ts';

/** Owned pipelines retain their policy until all descendants have settled. */
interface Reservation {
  /** Durable process claim. */
  readonly job: AdmissionJob;
  /** Operator-selected ceilings at claim time. */
  readonly settings: FactoryConfig;
}
/** Logical occupancy shared by assignments and operator terminals. */
export type AdmissionJob = Pick<FactoryJob, 'id' | 'provider' | 'state'>;

/** Provider families share the broker's native subscription account by default. */
export class AdmissionPool {
  /** Only this broker's owned live pipelines. */
  private readonly reservations = new Map<string, Reservation>();
  /** Secret-free measured telemetry, never an invented subscription quota. */
  private readonly telemetry = new Map<FactoryJob['provider'], Capacity>();

  /**
   * Number of owned pipelines, including process teardown.
   *
   * @returns Current broker-wide pipeline count.
   */
  public get size(): number {
    return this.reservations.size;
  }

  /**
   * Supply all live provider assignments to the same scheduling rules.
   *
   * @returns Broker-wide live claims.
   */
  public jobs(): AdmissionJob[] {
    return this.reservations
      .values()
      .map((entry) => entry.job)
      .toArray();
  }

  /**
   * Retain the strictest live project's process ceilings during admission.
   *
   * @param requested - Prospective project's explicit policy.
   * @returns Effective policy without altering persisted project settings.
   */
  public policy(requested: FactoryConfig): FactoryConfig {
    const effective = structuredClone(requested);
    for (const entry of this.reservations.values()) {
      effective.resources.maxActiveJobs = Math.min(
        effective.resources.maxActiveJobs,
        entry.settings.resources.maxActiveJobs,
      );
      for (const provider of ['codex', 'claude'] as const) {
        effective.providers[provider].concurrency = Math.min(
          effective.providers[provider].concurrency,
          entry.settings.providers[provider].concurrency,
        );
      }
    }
    return effective;
  }

  /**
   * Reserve a committed claim before starting any owned subprocess.
   *
   * @param job - Transactionally claimed current job.
   * @param settings - Project policy at admission time.
   * @throws {MeshError} When a pipeline is registered twice.
   */
  public add(job: AdmissionJob, settings: FactoryConfig): void {
    if (this.reservations.has(job.id)) {
      throw new MeshError('FACTORY_GATED', 'This pipeline already owns local resources.');
    }
    this.reservations.set(job.id, { job, settings });
  }

  /**
   * Release only after owned processes and their descendants have exited.
   *
   * @param id - Owned durable pipeline identity.
   */
  public delete(id: string): void {
    this.reservations.delete(id);
  }

  /**
   * Share observed cooldowns and measured quota without sharing credentials.
   *
   * @param capacities - Durable selected-project accounting snapshots.
   * @param now - Current supervisor clock for native reset/cooldown expiry.
   * @returns Project budgets with conservative broker-wide provider readiness.
   */
  public capacities(capacities: readonly Capacity[], now: number): Capacity[] {
    return capacities.map((capacity) => {
      const merged = this.merge(capacity, now);
      this.telemetry.set(capacity.provider, merged.telemetry);
      return merged.capacity;
    });
  }

  /**
   * Apply the same broker-wide merge without recording any observation.
   *
   * @param capacities - Durable selected-project accounting snapshots.
   * @param now - Current supervisor clock.
   * @returns Capacities dispatch would see, for read-only evidence.
   */
  public preview(capacities: readonly Capacity[], now: number): Capacity[] {
    return capacities.map((capacity) => this.merge(capacity, now).capacity);
  }

  /**
   * Merge one project snapshot with shared broker telemetry.
   *
   * @param capacity - Selected-project accounting snapshot.
   * @param now - Current supervisor clock.
   * @returns Effective capacity and the telemetry dispatch retains.
   */
  private merge(capacity: Capacity, now: number): { capacity: Capacity; telemetry: Capacity } {
    const previous = this.telemetry.get(capacity.provider);
    const reported =
      previous === undefined || (capacity.telemetrySource !== null && capacity.updatedAt > previous.updatedAt)
        ? capacity
        : previous;
    const cooldownUntil = Math.max(capacity.cooldownUntil, previous?.cooldownUntil ?? 0);
    return {
      telemetry: { ...reported, cooldownUntil },
      capacity: {
        ...capacity,
        cooldownUntil,
        subscriptionUsedPercent:
          reported.subscriptionResetAt !== null && reported.subscriptionResetAt <= now
            ? null
            : reported.subscriptionUsedPercent,
        subscriptionResetAt: reported.subscriptionResetAt,
        telemetrySource: reported.telemetrySource,
      },
    };
  }
}
/** Every project served by this broker shares one native-process admission pool. */
export const brokerAdmission = new AdmissionPool();
