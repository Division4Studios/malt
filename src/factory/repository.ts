/**
 * Transactional factory ledger sharing the workspace broker's SQLite store.
 * Claims, reservations, head-specific review evidence and remote outbox effects
 * survive process exits. No network or model call occurs in a transaction.
 *
 * @file
 */

import { randomUUID } from 'node:crypto';

import { z } from 'zod/v3';

import { run, selectAll, selectOne } from '../database.ts';
import { MeshError } from '../protocol.ts';

import { retireManagedPresence } from './controls.ts';
import { isClaimEligible } from './delivery-controls.ts';
import { buildHandoff, handoffBody } from './handoffs.ts';
import { InstructionLedger } from './instructions.ts';
import { saveFactorySettings } from './model-policy-controls.ts';
import { broadcastFactoryNotice } from './notifications.ts';
import { initializeObjectiveOrder, rankForFeatureSave } from './objective-order.ts';
import { ObjectiveQueue } from './objective-queue.ts';
import { fixedWindowStart, unusedCapacity, windowFreshness } from './quota-windows.ts';
import { RecommendationLedger } from './recommendations.ts';
import {
  LEASE_MS,
  isTokenCapExceeded,
  capacitySchema,
  effectSchema,
  factoryConfigSchema,
  featureSchema,
  jobSchema,
  skillRequestSchema,
  taskSchema,
} from './schema.ts';
import { TerminalSessions } from './terminal-sessions.ts';

import type { Store } from '../store.ts';
import type { HandoffEvidence } from './handoffs.ts';
import type {
  Capacity,
  FactoryConfig,
  FactoryEffect,
  FactoryJob,
  FactoryTask,
  Feature,
  Provider,
  SkillRequest,
} from './schema.ts';
/** Named identity suffix length bound. */
const IDENTITY_SUFFIX_LENGTH = 8;
/** Named percent max bound. */
const PERCENT_MAX = 100;

/** JSON payload row decoded and validated before use. */
const payloadSchema = z.object({ data: z.string() });
/** Supervisor lease identity. */
const leaseSchema = z.object({ owner: z.string(), expires: z.number() });
/** Recent attempts shown in status; all history remains in SQLite. */
const RECENT_JOBS = 200;
/** Project delivery phase to remote board status. */
const BOARD_STATES = {
  ready: 'Ready',
  development: 'Development',
  publishing: 'Development',
  review: 'QA / Review',
  merge_ready: 'Merge Ready',
  merging: 'Merge Ready',
  verifying: 'Final Verification',
  closing: 'Final Verification',
  done: 'Done',
  blocked: 'Blocked',
} as const;

/**
 * The stored record of a settled attempt.
 *
 * @param job - Running record.
 * @param outcome - Settlement facts.
 * @param outcome.state - Final state.
 * @param outcome.usage - Actual usage, or null when unknown.
 * @param outcome.finishedAt - Settlement time.
 * @param outcome.settlement - Evidence carrying the failure class.
 * @returns Finished record.
 */
function settledJob(
  job: FactoryJob,
  outcome: { state: FactoryJob['state']; usage: number | null; finishedAt: number; settlement: HandoffEvidence },
): FactoryJob {
  const failureClass = outcome.settlement.failureClass ?? undefined;
  return {
    ...job,
    state: outcome.state,
    usageTokens: outcome.usage,
    finishedAt: outcome.finishedAt,
    ...(failureClass !== undefined && { failureClass }),
  };
}

/** Durable, transactional workspace factory state. */
export class FactoryRepository {
  /** Durable instruction delivery and explicit native agent reports. */
  public readonly instructionLedger: InstructionLedger;
  /** Durable operator dispatch order and focus. */
  public readonly objectiveQueue: ObjectiveQueue;
  /** Project-scoped immutable recommendation content and fenced lifecycle. */
  public readonly recommendations: RecommendationLedger;
  /** Operator terminal metadata; content is never persisted here. */
  public readonly terminals: TerminalSessions;
  /** Shared store owns SQLite and transaction boundaries. */
  public readonly store: Store;
  /** System sender, prepared only when an actual factory is configured. */
  private sender: string | null = null;

