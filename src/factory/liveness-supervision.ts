/**
 * Wire one running attempt to its liveness monitor: progress is sampled from
 * signals the supervisor already owns, the record is persisted only while the
 * attempt's fencing token is current, and a stall or the ceiling aborts the
 * attempt with its recorded reason. Cancellation, pause and shutdown keep
 * aborting the same controller immediately.
 *
 * @file
 */
import { livenessPolicy } from './liveness-schema.ts';
import { LivenessMonitor } from './liveness.ts';
import { ProgressSampler } from './progress-signals.ts';

import type { JobLiveness } from './liveness-schema.ts';
import type { LivenessTimers } from './liveness.ts';
import type { FactoryRepository } from './repository.ts';
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
  return liveness?.state === 'stalled' || liveness?.state === 'ceiling' ? liveness.stopReason : null;
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
 * @returns Started monitor; dispose it when the attempt settles.
 */
export function superviseLiveness(input: {
  repository: FactoryRepository;
  job: FactoryJob;
  settings: FactoryConfig;
  controller: AbortController;
  worktree: () => string | null;
  timers?: LivenessTimers;
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
  });
  monitor.start();
  return monitor;
}
