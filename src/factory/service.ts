/**
 * Autonomous project supervisor; parked roles consume no model turns or processes.
 *
 * @file
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { MeshError } from '../protocol.ts';
import { writeAtomic } from '../summary.ts';

import { brokerAdmission as LOCAL_JOBS } from './admission.ts';
import { providerPreflight } from './authentication.ts';
import { completeJob, rejectDelivery } from './completion.ts';
import {
  recordCancellation,
  shouldParkForMemory,
  recoverUnownedClaims,
  recordScopeFeedback,
  recordCapacity,
  latestLearningFeedback,
  refundUnpaidAttempt,
} from './controls.ts';
import { enqueueDelivery } from './enqueue.ts';
import { executeJob, retireSnapshot } from './execution.ts';
import { settlementEvidence } from './handoffs.ts';
import { applyInstructionRequest } from './instruction-requests.ts';
import { exportMaintenance } from './maintenance.ts';
import { reorderObjective } from './objective-order.ts';
import { deliveryFocus } from './objective-queue-schema.ts';
import { queueObjective } from './objectives.ts';
import { runProcess } from './processes.ts';
import { recordProgress } from './progress.ts';
import { runAgent } from './providers.ts';
import { QuotaObserver } from './quota.ts';
import { reconcile } from './reconcile.ts';
import { recoverObjective } from './recovery.ts';
import { GitHubDelivery } from './remote.ts';
import { FactoryRepository } from './repository.ts';
import { ResourceSampler, admissionEvidence, resourceBlocker, resourceProbe } from './resources.ts';
import { routeAssignment } from './routing.ts';
import { chooseProvider, retryFeaturePhase, jobIntents } from './scheduler.ts';
import { LEASE_MS, PROVIDERS, factoryConfigSchema, factorySchemas } from './schema.ts';
import { replaceScope } from './scope-changes.ts';
import { decideSkill } from './skill-approval.ts';
import { installFactorySkills } from './skills.ts';
import { readSource } from './source-reader.ts';
import { factoryStatus } from './status.ts';
import * as triage from './triage.ts';
import { WorkspaceManager } from './workspaces.ts';

import type { MeshConfig } from '../config.ts';
import type { ProjectGitHub } from '../github.ts';
import type { ProjectLearning } from '../learning.ts';
import type { Store } from '../store.ts';
import type { FactoryContext, ExecutedJob } from './context.ts';
import type { ProcessRunner } from './processes.ts';
import type { AgentRunner } from './providers.ts';
import type { DeliveryRemote } from './remote.ts';
import type { ResourceProbe } from './resources.ts';
import type { JobIntent } from './scheduler.ts';
import type { FactoryJob, FactoryOperation } from './schema.ts';

/** Unpaid scheduler heartbeat interval. */
const TICK_MS = 5000;
/** Runtime dependency substitutions for isolated tests. */
export interface FactoryOptions {
  /** Broker discovery root. */
  readonly home: string;
  /** Isolated inference boundary. */
  readonly agent?: AgentRunner;
  /** Isolated check boundary. */
  readonly processes?: ProcessRunner;
  /** Actual or fixture GitHub delivery. */
  readonly remote?: DeliveryRemote;
  /** OS measurement adapter. */
  readonly resources?: ResourceProbe;
}
/** One cancellable pipeline owned by this supervisor. */
interface Running {
  /** Cancellation kills the owned process tree. */
  readonly controller: AbortController;
  /** Pipeline completion awaited before closing SQLite. */
  readonly promise: Promise<void>;
}
/** Attempt evidence accumulated before settlement. */
interface AttemptState {
  /** Actual provider/check result. */
  execution: ExecutedJob | null;
  /** Whether inference was launched. */
  isInferred: boolean;
  /** Fenced job outcome. */
  state: 'succeeded' | 'failed' | 'interrupted';
  /** Supervisor-observed failure or cancellation reason for the manager report. */
  reason: string | null;
}
/** Sole lease-owning supervisor for one target project. */
export class FactoryService {
  /** Public durable ledger for inspection and operator commands. */
  public readonly repository: FactoryRepository;
  /** Dependencies selected at construction. */
  private readonly options: FactoryOptions;
  /** Project scope. */
  private readonly mesh: MeshConfig;
  /** Scoped integrations. */
  private readonly github: ProjectGitHub;
  /** Shared project skill library. */
  private readonly learning: ProjectLearning;
  /** Sole-process lease token. */
  private readonly owner = randomUUID();
  /** Cancel owned metadata probes along with managed jobs. */
  private readonly quota = new QuotaObserver();
  /** Managed pipelines only; never unrelated processes. */
  private readonly running = new Map<string, Running>();
  /** Sole stateful sampler; only the scheduling cycle advances it. */
  private readonly sampler: ResourceSampler;
  /** Validated execution context, absent before setup. */
  private context: FactoryContext | null = null;
  /** Unpaid timer. */
  private timer: NodeJS.Timeout | null = null;
  /** Prevent overlapping external reconciliation. */
  private driving: Promise<void> | null = null;
  /** Actual verified connection is mandatory before inference. */
  private connected = false;
  /** Last operator-visible infrastructure problem. */
  private error: string | null = null;
  /** Next unpaid remote retry. */
  private nextReconcile = 0;
  /** Shutdown fence. */
  private stopped = false;
  /** Recovery runs once per acquired durable supervisor lease. */
  private hasLease = false;