  /**
   * Add versioned factory tables without modifying existing mesh history.
   *
   * @param store - Workspace store.
   */
  public constructor(store: Store) {
    this.store = store;
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS factory_settings (id INTEGER PRIMARY KEY CHECK(id = 1), data TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS factory_progress (job_id TEXT NOT NULL REFERENCES factory_jobs(id), key TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(job_id,key));
      CREATE TABLE IF NOT EXISTS factory_triage (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, version INTEGER NOT NULL, input TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS factory_source_views (job_id TEXT PRIMARY KEY REFERENCES factory_jobs(id), head TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS factory_progress (job_id TEXT NOT NULL REFERENCES factory_jobs(id), key TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(job_id,key));
      CREATE TABLE IF NOT EXISTS factory_operator_requests (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS factory_features (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS factory_tasks (id TEXT PRIMARY KEY, issue INTEGER NOT NULL UNIQUE, phase TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS factory_task_versions (task_id TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(task_id,version));
      CREATE TABLE IF NOT EXISTS factory_jobs (id TEXT PRIMARY KEY, role TEXT NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS factory_live_role ON factory_jobs(role) WHERE state = 'running';
      CREATE INDEX IF NOT EXISTS factory_jobs_by_start ON factory_jobs(json_extract(data, '$.startedAt') DESC, id DESC);
      CREATE TABLE IF NOT EXISTS factory_capacity (provider TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS factory_effects (id TEXT PRIMARY KEY, issue INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS factory_effect_receipts (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS factory_skill_requests (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS factory_lease (id INTEGER PRIMARY KEY CHECK(id = 1), owner TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS factory_instructions (id TEXT PRIMARY KEY, role TEXT NOT NULL, task_id TEXT, body TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS factory_recommendations (project TEXT NOT NULL, id TEXT NOT NULL, revision TEXT NOT NULL, PRIMARY KEY(project,id));
      CREATE TABLE IF NOT EXISTS factory_recommendation_revisions (project TEXT NOT NULL, id TEXT NOT NULL, revision TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(project,id,revision));
      CREATE TABLE IF NOT EXISTS factory_handoffs (instruction_id TEXT PRIMARY KEY REFERENCES factory_instructions(id), job_id TEXT NOT NULL UNIQUE, data TEXT NOT NULL);
      INSERT OR IGNORE INTO metadata(key, value) VALUES ('factory_schema_version', '1');
    `);
    this.expandWorkKeys();
    initializeObjectiveOrder(store);
    this.instructionLedger = new InstructionLedger(store);
    this.objectiveQueue = new ObjectiveQueue(store);
    this.recommendations = new RecommendationLedger(store);
    this.terminals = new TerminalSessions(store);
  }

  /**
   * Read configured factory settings.
   *
   * @returns Settings, absent before setup.
   */
  public config(): FactoryConfig | null {
    const row = selectOne(this.store.db, payloadSchema, 'SELECT data FROM factory_settings WHERE id = 1');
    return row === undefined ? null : factoryConfigSchema.parse(JSON.parse(row.data));
  }

  /**
   * Durable operator guidance survives spun-down sessions.
   *
   * @param role - Addressed factory role.
   * @param taskId - Optional delivery scope.
   * @param body - Operator instruction.
   * @returns Instruction identity.
   */
  public instruct(role: string, taskId: string | null, body: string): string {
    const id = randomUUID();
    this.store.transaction(() => {
      run(
        this.store.db,
        'INSERT INTO factory_instructions VALUES(?,?,?,?,?)',
        id,
        role,
        taskId,
        body,
        this.store.now(),
      );
      this.store.event('FACTORY_INSTRUCTION', null, { id, role, taskId, body });
    });
    return id;
  }

  /**
   * Read durable guidance for an assignment without discarding history.
   *
   * @param role - Current role.
   * @param taskId - Current delivery.
   * @param featureId - Current objective, if any.
   * @returns Recent operator guidance.
   */
  public instructions(
    role: string,
    taskId: string | null,
    featureId: string | null = null,
  ): ReturnType<InstructionLedger['guidance']> {
    return this.instructionLedger.guidance(role, taskId, featureId);
  }

  /**
   * Persist project settings and prepare a durable system notification identity.
   *
   * @param config - Validated settings.
   */
  public configure(config: FactoryConfig): void {
    saveFactorySettings(this, config);
  }

  /** Prepare the factory sender without making it a coding-work participant. */
  public prepareSender(): void {
    if (this.sender !== null) {
      return;
    }
    const suffix = randomUUID().slice(0, IDENTITY_SUFFIX_LENGTH);
    this.sender = this.store.register({
      name: `factory-system-${suffix}`,
      secret: randomUUID(),
      sessionId: randomUUID(),
      role: 'observer',
      provider: 'system',
      runtime: 'factory',
      ephemeral: true,
    }).id;
  }

  /**
   * Inspect whether automatic dispatch was requested.
   *
   * @returns Durable active flag.
   */
  public active(): boolean {
    return (
      selectOne(this.store.db, z.object({ active: z.number() }), 'SELECT active FROM factory_settings WHERE id=1')
        ?.active === 1
    );
  }

  /**
   * Set the durable human/lead run control.
   *
   * @param isActive - Validated isActive input.
   */
  public setActive(isActive: boolean): void {
    this.store.transaction(() => {
      run(this.store.db, 'UPDATE factory_settings SET active=? WHERE id=1', isActive ? 1 : 0);
    });
  }

  /**
   * Claim or renew the sole project supervisor lease.
   *
   * @param owner - Random identity for this running supervisor.
   * @returns Whether this supervisor owns the lease.
   */
  public lease(owner: string): boolean {
    return this.store.transaction(() => {
      const now = this.store.now();
      const current = selectOne(this.store.db, leaseSchema, 'SELECT owner,expires FROM factory_lease WHERE id=1');
      if (current !== undefined && current.owner !== owner && current.expires > now) {
        return false;
      }
      run(
        this.store.db,
        'INSERT INTO factory_lease VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner, expires=excluded.expires',
        owner,
        now + LEASE_MS,
      );
      return true;
    });
  }

  /**
   * Release only this supervisor's lease.
   *
   * @param owner - Current supervisor identity.
   */
  public release(owner: string): void {
    this.store.transaction(() => {
      run(this.store.db, 'DELETE FROM factory_lease WHERE owner=?', owner);
    });
  }

  /**
   * Enumerate durable product requests.
   *
   * @returns Requests in insertion order.
   */
  public features(): Feature[] {
    return this.rows('SELECT data FROM factory_features ORDER BY rowid', featureSchema);
  }

  /**
   * Enumerate delivery work.
   *
   * @returns Validated tasks.
   */
  public tasks(): FactoryTask[] {
    return this.rows('SELECT data FROM factory_tasks ORDER BY rowid', taskSchema);
  }

  /**
   * Enumerate process attempts.
   *
   * @returns Validated job history.
   */
  public jobs(): FactoryJob[] {
    return this.rows(
      `SELECT data FROM factory_jobs WHERE state='running' OR id IN (SELECT id FROM factory_jobs ORDER BY rowid DESC LIMIT ${String(RECENT_JOBS)}) ORDER BY rowid`,
      jobSchema,
    );
  }

  /**
   * Inspect queued independent lead reviews of researched skill proposals.
   *
   * @returns Durable skill action queue.
   */
  public skillRequests(): SkillRequest[] {
    return this.rows('SELECT data FROM factory_skill_requests ORDER BY rowid', skillRequestSchema);
  }

  /**
   * Persist a reviewed-learning request or its lead decision.
   *
   * @param request - Validated action request.
   */
  public saveSkillRequest(request: SkillRequest): void {
    this.store.transaction(() => {
      if (request.operatorDecision !== undefined) {
        const prior = this.skillRequests().find((item) => item.id === request.id);
        if (prior?.status !== 'awaiting_operator') {
          return;
        }
      }
      run(
        this.store.db,
        'INSERT INTO factory_skill_requests VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
        request.id,
        JSON.stringify(skillRequestSchema.parse(request)),
      );
      if (request.operatorDecision === undefined) {
        return;
      }

      this.store.event('FACTORY_SKILL_OPERATOR_DECISION', null, {
        requestId: request.id,
        name: request.name,
        revision: request.revision,
        approved: request.operatorDecision.approved,
        reason: request.operatorDecision.reason,
      });
      this.notifyInside(
        `Human ${request.operatorDecision.approved ? 'approved' : 'rejected'} skill ${request.name} revision ${request.revision}: ${request.operatorDecision.reason}. New assignments retrieve the project-local revision; running assignments retain their recorded context.`,
      );
    });
  }

  /**
   * Enumerate pending remote synchronization work.
   *
   * @returns Durable outbox.
   */
  public effects(): FactoryEffect[] {
    return this.rows('SELECT data FROM factory_effects ORDER BY rowid', effectSchema);
  }

  /**
   * Save product refinement progress.
   *
   * @param feature - Validated request.
   */
  public saveFeature(feature: Feature): void {
    const value = featureSchema.parse(feature);
    this.store.transaction(() => {
      value.rank = rankForFeatureSave(this.store, value.id);
      run(
        this.store.db,
        'INSERT INTO factory_features VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
        value.id,
        JSON.stringify(value),
      );
      this.store.event('FACTORY_FEATURE_UPDATED', null, { featureId: value.id, phase: value.phase });
    });
  }

  /**
   * Insert a provisioned atomic issue, deduplicated by repository issue number.
   *
   * @param task - New delivery.
   */
  public addTask(task: FactoryTask): void {
    const value = taskSchema.parse(task);
    this.store.transaction(() => {
      run(
        this.store.db,
        'INSERT OR IGNORE INTO factory_tasks VALUES(?,?,?,?,?)',
        value.id,
        value.issue,
        value.phase,
        value.version,
        JSON.stringify(value),
      );
      this.queueStatus(value);
    });
  }

  /**
   * Locate a task without accepting another project's identifier.
   *
   * @param id - Task identifier.
   * @returns Current delivery.
   * @throws {MeshError} When it is not in this workspace.
   */
  public task(id: string): FactoryTask {
    const row = selectOne(this.store.db, payloadSchema, 'SELECT data FROM factory_tasks WHERE id=?', id);
    if (row === undefined) {
      throw new MeshError('NOT_FOUND', 'No factory delivery with that ID in this project.');
    }
    return taskSchema.parse(JSON.parse(row.data));
  }

  /**
   * Update a delivery atomically with its board state and agent notifications.
   *
   * @param id - Task identity.
   * @param change - Synchronous state transition.
   * @returns Committed task.
   */
  public editTask(id: string, change: (task: FactoryTask) => FactoryTask): FactoryTask {
    return this.store.transaction(() => {
      const previous = this.task(id);
      const task = taskSchema.parse({
        ...change(previous),
        version: previous.version + 1,
        updatedAt: this.store.now(),
      });
      this.putTask(task);
      this.queueStatus(task);
      this.store.event('FACTORY_TASK_UPDATED', null, {
        taskId: id,
        issue: task.issue,
        phase: task.phase,
        head: task.head,
      });
      if (previous.phase !== task.phase) {
        this.notifyInside(
          `Issue #${String(task.issue)}: ${task.phase}. ${task.error ?? task.feedback.at(-1) ?? task.title}`,
        );
      }
      return task;
    });
  }

  /**
   * Record an operator mark such as a hold or an archive choice without
   * bumping the delivery's version, so a running attempt fenced on that version
   * still publishes normally.
   *
   * @param id - Delivery identity.
   * @param change - Pure edit that touches only operator marks.
   * @returns Stored delivery.
   */
  public markTask(id: string, change: (task: FactoryTask) => FactoryTask): FactoryTask {
    return this.store.transaction(() => {
      const previous = this.task(id);
      const task = taskSchema.parse({ ...change(previous), version: previous.version, updatedAt: previous.updatedAt });
      this.putTask(task);
      this.store.event('FACTORY_TASK_UPDATED', null, {
        taskId: id,
        issue: task.issue,
        phase: task.phase,
        head: task.head,
      });
      return task;
    });
  }

  /**
   * Retrieve source/worktree history for safe cleanup after a repaired merge.
   *
   * @param id - Delivery identity.
   * @returns Retained historical task states.
   */
  public taskVersions(id: string): FactoryTask[] {
    return selectAll(
      this.store.db,
      payloadSchema,
      'SELECT data FROM factory_task_versions WHERE task_id=? ORDER BY version',
      id,
    ).map((row) => taskSchema.parse(JSON.parse(row.data)));
  }

  /**
   * Persist an idempotent remote effect.
   *
   * @param effect - Desired effect.
   */
  public enqueueEffect(effect: FactoryEffect): void {
    this.store.transaction(() => {
      this.putEffect(effectSchema.parse(effect));
    });
  }

  /**
   * Confirm an external side effect has a durable success receipt.
   *
   * @param id - Stable operation identity.
   * @returns Whether the remote adapter confirmed completion.
   */
  public effectCompleted(id: string): boolean {
    return (
      selectOne(this.store.db, payloadSchema, 'SELECT id AS data FROM factory_effect_receipts WHERE id=?', id) !==
      undefined
    );
  }

  /**
   * Cancel an obsolete unsent effect without claiming remote success.
   *
   * @param id - Exact pending operation identity.
   * @param reason - Public recovery evidence retained in the event history.
   */
  public discardEffect(id: string, reason: string): void {
    this.store.transaction(() => {
      const pending = this.effects().find((effect) => effect.id === id);
      if (pending === undefined) {
        return;
      }
      run(this.store.db, 'DELETE FROM factory_effects WHERE id=?', id);
      this.store.event('FACTORY_EFFECT_RETIRED', null, { effectId: id, reason });
    });
  }

  /**
   * Mark an effect complete, or persist retry backoff after failure.
   *
   * @param effect - Original effect.
   * @param error - Failure details; null for success.
   */
  public settleEffect(effect: FactoryEffect, error: string | null): void {
    this.store.transaction(() => {
      if (error === null) {
        run(this.store.db, 'INSERT OR IGNORE INTO factory_effect_receipts VALUES(?)', effect.id);
        run(this.store.db, 'DELETE FROM factory_effects WHERE id=?', effect.id);
        return;
      }
      const updated = { ...effect, error, attempts: effect.attempts + 1, retryAt: this.store.now() + LEASE_MS };
      run(this.store.db, 'UPDATE factory_effects SET data=? WHERE id=?', JSON.stringify(updated), effect.id);
    });
  }

  /**
   * Read or initialize provider accounting.
   *
   * @param provider - Provider family.
   * @param config - Current project settings.
   * @param shouldInitialize - Persist missing accounting; false for read-only status.
   * @returns Normalized, reset-aware accounting.
   */
  public capacity(provider: Provider, config: FactoryConfig, shouldInitialize = true): Capacity {
    const now = this.store.now();
    const row = selectOne(this.store.db, payloadSchema, 'SELECT data FROM factory_capacity WHERE provider=?', provider);
    const { windowMs } = config.providers[provider];
    // A window being created starts now; observing a never-used provider must not drift between reads.
    const start = shouldInitialize ? now : fixedWindowStart(now, windowMs);
    const current =
      row === undefined ? unusedCapacity(provider, start, windowMs) : capacitySchema.parse(JSON.parse(row.data));
    if (row === undefined && shouldInitialize) {
      this.store.transaction(() => {
        run(this.store.db, 'INSERT OR IGNORE INTO factory_capacity VALUES(?,?)', provider, JSON.stringify(current));
      });
      return this.capacity(provider, config);
    }
    const nextReset = current.resetAt + (Math.floor((now - current.resetAt) / windowMs) + 1) * windowMs;
    return {
      ...current,
      subscriptionWindows: (current.subscriptionWindows ?? []).map((window) => {
        return {
          ...window,
          freshness: windowFreshness(window, now),
        };
      }),
      usedTokens: current.resetAt <= now ? 0 : current.usedTokens,
      resetAt: current.resetAt <= now ? nextReset : current.resetAt,
      subscriptionUsedPercent:
        current.subscriptionResetAt !== null && current.subscriptionResetAt <= now
          ? null
          : current.subscriptionUsedPercent,
    };
  }

  /**
   * Record explicit supported provider telemetry, retaining provenance.
   *
   * @param capacity - Measured capacity snapshot.
   */
  public saveCapacity(capacity: Capacity): void {
    this.store.transaction(() => {
      this.putCapacity(capacity);
    });
  }

  /**
   * Atomically reserve a role, delivery ownership and provider capacity.
   *
   * @param job - Desired bounded attempt.
   * @param config - Project budgets.
   * @returns Whether the claim succeeded.
   */
  public claim(job: FactoryJob, config: FactoryConfig): boolean {
    const record = job;
    return this.store.transaction(() => {
      if (!isClaimEligible(this, record)) {
        return false;
      }
      const live = this.jobs().filter((candidate) => candidate.state === 'running');
      if (
        live.length >= config.resources.maxActiveJobs ||
        live.some((candidate) => {
          return (
            candidate.role === record.role ||
            (record.kind === 'develop' && candidate.taskId === record.taskId && candidate.kind === 'develop')
          );
        })
      ) {
        return false;
      }
      const capacity = this.capacity(record.provider, config);
      const limits = config.providers[record.provider];
      if (
        !limits.enabled ||
        capacity.subscriptionUsedPercent === PERCENT_MAX ||
        capacity.cooldownUntil > this.store.now() ||
        isTokenCapExceeded(limits.budgetTokens, capacity.usedTokens + capacity.reservedTokens + record.reservation) ||
        live.filter((candidate) => candidate.provider === record.provider).length >= limits.concurrency
      ) {
        return false;
      }
      if (record.taskId !== null && record.kind === 'develop') {
        const task = this.task(record.taskId);
        if (task.developer !== null && task.developer !== record.role) {
          return false;
        }
        if (record.role !== 'developer-1' && record.role !== 'developer-2') {
          return false;
        }
        const claimed = {
          ...task,
          phase: 'development' as const,
          developer: record.role,
          attempts: task.attempts + 1,
          version: task.version + 1,
          updatedAt: this.store.now(),
        };
        this.putTask(claimed);
        this.queueStatus(claimed);
      }
      run(
        this.store.db,
        'INSERT INTO factory_jobs VALUES(?,?,?,?)',
        record.id,
        record.role,
        record.state,
        JSON.stringify(jobSchema.parse(record)),
      );
      this.putCapacity({ ...capacity, reservedTokens: capacity.reservedTokens + record.reservation });
      this.store.event('FACTORY_JOB_CLAIMED', null, {
        jobId: record.id,
        role: record.role,
        taskId: record.taskId,
        provider: record.provider,
      });
      return true;
    });
  }

  /**
   * Update a job's runtime metadata, preserving its fencing token.
   *
   * @param job - Job with PID, heartbeat or completion data.
   */
  public saveJob(job: FactoryJob): void {
    this.store.transaction(() => {
      run(
        this.store.db,
        'UPDATE factory_jobs SET state=?,data=? WHERE id=?',
        job.state,
        JSON.stringify(jobSchema.parse(job)),
        job.id,
      );
    });
  }

  /**
   * Settle accounting once; stale process completions cannot double-charge.
   *
   * @param job - Original claim with matching fencing token.
   * @param usage - Actual usage, unknown when the CLI supplies none.
   * @param state - Attempt outcome.
   * @param settlement - Verified cooldown deadline and bounded manager-report evidence; never artifact paths.
   * @returns Whether this was the current live attempt.
   */
  public finishJob(
    job: FactoryJob,
    usage: number | null,
    state: 'succeeded' | 'failed' | 'interrupted',
    settlement: HandoffEvidence = {},
  ): boolean {
    return this.store.transaction(() => {
      const current = this.jobs().find((candidate) => candidate.id === job.id);
      const config = this.config();
      if (config === null || current?.state !== 'running' || current.token !== job.token) {
        return false;
      }
      const capacity = this.capacity(job.provider, config);
      this.putCapacity({
        ...capacity,
        reservedTokens: Math.max(0, capacity.reservedTokens - current.reservation),
        usedTokens: capacity.usedTokens + (usage ?? current.reservation),
        cooldownUntil: Math.max(capacity.cooldownUntil, settlement.cooldown ?? 0),
        updatedAt: this.store.now(),
      });
      const finished = settledJob(current, { state, usage, finishedAt: this.store.now(), settlement });
      run(this.store.db, 'UPDATE factory_jobs SET state=?,data=? WHERE id=?', state, JSON.stringify(finished), job.id);
      retireManagedPresence(this.store, current);
      const manager = current.routing?.organization?.reportsTo;
      if (manager !== undefined && manager !== null) {
        const handoff = buildHandoff({
          job: current,
          manager,
          state,
          task: current.taskId === null ? null : (this.tasks().find((task) => task.id === current.taskId) ?? null),
          feature: this.features().find((feature) => feature.id === current.featureId) ?? null,
          evidence: settlement,
          now: this.store.now(),
        });
        const instructionId = this.instruct(manager, null, handoffBody(handoff));
        run(
          this.store.db,
          'INSERT INTO factory_handoffs VALUES(?,?,?)',
          instructionId,
          current.id,
          JSON.stringify(handoff),
        );
        this.store.event('FACTORY_MANAGER_HANDOFF', null, {
          jobId: current.id,
          from: current.role,
          to: manager,
          instructionId,
          processState: state,
          resultOutcome: handoff.resultOutcome,
        });
      }
      return true;
    });
  }

  /**
   * Send a durable merge, blocker or cleanup notification to every team member.
   *
   * @param body - Notification.
   */
  public notify(body: string): void {
    this.prepareSender();
    this.store.transaction(() => {
      this.notifyInside(body);
    });
  }

  /**
   * Decode JSON rows through a concrete schema.
   *
   * @param sql - Fixed query.
   * @param schema - Domain schema.
   * @returns Validated records.
   */
  private rows<T>(sql: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>): T[] {
    return selectAll(this.store.db, payloadSchema, sql).map((row) => schema.parse(JSON.parse(row.data)));
  }

  /**
   * Record provider-typed work keys in side tables so legacy positional writers keep their column counts.
   * Triggers key rows written by any code version; the backfill covers rows that predate them.
   */
  private expandWorkKeys(): void {
    this.store.transaction(() => {
      this.store.db.exec(`
        CREATE TABLE IF NOT EXISTS factory_task_keys (task_id TEXT PRIMARY KEY, tracker_provider TEXT NOT NULL, external_key TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS factory_effect_keys (effect_id TEXT PRIMARY KEY, tracker_provider TEXT NOT NULL, external_key TEXT NOT NULL);
        CREATE TRIGGER IF NOT EXISTS factory_task_key_insert AFTER INSERT ON factory_tasks BEGIN
          INSERT OR IGNORE INTO factory_task_keys VALUES(NEW.id,'github',CAST(NEW.issue AS TEXT));
        END;
        CREATE TRIGGER IF NOT EXISTS factory_task_key_delete AFTER DELETE ON factory_tasks BEGIN
          DELETE FROM factory_task_keys WHERE task_id=OLD.id;
        END;
        CREATE TRIGGER IF NOT EXISTS factory_effect_key_insert AFTER INSERT ON factory_effects BEGIN
          INSERT OR IGNORE INTO factory_effect_keys VALUES(NEW.id,'github',CAST(NEW.issue AS TEXT));
        END;
        CREATE TRIGGER IF NOT EXISTS factory_effect_key_delete AFTER DELETE ON factory_effects BEGIN
          DELETE FROM factory_effect_keys WHERE effect_id=OLD.id;
        END;
        INSERT OR IGNORE INTO factory_task_keys SELECT id,'github',CAST(issue AS TEXT) FROM factory_tasks
          WHERE id NOT IN (SELECT task_id FROM factory_task_keys);
        INSERT OR IGNORE INTO factory_effect_keys SELECT id,'github',CAST(issue AS TEXT) FROM factory_effects
          WHERE id NOT IN (SELECT effect_id FROM factory_effect_keys);
      `);
    });
  }

  /**
   * Write a validated task inside an existing transaction.
   *
   * @param task - Current task.
   */
  private putTask(task: FactoryTask): void {
    run(
      this.store.db,
      'UPDATE factory_tasks SET phase=?,version=?,data=? WHERE id=?',
      task.phase,
      task.version,
      JSON.stringify(task),
      task.id,
    );
    run(
      this.store.db,
      'INSERT OR IGNORE INTO factory_task_versions VALUES(?,?,?)',
      task.id,
      task.version,
      JSON.stringify(task),
    );
  }

  /**
   * Coalesce pending status effects so an old retry cannot regress the board.
   *
   * @param task - Most recent task state.
   */
  private queueStatus(task: FactoryTask): void {
    run(this.store.db, "DELETE FROM factory_effects WHERE issue=? AND kind='status'", task.issue);
    this.putEffect({
      id: `${task.id}:status:${String(task.version)}`,
      kind: 'status',
      issue: task.issue,
      value: BOARD_STATES[task.phase],
      attempts: 0,
      retryAt: 0,
      error: null,
    });
  }

  /**
   * Add a remote comment or closure inside a transaction.
   *
   * @param effect - Durable effect, deduplicated by identity.
   */
  private putEffect(effect: FactoryEffect): void {
    run(
      this.store.db,
      'INSERT OR IGNORE INTO factory_effects SELECT ?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM factory_effect_receipts WHERE id=?)',
      effect.id,
      effect.issue,
      effect.kind,
      JSON.stringify(effect),
      effect.id,
    );
  }

  /**
   * Persist provider accounting inside a current transaction.
   *
   * @param capacity - Validated capacity.
   */
  private putCapacity(capacity: Capacity): void {
    run(
      this.store.db,
      'INSERT INTO factory_capacity VALUES(?,?) ON CONFLICT(provider) DO UPDATE SET data=excluded.data',
      capacity.provider,
      JSON.stringify(capacitySchema.parse(capacity)),
    );
  }

  /**
   * Broadcast factory decisions inside the same state transition transaction.
   *
   * @param body - Public decision or rejection reason.
   */
  private notifyInside(body: string): void {
    broadcastFactoryNotice(this.store, this.sender, body);
  }
}
