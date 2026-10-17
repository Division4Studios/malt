/**
 * Wire one running attempt to its liveness monitor: progress is sampled from
 * signals the supervisor already owns, the record is persisted only while the
 * attempt's fencing token is current, and a stall or the ceiling aborts the
 * attempt with its recorded reason. Cancellation, pause and shutdown keep
 * aborting the same controller immediately.
 *
 * @file
 */
import { extensionHold } from './extension-gate.ts';
import { livenessPolicy } from './liveness-schema.ts';
import { LivenessMonitor } from './liveness.ts';
import { ProgressSampler } from './progress-signals.ts';

import type { JobLiveness } from './liveness-schema.ts';
import type { LivenessTimers } from './liveness.ts';
import type { FactoryRepository } from './repository.ts';
import type { ResourceSnapshot } from './resources.ts';
import type { FactoryConfig, FactoryJob } from './schema.ts';

/** Prefix of the abort reason a checkpoint stop records. */
const STOP_PREFIX = 'Assignment stopped at its checkpoint:';

/**
 * The checkpoint stop reason recorded on a liveness record, if it stopped the attempt.
 *
 * @param liveness - Final record.
 * @returns `stalled N min` or `hard ceiling`, or null.
 */
export function checkpointStop(liveness: JobLiveness | undefined): string | null {
  return liveness?.state === 'stalled' || liveness?.state === 'ceiling' || liveness?.state === 'held'
    ? liveness.stopReason
    : null;
}

/**
 * Start supervising one attempt's liveness.
 *
 * @param input - Attempt, ledger, policy, cancellation and worktree.
 * @param input.repository - Project ledger.
 * @param input.job - Claimed attempt.
 * @param input.settings - Project policy.
 * @param input.controller - Whole-attempt cancellation.
 * @param input.worktree - Owned worktree once prepared, for code-editing steps.
 * @param input.timers - Timers, real ones by default.
 * @param input.gate - Supported quota refresh and machine counters; without it every productive checkpoint extends.
 * @returns Started monitor; dispose it when the attempt settles.
 */
export function superviseLiveness(input: {
  repository: FactoryRepository;
  job: FactoryJob;
  settings: FactoryConfig;
  controller: AbortController;
  worktree: () => string | null;
  timers?: LivenessTimers;
  gate?: { readonly refresh: () => Promise<void>; readonly resources: () => ResourceSnapshot };
}): LivenessMonitor {
  const { repository, job } = input;
  const sampler = new ProgressSampler({
    store: repository.store,
    jobId: job.id,
    provider: job.provider,
    artifact: job.artifact,
    worktree: input.worktree,
  });
  const monitor = new LivenessMonitor({
    startedAt: job.startedAt,
    policy: livenessPolicy(input.settings),
    now: () => repository.store.now(),
    sample: async () => await sampler.sample(),
    record: (liveness) => {
      const current = repository.jobs().find((candidate) => candidate.id === job.id);
      if (current?.state === 'running' && current.token === job.token) {
        repository.saveJob({ ...current, liveness });
      }
    },
    stop: (reason) => {
      input.controller.abort(new Error(`${STOP_PREFIX} ${reason}.`));
    },
    ...(input.timers !== undefined && { timers: input.timers }),
    ...(input.gate !== undefined && { gate: extensionCheck(input.repository, job, input.settings, input.gate) }),
  });
  monitor.start();
  return monitor;
}

/**
 * The extension gate for one attempt: refresh supported quota, then check its
 * provider's verified headroom, cooldown and the machine's pressure.
 *
 * @param repository - Project ledger.
 * @param job - Supervised attempt.
 * @param settings - Project policy.
 * @param gate - Quota refresh and machine counters.
 * @param gate.refresh - Supported, unpaid quota refresh.
 * @param gate.resources - Latest machine counters.
 * @returns Gate resolving to a refusal reason, or null to extend.
 */
function extensionCheck(
  repository: FactoryRepository,
  job: FactoryJob,
  settings: FactoryConfig,
  gate: { readonly refresh: () => Promise<void>; readonly resources: () => ResourceSnapshot },
): () => Promise<string | null> {
  return async () => {
    await gate.refresh();
    const sharing = repository
      .jobs()
      .filter((candidate) => candidate.state === 'running' && candidate.provider === job.provider).length;
    const hold = extensionHold({
      capacity: repository.capacity(job.provider, settings),
      settings,
      resources: gate.resources(),
      sharing,
      now: repository.store.now(),
    });
    return hold?.reason ?? null;
  };
}