  /**
   * Construct project-local coordination without launching any role.
   *
   * @param mesh - Target project.
   * @param store - Its broker ledger.
   * @param integrations - Validated integrations input.
   * @param options - Execution substitutions and broker home.
   */
  public constructor(
    mesh: MeshConfig,
    store: Store,
    integrations: { github: ProjectGitHub; learning: ProjectLearning },
    options: FactoryOptions,
  ) {
    this.mesh = mesh;
    this.github = integrations.github;
    this.learning = integrations.learning;
    this.options = options;
    this.repository = new FactoryRepository(store);
    this.sampler = new ResourceSampler(options.resources ?? resourceProbe(), store.now());
  }

  /**
   * Build the current immutable project execution context.
   *
   * @returns Configured context.
   * @throws {MeshError} When the selected factory has not been configured.
   */
  public configured(): FactoryContext {
    if (this.context !== null) {
      return this.context;
    }
    const settings = this.repository.config();
    if (settings === null) {
      throw new MeshError('FACTORY_GATED', 'Configure this target project and its validation commands first.');
    }
    const processes = this.options.processes ?? runProcess;
    installFactorySkills(this.mesh);
    this.context = {
      mesh: this.mesh,
      home: this.options.home,
      repository: this.repository,
      settings,
      remote: this.options.remote ?? new GitHubDelivery(this.mesh, this.github),
      learning: this.learning,
      workspaces: new WorkspaceManager(this.mesh, settings),
      processes,
      agent: this.options.agent ?? (async (request) => runAgent(request, processes)),
    };
    return this.context;
  }

  /**
   * Inspect real local factory state without invoking a model.
   *
   * @returns Dashboard and MCP state.
   */
  public async status(): Promise<unknown> {
    return factoryStatus(this.repository, this.mesh, {
      connected: this.connected,
      error: this.error,
      resources: this.sampler.latest,
      admission: admissionEvidence(this.repository, LOCAL_JOBS, this.sampler.latest, this.running),
    });
  }

  /** Resume durable requested operation after broker restart. */
  public resume(): void {
    if (this.repository.active()) {
      this.begin();
    }
  }

