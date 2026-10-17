/**
 * Autonomous project supervisor; parked roles consume no model turns or processes.
 *
 * @file
 */
import { randomUUID } from 'node:crypto';

import { MeshError } from '../protocol.ts';

import { brokerAdmission as LOCAL_JOBS } from './admission.ts';
import { reconcileGitHub, recoverControl, triageControl } from './adoption.ts';
import * as automation from './automations.ts';
import { completeJob, rejectDelivery } from './completion.ts';
import {
  cancelOwnedJob,
  canDispatch,
  configureProject,
  shouldParkForMemory,
  recoverUnownedClaims,
  recordCapacity,
  latestLearningFeedback,
  refundUnpaidAttempt,
} from './controls.ts';
import { deliveryDiff } from './delivery-diff.ts';
import { admittedAssignment } from './dispatch-admission.ts';
import { enqueueDelivery } from './enqueue.ts';
import { cancelStaleAssignments, executeJob, retireSnapshot } from './execution.ts';
import { settlementEvidence } from './handoffs.ts';
import { heartbeat } from './heartbeat.ts';
import { instructControl } from './instruction-control.ts';
import { IssueGuard } from './issue-guard.ts';
import { attemptRecord } from './job-records.ts';
import { ledgerHandlers } from './ledger-handlers.ts';
import { checkpointStop, superviseLiveness } from './liveness-supervision.ts';
import { exportMaintenance } from './maintenance.ts';
import { updatedModelPolicy } from './model-policy-controls.ts';
import { checkDefinition } from './objective-goals.ts';
import { reorderObjective } from './objective-order.ts';
import { deliveryFocus } from './objective-queue-schema.ts';
import { queueObjective } from './objectives.ts';
import { policySetupBlocker } from './policy-blockers.ts';
import { isPolicyContextVerified } from './policy-routing.ts';
import { runProcess } from './processes.ts';
import { recordProgress } from './progress.ts';
import { runAgent } from './providers.ts';
import { askQuestion, isAwaitingAnswer, didAskOperator } from './questions.ts';
import { QuotaObserver } from './quota.ts';
import { isIntakeParked, reconcileIntake } from './recommendation-intake.ts';
import { recommendationHandlers } from './recommendation-submissions.ts';
import { reconcile } from './reconcile.ts';
import { retryBlocked } from './recovery.ts';
import { GitHubDelivery } from './remote.ts';
import { FactoryRepository } from './repository.ts';
import {
  ResourceSampler,
  admissionEvidence,
  resourceBlocker,
  resourceProbe,
  hasCriticalMemoryPressure,
} from './resources.ts';
import { classifySettlement } from './retry-policy.ts';
import { isManagedToolDenied, roleHandlers } from './role-handlers.ts';
import { jobIntents } from './scheduler.ts';
import { LEASE_MS, factorySchemas } from './schema.ts';
import { decideSkill } from './skill-approval.ts';
import { installFactorySkills } from './skills.ts';
import { readSource } from './source-reader.ts';
import { announceSpendBlocks, refreshSpend, spendGate } from './spend.ts';
import { factoryStatus, preflight } from './status.ts';
import { recoverTerminalMetadata } from './terminal-ownership.ts';
import { TerminalService } from './terminals.ts';
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
import type { TerminalOperation } from './terminal-schema.ts';
import type { TerminalOptions } from './terminals.ts';

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
  /** In-process native terminal substitutes, unavailable to browser/MCP callers. */
  readonly terminals?: TerminalOptions;
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
  /** Error that failed the attempt, used to classify its retry. */
  error: unknown;
  /** The attempt asked the operator a question; its result waits for the answer. */
  isAwaitingAnswer?: boolean;
}
/** Sole lease-owning supervisor for one target project. */
export class FactoryService {
  /** Public durable ledger for inspection and operator commands. */
  public readonly repository: FactoryRepository;
  /** Operator sessions share this supervisor's admission and lifecycle controls. */
  public readonly terminals: TerminalService;
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
  /** Parks deliveries whose GitHub issue is closed before any developer launch. */
  private readonly issueGuard = new IssueGuard();
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
    this.terminals = new TerminalService(mesh, this.repository, {
      ...options.terminals,
      pool: LOCAL_JOBS,
      resources: () => this.sampler.latest,
    });
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
      providerVersions: this.options.agent === undefined ? {} : 'fixture',
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
    return factoryStatus(
      this.repository,
      this.mesh,
      {
        connected: this.connected,
        error: this.error ?? this.issueGuard.waitingReason(this.repository),
        resources: this.sampler.latest,
        admission: admissionEvidence(this.repository, LOCAL_JOBS, this.sampler.latest, this.running),
      },
      this.learning,
    );
  }

  /** Resume durable requested operation after broker restart. */
  public resume(): void {
    if (this.repository.active()) {
      this.begin();
    }
  }

  /**
   * Operator controls share the sole supervisor lease, never managed-job authority.
   *
   * @param operation - Authenticated HTTP-only operation.
   * @param input - Untrusted wire input.
   * @param signal - Exact operator read lifetime.
   * @returns Project-fenced terminal metadata.
   * @throws {MeshError} When another broker owns this project's processes.
   */
  public async terminalControl(operation: TerminalOperation, input: unknown, signal?: AbortSignal): Promise<unknown> {
    if (operation === 'terminal_list' || operation === 'terminal_read') {
      recoverTerminalMetadata(this.repository, this.terminals, this.owner, this.hasLease);
      return this.terminals.control(operation, input, signal);
    }
    if (!this.repository.lease(this.owner)) {
      throw new MeshError('FACTORY_GATED', 'Another supervisor owns this project; reconnect to its console.');
    }
    if (!this.hasLease) {
      recoverUnownedClaims(this.repository, this.running);
      this.terminals.recover();
      this.hasLease = true;
    }
    this.begin();
    return this.terminals.control(operation, input);
  }

  /** Heartbeat remains independent of slow network calls and paid turns. */
  public async tick(): Promise<void> {
    if (this.stopped || (!this.repository.active() && this.running.size === 0 && this.terminals.size === 0)) {
      return;
    }
    if (!this.repository.lease(this.owner)) {
      this.hasLease = false;
      this.error = 'Supervisor lease lost.';
      for (const run of this.running.values()) {
        run.controller.abort(new Error('Supervisor lease lost.'));
      }
      await this.terminals.closeAll('supervisor lease lost');
      return;
    }
    if (!this.hasLease) {
      recoverUnownedClaims(this.repository, this.running);
      this.terminals.recover();
      this.hasLease = true;
    }
    const sample = this.sampler.sample(this.repository.store.now());
    const settings = this.repository.config();
    if (settings !== null && this.terminals.size > 0 && hasCriticalMemoryPressure(settings, sample)) {
      await this.terminals.closeAll('resource pressure');
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
    await this.terminals.closeAll(shouldPause ? 'factory paused' : 'broker shutdown', !shouldPause);
    await Promise.allSettled(this.running.values().map(async (run) => run.promise));
    if (this.driving !== null) {
      await this.driving;
    }
    this.repository.release(this.owner);
    this.hasLease = false;
    this.connected = false;
  }

  /**
   * Fire a loopback webhook trigger presented with its own secret.
   *
   * @param call - Trigger id, presented secret, optional idempotency key and payload text.
   * @returns The objective filed or matched by key.
   */
  public fireTrigger(call: Parameters<typeof automation.fireTrigger>[1]): { featureId: string } {
    return automation.fireTrigger(this.repository, call);
  }

  /**
   * Whether a managed seat's live attempt has a role policy that removed this tool.
   *
   * @param actor - Authenticated managed identity (`factory-<seat>`).
   * @param operation - Requested operation.
   * @returns True when the call must be refused.
   */
  public isToolDenied(actor: string, operation: string): boolean {
    return isManagedToolDenied(this.repository, actor, operation);
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
      factory_recover: async () => recoverControl(this.repository, () => this.configured(), parsed, actorId),
      factory_progress: () => recordProgress(this.configured(), parsed, actorId),
      factory_ask: () => askQuestion(this.configured(), parsed, actorId),
      factory_triage: async () => triageControl(this.repository, () => this.configured(), parsed, actorId),
      factory_reconcile_github: async () => reconcileGitHub(this.configured(), parsed),
      factory_read_source: async () => readSource(this.configured(), parsed, actorId),
      factory_export_maintenance: async () => {
        return exportMaintenance(
          { mesh: this.mesh, home: this.options.home, repository: this.repository, learning: this.learning },
          parsed,
        );
      },
      factory_skill_decide: async () => decideSkill(this.configured(), parsed),
      factory_instruct: () => instructControl(this.repository, this.running, parsed),
      factory_status: async () => this.status(),
      factory_preflight: async () => preflight(this.repository.config(), this.mesh),
      ...recommendationHandlers(() => this.configured(), this.repository, parsed, actorId),
      factory_setup: () => this.controlSetup(parsed),
      factory_model_policy: () => this.controlSetup(updatedModelPolicy(this.configured().settings, parsed)),
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
      factory_cancel_job: async () => {
        cancelOwnedJob(this.repository, this.running, parsed);
        return this.status();
      },
      factory_reorder_objective: () => reorderObjective(this.repository.store, parsed),
      factory_retry: async () => {
        retryBlocked(this.repository, parsed);
        return this.status();
      },
      factory_enqueue: async () => enqueueDelivery(this.configured(), parsed),
      factory_delivery_diff: async () => deliveryDiff(this.configured(), input),
      factory_objective_check: () => checkDefinition(this.configured(), input, actorId),
      ...ledgerHandlers(this.repository, this.mesh, input),
      ...roleHandlers({
        configured: () => this.configured(),
        repository: this.repository,
        directory: this.mesh.directory,
        learning: this.learning,
        setup: (settings) => this.controlSetup(settings),
        input,
      }),
    };
    return await handlers[operation]();
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
    this.timer = heartbeat(this.timer, TICK_MS, this.tick.bind(this));
  }

  /** Verify the remote, reconcile durable intents, then admit bounded jobs. */
  private async drive(): Promise<void> {
    const context = this.configured();
    const setupBlocker = policySetupBlocker(context);
    if (setupBlocker !== null) {
      this.error = setupBlocker;
      return;
    }
    if (shouldParkForMemory(context, this.running, this.sampler.latest)) {
      this.error = 'Critical memory pressure; owned assignments stopped, awaiting recovery.';
      return;
    }
    const now = this.repository.store.now();
    if (now >= this.nextReconcile) {
      this.nextReconcile = now + context.settings.reconcileMs;
      if (!this.connected) {
        if (
          !(await isPolicyContextVerified(
            context,
            () => this.context === context && canDispatch(this.repository, this.stopped),
          ))
        ) {
          return;
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
    await reconcileIntake(context);
    if (!canDispatch(this.repository, this.stopped)) {
      return;
    }
    automation.fireDueSchedules(this.repository);
    cancelStaleAssignments(this.repository, this.running);
    await refreshSpend(this.repository, this.mesh);
    const spend = spendGate(this.repository);
    announceSpendBlocks(this.repository, spend);
    const scheduling = {
      isSpendBlocked: (target: { taskId: string | null; featureId: string | null }) => spend.block(target) !== null,
      feedbackAt: latestLearningFeedback(this.repository),
      config: context.settings,
      tasks: this.repository.tasks(),
      features: this.repository.features().filter((feature) => !isIntakeParked(context, feature)),
      objectiveQueue: this.repository.objectiveQueue.read(),
      jobs: this.repository.jobs(),
      skillRequests: this.repository.skillRequests(),
      triage: triage.pendingTriage(this.repository, deliveryFocus(this.repository.objectiveQueue.read())),
      now,
    };
    const intents = jobIntents(scheduling);
    await this.refreshQuota(context, intents.length);
    if (
      !canDispatch(this.repository, this.stopped) ||
      JSON.stringify(scheduling.objectiveQueue) !== JSON.stringify(this.repository.objectiveQueue.read())
    ) {
      return;
    }
    for (const intent of intents) {
      if (
        isAwaitingAnswer(this.repository.store, intent) ||
        admittedAssignment(context, this.sampler.latest, LOCAL_JOBS, intent) === null
      ) {
        continue;
      }
      // eslint-disable-next-line no-await-in-loop -- A developer claim waits for its unpaid issue-state decision.
      await this.issueGuard.launch(context, intent, this.dispatch.bind(this, intent));
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
   * Atomically claim a role and its provider reservation.
   *
   * @param intent - Eligible assignment.
   */
  private dispatch(intent: JobIntent): void {
    if (!canDispatch(this.repository, this.stopped)) {
      return;
    }
    const context = this.configured();
    const admitted = admittedAssignment(context, this.sampler.latest, LOCAL_JOBS, intent);
    if (admitted === null) {
      return;
    }
    const job = attemptRecord(context, intent, admitted);
    const { id } = job;
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
    const attempt: AttemptState = { execution: null, isInferred: false, state: 'failed', reason: null, error: null };
    const owned: { cwd: string | null } = { cwd: null };
    const monitor = superviseLiveness({
      repository: this.repository,
      job,
      settings: context.settings,
      controller,
      worktree: () => owned.cwd,
    });
    try {
      await this.executeAttempt(job, controller, attempt, owned);
    } catch (error) {
      attempt.error = error;
      if (controller.signal.aborted || this.stopped) {
        attempt.state = 'interrupted';
        attempt.reason = Error.isError(controller.signal.reason) ? controller.signal.reason.message : null;
      } else if (didAskOperator(this.repository, job, attempt)) {
        attempt.reason = null;
      } else {
        attempt.reason = Error.isError(error) ? error.message : 'Managed stage failed.';
        await this.failure(job, attempt.reason);
      }
    } finally {
      monitor.dispose();
      await this.settleAttempt(job, attempt, checkpointStop(monitor.liveness));
      this.nextReconcile = 0;
    }
  }

  /**
   * Run and apply an assignment only while its process token is current.
   *
   * @param job - Durable claim.
   * @param controller - Pipeline cancellation.
   * @param attempt - Accumulated execution evidence.
   * @param owned - Receives the owned worktree once prepared.
   * @param owned.cwd - Owned worktree path.
   */
  private async executeAttempt(
    job: FactoryJob,
    controller: AbortController,
    attempt: AttemptState,
    owned: { cwd: string | null },
  ): Promise<void> {
    const outcome = attempt;
    const context = this.configured();
    outcome.execution = await executeJob(context, job, {
      signal: controller.signal,
      onSource: (cwd) => {
        Object.assign(owned, { cwd });
      },
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
    if (didAskOperator(this.repository, job, outcome)) {
      return;
    }
    await completeJob(context, job, outcome.execution, controller.signal);
    outcome.state = outcome.execution.waiting === null ? 'succeeded' : 'failed';
  }

  /**
   * Settle usage once and safely retire an immutable role snapshot.
   *
   * @param job - Original token.
   * @param attempt - Executed evidence.
   * @param stopReason - Liveness checkpoint stop, if one stopped the attempt.
   */
  private async settleAttempt(job: FactoryJob, attempt: AttemptState, stopReason: string | null): Promise<void> {
    triage.settleTriage(this.repository, job, attempt.state);
    const now = this.repository.store.now();
    const failureClass = classifySettlement(attempt, { now, stopReason, isStopping: this.stopped });
    const hasSettled = this.repository.finishJob(
      job,
      attempt.execution?.completion?.usageTokens ?? (attempt.isInferred ? null : 0),
      attempt.state,
      { ...settlementEvidence(attempt, this.stopped, now), failureClass },
    );
    refundUnpaidAttempt(this.repository, job, {
      hasSettled,
      isUnpaidGate:
        attempt.isAwaitingAnswer === true ||
        (attempt.execution?.completion === null && attempt.execution.waiting !== null),
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
   * Handle the validated factory_setup operator control.
   *
   * @param parsed - Validated control input.
   * @returns Durable control result.
   * @throws {MeshError} When setup, role or task gates reject the request.
   */
  private controlSetup(parsed: unknown): unknown {
    if (this.repository.active() || this.running.size > 0 || this.terminals.size > 0) {
      throw new MeshError('FACTORY_GATED', 'Pause managed work before changing project policies.');
    }
    this.context = null;
    this.connected = false;
    this.error = null;
    this.nextReconcile = 0;
    configureProject(this.mesh, this.repository, parsed);
    return this.status();
  }
}