  /** Heartbeat remains independent of slow network calls and paid turns. */
  public async tick(): Promise<void> {
    if (this.stopped || (!this.repository.active() && this.running.size === 0)) {
      return;
    }
    if (!this.repository.lease(this.owner)) {
      this.hasLease = false;
      this.error = 'Supervisor lease lost.';
      for (const run of this.running.values()) {
        run.controller.abort(new Error('Supervisor lease lost.'));
      }
      return;
    }
    if (!this.hasLease) {
      recoverUnownedClaims(this.repository, this.running);
      this.hasLease = true;
    }
    const candidates1 = this.repository
      .jobs()
      .filter((candidate) => this.running.has(candidate.id) && candidate.state === 'running');
    for (const job of candidates1) {
      this.repository.saveJob({ ...job, expiresAt: this.repository.store.now() + LEASE_MS });
    }
    if (!this.repository.active() || this.driving !== null) {
      return;
    }
    this.driving = this.driveSafely();
    try {
      await this.driving;
    } finally {
      this.driving = null;
    }
  }

  /**
   * Stop owned pipelines before the broker closes its database.
   *
   * @param shouldPause - Validated shouldPause input.
   */
  public async close(shouldPause = false): Promise<void> {
    this.stopped = true;
    if (shouldPause) {
      this.repository.setActive(false);
    }
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const run of this.running.values()) {
      run.controller.abort(new Error('Supervisor stopped; owned assignment interrupted.'));
    }
    this.quota.cancel();
    await Promise.allSettled(this.running.values().map(async (run) => run.promise));
    if (this.driving !== null) {
      await this.driving;
    }
    this.repository.release(this.owner);
    this.hasLease = false;
    this.connected = false;
  }

  /**
   * Execute validated human/designated-lead factory controls.
   *
   * @param operation - Project factory operation.
   * @param input - Untrusted wire input.
   * @param actorId - Authenticated session identity for job-scoped source reads.
   * @returns Current state or durable request identity.
   */
  public async execute(operation: FactoryOperation, input: unknown, actorId: string | null = null): Promise<unknown> {
    const parsed = factorySchemas[operation].parse(input);
    const handlers: Record<FactoryOperation, () => unknown> = {
      factory_recover: () => recoverObjective(this.repository, parsed),
      factory_progress: () => recordProgress(this.configured(), parsed, actorId),
      factory_triage: () => triage.decideTriage(this.repository, parsed, actorId),
      factory_read_source: async () => readSource(this.configured(), parsed, actorId),
      factory_export_maintenance: async () => {
        return exportMaintenance(
          { mesh: this.mesh, home: this.options.home, repository: this.repository, learning: this.learning },
          parsed,
        );
      },
      factory_skill_decide: async () => decideSkill(this.configured(), parsed),
      factory_instruct: () => this.controlInstruct(parsed),
      factory_status: async () => this.status(),
      factory_setup: () => this.controlSetup(parsed),
      factory_start: async () => {
        this.configured();
        this.repository.setActive(true);
        this.begin();
        return this.status();
      },
      factory_pause: async () => {
        await this.close(true);
        return this.status();
      },
      factory_request: () => queueObjective(this.repository, parsed),
      factory_queue: () => this.repository.objectiveQueue.update(parsed),
      factory_capacity: async () => {
        recordCapacity(this.configured(), parsed);
        return this.status();
      },
      factory_cancel_job: () => this.controlCancelJob(parsed),
      factory_reorder_objective: () => reorderObjective(this.repository.store, parsed),
      factory_retry: () => this.controlRetry(parsed),
      factory_enqueue: async () => enqueueDelivery(this.configured(), parsed),
    };
    const result = await Promise.resolve(handlers[operation]());
    return result;
  }

  /** Isolate unpaid infrastructure failures from the heartbeat loop. */
  private async driveSafely(): Promise<void> {
    try {
      await this.drive();
    } catch (error) {
      this.error = Error.isError(error) ? error.message : 'Factory supervision failed.';
    }
  }

  /**
   * Begin unpaid scheduling, recovering attempts only under the sole lease.
   *
   * @throws {MeshError} When this factory has no valid project policy.
   */
  private begin(): void {
    this.configured();
    this.stopped = false;
    this.timer ??= setInterval(() => {
      void this.tick();
    }, TICK_MS);
    this.timer.unref();
    void this.tick();
  }

  /** Verify the remote, reconcile durable intents, then admit bounded jobs. */
  private async drive(): Promise<void> {
    const context = this.configured();
    if (shouldParkForMemory(context, this.running, this.sampler.sample(this.repository.store.now()))) {
      this.error = 'Critical memory pressure; owned assignments stopped, awaiting recovery.';
      return;
    }
    const now = this.repository.store.now();
    if (now >= this.nextReconcile) {
      this.nextReconcile = now + context.settings.reconcileMs;
      if (!this.connected) {
        await context.remote.verify(await context.workspaces.origin());
        if (this.options.agent === undefined) {
          const providers = await providerPreflight(context.settings, this.mesh.root);
          writeAtomic(
            path.join(this.mesh.directory, 'factory', 'readiness.json'),
            `${JSON.stringify({ providers, checkedAt: this.repository.store.now() }, null, 2)}\n`,
          );
        }
        this.connected = true;
      }
      await reconcile(context);
      triage.queueBlockerInvestigations(this.repository);
      this.error = null;
    }
    if (!this.connected || this.stopped || !this.repository.active()) {
      return;
    }
    this.cancelStale();
    const scheduling = {
      feedbackAt: latestLearningFeedback(this.repository),
      config: context.settings,
      tasks: this.repository.tasks(),
      features: this.repository.features(),
      objectiveQueue: this.repository.objectiveQueue.read(),
      jobs: this.repository.jobs(),
      skillRequests: this.repository.skillRequests(),
      triage: triage.pendingTriage(this.repository, deliveryFocus(this.repository.objectiveQueue.read())),
      now,
    };
    const intents = jobIntents(scheduling);
    await this.refreshQuota(context, intents.length);
    if (
      !this.canDispatch() ||
      JSON.stringify(scheduling.objectiveQueue) !== JSON.stringify(this.repository.objectiveQueue.read())
    ) {
      return;
    }
    for (const intent of intents) {
      const policy = LOCAL_JOBS.policy(context.settings);
      if (resourceBlocker(policy, this.sampler.latest, LOCAL_JOBS.size) !== null) {
        break;
      }
      const provider = chooseProvider({
        config: policy,
        capacities: LOCAL_JOBS.capacities(
          PROVIDERS.map((name) => this.repository.capacity(name, context.settings)),
          now,
        ),
        jobs: LOCAL_JOBS.jobs(),
        now,
      });
      if (provider === null) {
        break;
      }
      this.dispatch(intent, provider);
    }
  }

  /**
   * Read supported native quota without starting a model turn.
   *
   * @param context - Verified project executables and resource policy.
   * @param count - Eligible role assignments.
   */
  private async refreshQuota(context: FactoryContext, count: number): Promise<void> {
    if (
      count === 0 ||
      this.options.agent !== undefined ||
      resourceBlocker(LOCAL_JOBS.policy(context.settings), this.sampler.latest, LOCAL_JOBS.size) !== null
    ) {
      return;
    }
    await this.quota.observe(context);
  }

  /**
   * Recheck dispatch authority after an asynchronous diagnostic.
   *
   * @returns Whether this supervisor still owns active dispatch.
   */
  private canDispatch(): boolean {
    return !this.stopped && this.repository.active();
  }

  /** Stop reviewers whose exact source or assigned stage was invalidated. */
  private cancelStale(): void {
    const candidates3 = this.repository
      .jobs()
      .filter((candidate) => candidate.state === 'running' && candidate.taskId !== null);
    for (const job of candidates3) {
      if (job.taskId === null || job.kind === 'develop') {
        continue;
      }
      const task = this.repository.task(job.taskId);
      if (job.kind === 'triage') {
        if (!triage.isCurrentTriage(this.repository, job)) {
          this.running.get(job.id)?.controller.abort();
        }
        continue;
      }
      const phases = {
        review: 'review',
        final: 'merge_ready',
        verify: 'verifying',
        plan: '',
        refine: '',
        develop: '',
        learn: '',
        skill: '',
        triage: '',
      } as const;
      if (task.phase !== phases[job.kind] || task.head !== job.head || task.base !== job.base) {
        this.running.get(job.id)?.controller.abort(new Error('Assignment source or stage was invalidated.'));
      }
    }
  }

  /**
   * Atomically claim a role and its provider reservation.
   *
   * @param intent - Eligible assignment.
   * @param provider - Capacity-selected provider.
   */
  private dispatch(intent: JobIntent, provider: FactoryJob['provider']): void {
    const context = this.configured();
    const id = randomUUID();
    const now = this.repository.store.now();
    const job: FactoryJob = {
      ...intent,
      target: intent.target ?? null,
      id,
      provider,
      routing: routeAssignment({
        intent,
        provider,
        settings: context.settings,
        task: intent.taskId === null ? null : this.repository.task(intent.taskId),
      }),
      token: randomUUID(),
      state: 'running',
      startedAt: now,
      finishedAt: null,
      expiresAt: now + LEASE_MS,
      reservation: context.settings.providers[provider].reservationTokens,
      usageTokens: null,
      pid: null,
      summary: null,
      artifact: path.join(this.mesh.directory, 'factory', 'jobs', id),
    };
    if (!this.repository.claim(job, context.settings)) {
      return;
    }
    const controller = new AbortController();
    LOCAL_JOBS.add(job, context.settings);
    const promise = this.perform(job, controller);
    this.running.set(id, { controller, promise });
    void this.releaseAttempt(id, promise);
  }

  /**
   * Release local resource ownership after a fully settled pipeline.
   *
   * @param id - Owned pipeline identity.
   * @param promise - Its completion.
   */
  private async releaseAttempt(id: string, promise: Promise<void>): Promise<void> {
    try {
      await promise;
    } catch (error) {
      this.error = Error.isError(error) ? error.message : 'Attempt settlement failed.';
    } finally {
      this.running.delete(id);
      LOCAL_JOBS.delete(id);
    }
  }

  /**
   * Execute one pipeline; cancellation preserves work and fences late output.
   *
   * @param job - Current claim.
   * @param controller - Whole-pipeline cancellation.
   */
  private async perform(job: FactoryJob, controller: AbortController): Promise<void> {
    const context = this.configured();
    const attempt: AttemptState = { execution: null, isInferred: false, state: 'failed', reason: null };
    const timer = setTimeout(() => {
      controller.abort(new Error(`Assignment exceeded its ${String(context.settings.jobTimeoutMs)} ms timeout.`));
    }, context.settings.jobTimeoutMs);
    try {
      await this.executeAttempt(job, controller, attempt);
    } catch (error) {
      if (controller.signal.aborted || this.stopped) {
        attempt.state = 'interrupted';
        attempt.reason = Error.isError(controller.signal.reason) ? controller.signal.reason.message : null;
      } else {
        attempt.reason = Error.isError(error) ? error.message : 'Managed stage failed.';
        await this.failure(job, attempt.reason);
      }
    } finally {
      clearTimeout(timer);
      await this.settleAttempt(job, attempt);
      this.nextReconcile = 0;
    }
  }

  /**
   * Run and apply an assignment only while its process token is current.
   *
   * @param job - Durable claim.
   * @param controller - Pipeline cancellation.
   * @param attempt - Accumulated execution evidence.
   */
  private async executeAttempt(job: FactoryJob, controller: AbortController, attempt: AttemptState): Promise<void> {
    const outcome = attempt;
    const context = this.configured();
    outcome.execution = await executeJob(context, job, {
      signal: controller.signal,
      onSpawn: (pid) => {
        outcome.isInferred = true;
        const spawned = this.repository.jobs().find((candidate) => candidate.id === job.id);
        if (spawned?.state === 'running' && spawned.token === job.token) {
          this.repository.saveJob({ ...spawned, pid });
        }
      },
    });
    if (controller.signal.aborted || this.stopped) {
      outcome.state = 'interrupted';
      outcome.reason = Error.isError(controller.signal.reason) ? controller.signal.reason.message : null;
      return;
    }
    const current = this.repository.jobs().find((candidate) => candidate.id === job.id);
    if (current?.state !== 'running' || current.token !== job.token) {
      outcome.state = 'interrupted';
      return;
    }
    const { completion } = outcome.execution;
    if (completion !== null) {
      outcome.isInferred = true;
      this.repository.saveJob({ ...current, summary: completion.result?.summary ?? 'No valid provider result.' });
      if (completion.subscriptionUsedPercent !== null) {
        this.repository.saveCapacity({
          ...this.repository.capacity(job.provider, context.settings),
          subscriptionUsedPercent: completion.subscriptionUsedPercent,
          subscriptionResetAt: completion.subscriptionResetAt,
          subscriptionWindows: [...(completion.subscriptionWindows ?? [])],
          telemetrySource: 'native CLI rate-limit event',
          updatedAt: this.repository.store.now(),
        });
      }
      if (completion.cooldownUntil > this.repository.store.now()) {
        outcome.state = 'interrupted';
        return;
      }
    }
    await completeJob(context, job, outcome.execution, controller.signal);
    outcome.state = outcome.execution.waiting === null ? 'succeeded' : 'failed';
  }

  /**
   * Settle usage once and safely retire an immutable role snapshot.
   *
   * @param job - Original token.
   * @param attempt - Executed evidence.
   */
  private async settleAttempt(job: FactoryJob, attempt: AttemptState): Promise<void> {
    triage.settleTriage(this.repository, job, attempt.state);
    const hasSettled = this.repository.finishJob(
      job,
      attempt.execution?.completion?.usageTokens ?? (attempt.isInferred ? null : 0),
      attempt.state,
      settlementEvidence(attempt, this.stopped, this.repository.store.now()),
    );
    refundUnpaidAttempt(this.repository, job, {
      hasSettled,
      isUnpaidGate: attempt.execution?.completion === null && attempt.execution.waiting !== null,
      state: attempt.state,
    });
    await retireSnapshot(this.configured(), attempt.execution?.snapshot ?? null);
  }

  /**
   * Persist actionable blockers without letting rejected QA implement fixes.
   *
   * @param job - Failed assignment.
   * @param reason - Local artifact or gate explanation.
   */
  private async failure(job: FactoryJob, reason: string): Promise<void> {
    this.error = reason;
    if (job.kind === 'triage') {
      triage.completeTriage(this.repository, job, null);
      return;
    }
    if (job.taskId !== null) {
      const task = this.repository.task(job.taskId);
      if (task.scopeReplacement !== undefined) {
        return;
      }
      if (task.phase === 'publishing' || (task.phase === 'blocked' && task.publicationGate !== undefined)) {
        this.repository.editTask(task.id, (current) => ({ ...current, error: reason }));
      } else {
        await rejectDelivery(this.configured(), task, reason);
      }
    } else if (job.featureId !== null) {
      const feature = this.repository.features().find((candidate) => candidate.id === job.featureId);
      if (feature !== undefined) {
        this.repository.saveFeature({
          ...feature,
          phase: 'blocked',
          error: reason,
          updatedAt: this.repository.store.now(),
        });
      }
    }
    this.repository.notify(`${job.role}: ${reason}`);
  }

  /**
   * Handle the validated factory_instruct operator control.
   *
   * @param parsed - Validated control input.
   * @returns Durable control result.
   * @throws {MeshError} When setup, role or task gates reject the request.
   */
  private controlInstruct(parsed: unknown): unknown {
    const value = factorySchemas.factory_instruct.parse(parsed);
    if (value.taskId !== undefined) {
      this.repository.task(value.taskId);
    }
    const result = applyInstructionRequest(this.repository, value, () => {
      const instructionId = this.repository.instruct(value.role, value.taskId ?? null, value.body);
      const replacement = value.replan ? replaceScope(this.repository, { ...value, instructionId }) : null;
      if (value.replan) {
        recordScopeFeedback(this.repository, value.body);
      }
      this.repository.notify(`Operator instruction to ${value.role}: ${value.body}`);
      return { instructionId, replacement };
    });
    const { decision } = result;
    if (!result.isFresh) {
      return decision;
    }
    for (const job of this.repository.jobs()) {
      const isRelevant = value.replan
        ? value.taskId === undefined || decision.replacement?.taskIds.includes(job.taskId ?? '') === true
        : job.role === value.role && (value.taskId === undefined || job.taskId === value.taskId);
      if (isRelevant && job.state === 'running') {
        this.running.get(job.id)?.controller.abort(new Error('Operator instruction changed the active assignment.'));
      }
    }
    return decision;
  }

  /**
   * Handle the validated factory_setup operator control.
   *
   * @param parsed - Validated control input.
   * @returns Durable control result.
   * @throws {MeshError} When setup, role or task gates reject the request.
   */
  private controlSetup(parsed: unknown): unknown {
    if (this.repository.active() || this.running.size > 0) {
      throw new MeshError('FACTORY_GATED', 'Pause managed work before changing project policies.');
    }
    const settings = factoryConfigSchema.parse(parsed);
    this.repository.configure(settings);
    this.context = null;
    installFactorySkills(this.mesh);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Factory policy and execution artifacts are stored in this project's managed directory.
    mkdirSync(path.join(this.mesh.directory, 'factory'), { recursive: true, mode: 0o700 });
    writeAtomic(path.join(this.mesh.directory, 'factory', 'config.json'), `${JSON.stringify(settings, null, 2)}\n`);
    return this.status();
  }

  /**
   * Handle the validated factory_cancel_job operator control.
   *
   * @param parsed - Validated control input.
   * @returns Durable control result.
   * @throws {MeshError} When setup, role or task gates reject the request.
   */
  private controlCancelJob(parsed: unknown): unknown {
    const { jobId } = factorySchemas.factory_cancel_job.parse(parsed);
    const job = this.repository.jobs().find((candidate) => candidate.id === jobId);
    if (job?.state !== 'running' || !this.running.has(jobId)) {
      throw new MeshError('FACTORY_GATED', 'Only a live job owned by this supervisor can be cancelled.');
    }
    recordCancellation(this.repository, job);
    this.running.get(jobId)?.controller.abort(new Error('Operator cancelled this attempt; explicit retry required.'));
    return this.status();
  }

  /**
   * Handle the validated factory_retry operator control.
   *
   * @param parsed - Validated control input.
   * @returns Durable control result.
   * @throws {MeshError} When setup, role or task gates reject the request.
   */
  private controlRetry(parsed: unknown): unknown {
    const value = factorySchemas.factory_retry.parse(parsed);
    if (value.taskId !== undefined) {
      this.repository.editTask(value.taskId, (task) => {
        if (task.phase !== 'blocked' || task.scopeReplacement !== undefined) {
          throw new MeshError('INVALID_INPUT', 'Only blocked deliveries can be retried.');
        }
        return {
          ...task,
          phase: task.merge === null ? 'development' : 'verifying',
          attempts: 0,
          error: null,
          reviews: [],
          finalReview: null,
        };
      });
    }
    if (value.featureId !== undefined) {
      const feature = this.repository.features().find((candidate) => candidate.id === value.featureId);
      if (feature?.phase !== 'blocked' || feature.scopeReplacement !== undefined) {
        throw new MeshError('INVALID_INPUT', 'Only blocked product requests can be retried.');
      }
      this.repository.saveFeature({
        ...feature,
        phase: retryFeaturePhase(feature),
        error: null,
      });
    }
    return this.status();
  }
}
