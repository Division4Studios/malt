/**
 * The persistent delivery manager (#211). One subscription-authenticated model
 * session per project that the operator talks to for the whole mission; every
 * role reports into it. The unpaid supervisor stays the execution authority:
 * the manager only steers through scoped, transactional factory operations.
 *
 * Honesty rules: states are what the process actually did (starting, waiting,
 * working, stopping, stopped, failed); a message is sent, acknowledged and
 * answered only when the native stream says so; nothing is resent after a
 * failure; reports are batched and rate-limited, so the model is never woken
 * by idle prompts. Generations fence every event, so a replaced process can
 * never act on the current conversation.
 *
 * @file
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { z } from 'zod/v3';

import { selectAll, selectOne } from '../database.ts';
import { MeshError } from '../protocol.ts';

import { briefText, missionBrief } from './manager-brief.ts';
import { claudeManagerLaunch, codexManagerTurn, MANAGER_NAME, MANAGER_PROMPT } from './manager-launch.ts';
import { ManagerLedger } from './manager-ledger.ts';
import { startManagerProcess } from './manager-process.ts';
import { managerPolicySchema } from './manager-schema.ts';
import { claudeInput, decodeManagerLine } from './manager-stream.ts';

import type { MeshConfig } from '../config.ts';
import type { MissionBrief } from './manager-brief.ts';
import type { ManagerMessage } from './manager-ledger.ts';
import type { ManagerLauncher, ManagerProcess } from './manager-process.ts';
import type { ManagerPolicy } from './manager-schema.ts';
import type { ManagerEvent } from './manager-stream.ts';
import type { FactoryRepository } from './repository.ts';

/** Milliseconds per second, for native reset times. */
const SECOND_MS = 1000;
/** Heartbeat for report collection and timeouts; it never wakes the model by itself. */
const TICK_MS = 5000;
/** Most reports included in one digest; older ones are summarized by count. */
const DIGEST_MAX = 20;
/** Conversation entries included in a fresh-session context restore. */
const RESTORE_ENTRIES = 12;
/** Longest restored conversation excerpt per entry. */
const RESTORE_ENTRY_MAX = 600;
/** Unexpected exits tolerated within the restart window before staying failed. */
const RESTART_LIMIT = 3;
/** Window for counting unexpected exits. */
const RESTART_WINDOW_MS = 900_000;
/** Delay before an automatic restart. */
const RESTART_DELAY_MS = 5000;
/** Events that are reported to the manager. */
const REPORTED_EVENTS = [
  'FACTORY_MANAGER_HANDOFF',
  'FACTORY_TASK_UPDATED',
  'FACTORY_FEATURE_UPDATED',
  'FACTORY_TRIAGE_REPORTED',
  'FACTORY_RESOURCE_STOP',
  'FACTORY_SCOPE_REPLACED',
] as const;

/** Event row. */
const eventSchema = z.object({ seq: z.number(), type: z.string(), data: z.string() });
/** Handoff row. */
const handoffSchema = z.object({ data: z.string() });
/** Agent name row. */
const agentSchema = z.object({ name: z.string() });

/** Collaborators replaced by fixtures. */
export interface ManagerOptions {
  /** Broker home for the MCP bridge. */
  readonly home: string;
  /** Persistent process launcher. */
  readonly launcher?: ManagerLauncher;
  /** Clock. */
  readonly now?: () => number;
  /** Native executable override, for fixture providers. */
  readonly executable?: (policy: ManagerPolicy) => { file: string; prefix: readonly string[] };
  /** Disable the automatic heartbeat; tests drive tick() directly. */
  readonly isManualTick?: boolean;
}

/** Public live status. */
export interface ManagerStatus {
  /** Whether a generation is live. */
  readonly isLive: boolean;
  /** Current or last session generation. */
  readonly session: ReturnType<ManagerLedger['current']>;
  /** Most recent tool the manager called in this generation. */
  readonly lastTool: string | null;
  /** Last stream activity. */
  readonly lastActivityAt: number | null;
  /** Subscription rate-limit pause, if the provider reported one. */
  readonly pausedUntil: number | null;
  /** Messages waiting for delivery. */
  readonly queued: number;
  /** Reports not yet delivered. */
  readonly pendingReports: number;
  /** Highest conversation sequence. */
  readonly latestSeq: number;
  /** Open decisions. */
  readonly decisions: ReturnType<ManagerLedger['openDecisions']>;
}

/**
 * Read a rate-limit pause from Claude's native event.
 *
 * @param info - Native rate limit information.
 * @returns Pause deadline in milliseconds, or null.
 */
function rejectedUntil(info: unknown): number | null {
  if (!isRecord(info)) {
    return null;
  }
  const resets = info['resetsAt'];
  return typeof resets === 'number' && info['status'] === 'rejected' ? resets * SECOND_MS : null;
}

/**
 * Narrow decoded JSON to a plain object.
 *
 * @param value - Decoded JSON.
 * @returns Whether the value is a non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Decode a stored JSON object, empty when malformed.
 *
 * @param text - Stored JSON.
 * @returns Object fields.
 */
function fields(text: string): Record<string, unknown> {
  try {
    const decoded: unknown = JSON.parse(text);
    return isRecord(decoded) ? decoded : {};
  } catch {
    return {};
  }
}

/** One project's persistent manager. */
export class ManagerService {
  /** Durable state. */
  public readonly ledger: ManagerLedger;
  /** Target project. */
  private readonly mesh: MeshConfig;
  /** Project ledger, read for the brief and reports. */
  private readonly repository: FactoryRepository;
  /** Collaborators. */
  private readonly options: ManagerOptions;
  /** Clock. */
  private readonly now: () => number;
  /** Live process of the current generation (Claude), or the running turn (Codex). */
  private process: ManagerProcess | null = null;
  /** Generation owning the live process. */
  private generation: number | null = null;
  /** Fresh sessions need the brief and recent conversation on their next message. */
  private needsContext = false;
  /** Most recent tool call. */
  private lastTool: string | null = null;
  /** Last stream activity. */
  private lastActivityAt: number | null = null;
  /** Provider-reported rate-limit pause. */
  private pausedUntil: number | null = null;
  /** Time a message was claimed for delivery. */
  private sentAt = 0;
  /** Last unsolicited wakeup. */
  private lastWakeAt = 0;
  /** Earliest routine digest; routine reports wait a full interval after start. */
  private digestDueAt = 0;
  /** An urgent report is waiting. */
  private isUrgent = false;
  /** Recent unexpected exits. */
  private crashes: number[] = [];
  /** Heartbeat timer. */
  private timer: NodeJS.Timeout | null = null;
  /** Pending automatic restart. */
  private restart: NodeJS.Timeout | null = null;

  /**
   * Bind the manager to a project and recover from any previous broker lifetime.
   *
   * @param mesh - Target project.
   * @param repository - Project ledger.
   * @param options - Collaborators.
   */
  public constructor(mesh: MeshConfig, repository: FactoryRepository, options: ManagerOptions) {
    this.mesh = mesh;
    this.repository = repository;
    this.options = options;
    this.now = options.now ?? Date.now;
    this.ledger = new ManagerLedger(repository.store);
    const ended = this.ledger.recoverAfterRestart();
    if (ended !== null) {
      this.ledger.record('system', 'The broker restarted, so the manager stopped. Start it again to continue.');
    }
  }

  /**
   * Current policy; the defaults apply until the factory is configured with one.
   *
   * @returns The configured policy with defaults applied.
   */
  public policy(): ManagerPolicy {
    return managerPolicySchema.parse(this.repository.config()?.manager ?? {});
  }

  /**
   * Live status for the console and tools.
   *
   * @returns Status snapshot.
   */
  public status(): ManagerStatus {
    return {
      isLive: this.isLive(),
      session: this.ledger.current(),
      lastTool: this.lastTool,
      lastActivityAt: this.lastActivityAt,
      pausedUntil: this.pausedUntil,
      queued: this.ledger.queuedCount(),
      pendingReports: this.ledger.pendingReports().length,
      latestSeq: this.ledger.latestSeq(),
      decisions: this.ledger.openDecisions(),
    };
  }

  /**
   * Mission brief for the manager and the console.
   *
   * @returns The brief computed from the current ledger.
   */
  public brief(): MissionBrief {
    return missionBrief(this.repository, this.ledger.openDecisions(), this.now());
  }

  /**
   * Whether a generation is live.
   *
   * @returns Liveness.
   */
  public isLive(): boolean {
    const current = this.ledger.current();
    return current !== null && current.ended_at === null;
  }

  /**
   * Whether an authenticated actor is the live manager's bridge.
   *
   * @param actorId - Authenticated agent identity.
   * @returns Whether it may use manager authority.
   */
  public isManagerActor(actorId: string): boolean {
    const row = selectOne(this.repository.store.db, agentSchema, 'SELECT name FROM agents WHERE id=?', actorId);
    return row?.name === MANAGER_NAME && this.isLive();
  }

  /**
   * Start the manager, resuming its native session when one exists.
   *
   * @returns Status after starting.
   * @throws {MeshError} When the factory is not configured.
   */
  public start(): ManagerStatus {
    if (this.repository.config() === null) {
      throw new MeshError('FACTORY_GATED', 'Configure the factory before starting the manager.');
    }
    if (this.isLive()) {
      return this.status();
    }
    const policy = this.policy();
    const session = this.ledger.begin(policy.provider, policy.model ?? null);
    this.generation = session.generation;
    this.lastTool = null;
    this.pausedUntil = null;
    this.digestDueAt = this.now() + this.policy().digestMs;
    const resume = this.ledger.resumable(policy.provider);
    this.needsContext = resume === null && this.ledger.latestSeq() > 0;
    try {
      if (policy.provider === 'claude') {
        this.spawnClaude(policy, session.generation, resume);
      } else {
        this.ledger.update(session.generation, { state: 'waiting' });
      }
    } catch (error) {
      // A failed launch must never leave a generation that claims to be live.
      this.generation = null;
      this.ledger.update(session.generation, {
        state: 'failed',
        reason: `The manager could not start: ${String(error)}`,
      });
      throw error;
    }
    this.ledger.record(
      'system',
      resume === null ? 'Manager started a new session.' : 'Manager resumed its previous session.',
    );
    if (this.options.isManualTick !== true) {
      this.timer ??= setInterval(() => {
        this.tick();
      }, TICK_MS);
      this.timer.unref();
    }
    this.pump();
    return this.status();
  }

  /**
   * Stop the manager and its owned process tree.
   *
   * @param reason - Recorded reason.
   * @returns Status after stopping.
   */
  public async stop(reason = 'Stopped by the operator.'): Promise<ManagerStatus> {
    if (this.restart !== null) {
      clearTimeout(this.restart);
      this.restart = null;
    }
    // The owned process is always stopped, even if another broker lifetime already ended its generation.
    const live = this.process;
    this.process = null;
    this.generation = null;
    const current = this.ledger.current();
    const isRecorded = current !== null && current.ended_at === null;
    if (isRecorded) {
      this.ledger.update(current.generation, { state: 'stopping' });
    }
    await live?.stop();
    if (isRecorded) {
      this.ledger.update(current.generation, { state: 'stopped', reason });
      this.ledger.record('system', `Manager stopped: ${reason}`);
    }
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    return this.status();
  }

  /**
   * Queue an operator message; it is delivered when the manager is free.
   *
   * @param text - Message.
   * @returns The queued entry.
   */
  public send(text: string): ManagerMessage {
    const message = this.ledger.enqueue('operator', text);
    this.pump();
    return message;
  }

  /**
   * Answer one of the manager's decisions and tell the manager.
   *
   * @param id - Decision identity.
   * @param answer - Operator answer.
   * @returns The answered decision.
   */
  public answer(id: string, answer: string): ReturnType<ManagerLedger['answer']> {
    const decision = this.ledger.answer(id, answer);
    this.ledger.enqueue('operator', `Decision answered. ${decision.question}\nAnswer: ${answer}`);
    this.pump();
    return decision;
  }

  /**
   * Record a decision the live manager needs from the operator.
   *
   * @param question - What the operator must decide.
   * @param options - Offered answers.
   * @param evidence - Exact evidence.
   * @returns The open decision.
   */
  public ask(question: string, options: readonly string[], evidence: string): ReturnType<ManagerLedger['ask']> {
    const decision = this.ledger.ask(question, options, evidence);
    this.ledger.record('system', `Decision requested: ${question}`);
    return decision;
  }

  /** Collect reports, enforce timeouts and deliver digests; never wakes the model on its own. */
  public tick(): void {
    this.collectReports();
    this.enforceTimeouts();
    this.scheduleDigest();
    this.pump();
  }

  /** Stop everything for broker shutdown. */
  public async close(): Promise<void> {
    await this.stop('The broker is shutting down.');
  }

  /**
   * Launch the persistent Claude session.
   *
   * @param policy - Provider, model, effort and resource limits.
   * @param generation - New generation.
   * @param resume - Native session to resume.
   */
  private spawnClaude(policy: ManagerPolicy, generation: number, resume: string | null): void {
    const artifact = path.join(this.mesh.directory, 'factory', 'manager', String(generation));
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Generation directory under the selected project's private factory state.
    mkdirSync(artifact, { recursive: true, mode: 0o700 });
    const native = this.options.executable?.(policy) ?? { file: 'claude', prefix: [] };
    const launch = claudeManagerLaunch({ mesh: this.mesh, home: this.options.home, policy, artifact }, native.file, {
      id: resume ?? randomUUID(),
      isResume: resume !== null,
    });
    const launcher = this.options.launcher ?? startManagerProcess;
    this.process = launcher(
      {
        file: launch.file,
        args: [...native.prefix, ...launch.args],
        cwd: this.mesh.root,
        artifact,
        memoryMb: policy.memoryMb,
        processLimit: policy.processLimit,
        secrets: [this.mesh.token],
      },
      {
        onLine: (line) => {
          this.handle(generation, 'claude', line);
        },
        onExit: (exit) => {
          this.exited(generation, exit);
        },
      },
    );
    this.ledger.update(generation, { state: 'waiting', ...(this.process.pid !== null && { pid: this.process.pid }) });
  }

  /**
   * Run one bounded Codex turn for a claimed message.
   *
   * @param policy - Provider, model, effort and resource limits.
   * @param generation - Live generation.
   * @param prompt - Turn input.
   */
  private spawnCodexTurn(policy: ManagerPolicy, generation: number, prompt: string): void {
    const artifact = path.join(this.mesh.directory, 'factory', 'manager', String(generation), randomUUID());
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Turn directory under the selected project's private factory state.
    mkdirSync(artifact, { recursive: true, mode: 0o700 });
    const native = this.options.executable?.(policy) ?? { file: 'codex', prefix: [] };
    const thread = this.ledger.resumable('codex');
    const launch = codexManagerTurn(
      { mesh: this.mesh, home: this.options.home, policy, artifact },
      native.file,
      thread,
    );
    const input = thread === null ? `${MANAGER_PROMPT}\n\n${prompt}` : prompt;
    const launcher = this.options.launcher ?? startManagerProcess;
    const turn = launcher(
      {
        file: launch.file,
        args: [...native.prefix, ...launch.args],
        cwd: this.mesh.root,
        artifact,
        memoryMb: policy.memoryMb,
        processLimit: policy.processLimit,
        secrets: [this.mesh.token],
      },
      {
        onLine: (line) => {
          this.handle(generation, 'codex', line);
        },
        onExit: () => {
          if (this.process === turn) {
            this.process = null;
          }
          const open = this.ledger.inFlight(generation);
          if (open !== null) {
            this.ledger.transition(open.id, generation, 'failed', 'The Codex turn ended without a reply.');
          }
          this.ledger.update(generation, { state: 'waiting' });
          this.pump();
        },
      },
    );
    this.process = turn;
    turn.write(input);
    void turn.stop();
  }

  /**
   * Apply one decoded stream line to the fenced generation.
   *
   * @param generation - Generation that produced the line.
   * @param provider - Provider family.
   * @param line - Redacted line.
   */
  private handle(generation: number, provider: 'claude' | 'codex', line: string): void {
    if (generation !== this.generation) {
      return;
    }
    this.lastActivityAt = this.now();
    for (const event of decodeManagerLine(provider, line)) {
      this.apply(generation, event);
    }
  }

  /**
   * Apply one normalized event.
   *
   * @param generation - Current generation.
   * @param event - Normalized stream event.
   */
  private apply(generation: number, event: ManagerEvent): void {
    const open = this.ledger.inFlight(generation);
    switch (event.kind) {
      case 'session': {
        this.ledger.update(generation, {
          nativeSession: event.sessionId,
          ...(event.model !== null && { model: event.model }),
        });
        return;
      }
      case 'ack': {
        const id = event.messageId === '' ? open?.id : event.messageId;
        if (id !== undefined) {
          this.ledger.transition(id, generation, 'acknowledged');
        }
        return;
      }
      case 'text': {
        this.ledger.record('manager', event.text, event.replyTo ?? open?.id ?? null);
        return;
      }
      case 'tool': {
        this.lastTool = event.name;
        return;
      }
      case 'turn': {
        this.completeTurn(generation, open, event);
        return;
      }
      case 'rate': {
        this.pausedUntil = rejectedUntil(event.info);
        return;
      }
      case 'error': {
        this.ledger.record('system', event.message);
      }
    }
  }

  /**
   * Settle the in-flight message when a turn ends, then deliver the next one.
   *
   * @param generation - Current generation.
   * @param open - Message in flight, if any.
   * @param event - Turn completion.
   * @param event.isError - Whether the turn failed.
   * @param event.detail - Failure detail.
   */
  private completeTurn(
    generation: number,
    open: ManagerMessage | null,
    event: { readonly isError: boolean; readonly detail: string | null },
  ): void {
    if (open !== null && event.isError) {
      this.ledger.transition(open.id, generation, 'failed', event.detail);
    } else if (open !== null) {
      // Codex has no replayed acknowledgment; a completed turn proves receipt.
      if (open.state === 'sent') {
        this.ledger.transition(open.id, generation, 'acknowledged');
      }
      this.ledger.transition(open.id, generation, 'answered');
    }
    if (event.isError && event.detail !== null) {
      this.ledger.record('system', `The manager turn failed: ${event.detail}`);
    }
    this.ledger.update(generation, { state: 'waiting' });
    this.pump();
  }

  /**
   * Handle a process exit for its own generation only.
   *
   * @param generation - Generation that exited.
   * @param exit - Exit details.
   * @param exit.code - Native exit code.
   * @param exit.stderr - Redacted diagnostics tail.
   * @param exit.isRequested - Whether the operator stopped it.
   */
  private exited(generation: number, exit: { code: number | null; stderr: string; isRequested: boolean }): void {
    if (generation !== this.generation || exit.isRequested) {
      return;
    }
    this.process = null;
    this.generation = null;
    const detail = exit.stderr.trim().split('\n').at(-1) ?? '';
    const suffix = detail === '' ? '' : `: ${detail}`;
    const reason = `The manager process exited unexpectedly (code ${String(exit.code)})${suffix}.`;
    this.ledger.update(generation, { state: 'failed', reason });
    const now = this.now();
    this.crashes = [...this.crashes.filter((at) => now - at < RESTART_WINDOW_MS), now];
    if (this.crashes.length > RESTART_LIMIT) {
      this.ledger.record('system', `${reason} It failed repeatedly, so it stays stopped until you start it.`);
      return;
    }
    this.ledger.record('system', `${reason} Restarting with its saved session.`);
    this.restart = setTimeout(() => {
      this.restart = null;
      if (!this.isLive()) {
        this.start();
      }
    }, RESTART_DELAY_MS);
    this.restart.unref();
  }

  /** Deliver the next queued message when the manager is free. */
  private pump(): void {
    const generation = this.generation ?? this.ledger.current()?.generation ?? null;
    if (generation === null || !this.isLive() || this.ledger.inFlight(generation) !== null) {
      return;
    }
    if (this.pausedUntil !== null && this.now() < this.pausedUntil) {
      return;
    }
    const next = this.ledger.nextQueued();
    if (next === null || !this.ledger.transition(next.id, generation, 'sent')) {
      return;
    }
    this.generation = generation;
    this.sentAt = this.now();
    const body = this.needsContext ? `${this.restoreContext()}\n\n---\n\n${next.body}` : next.body;
    this.needsContext = false;
    this.ledger.update(generation, { state: 'working' });
    const policy = this.policy();
    if (policy.provider === 'codex') {
      this.spawnCodexTurn(policy, generation, body);
      return;
    }
    if (this.process?.write(claudeInput(next.id, body)) !== true) {
      this.ledger.transition(next.id, generation, 'failed', 'The manager process did not accept input.');
    }
  }

  /** Fail messages that waited too long; nothing is resent automatically. */
  private enforceTimeouts(): void {
    const { generation } = this;
    if (generation === null) {
      return;
    }
    const open = this.ledger.inFlight(generation);
    if (open === null) {
      return;
    }
    const policy = this.policy();
    const waited = this.now() - this.sentAt;
    if (open.state === 'sent' && waited > policy.ackTimeoutMs) {
      this.ledger.transition(open.id, generation, 'failed', 'The manager did not acknowledge this message in time.');
    } else if (waited > policy.replyTimeoutMs) {
      this.ledger.transition(open.id, generation, 'failed', 'The manager did not reply in time.');
    } else {
      return;
    }
    this.ledger.update(generation, { state: 'waiting' });
  }

  /** Turn newly committed factory events into pending reports. */
  private collectReports(): void {
    const cursor = this.ledger.cursor('events');
    const placeholders = REPORTED_EVENTS.map(() => '?').join(',');
    const rows = selectAll(
      this.repository.store.db,
      eventSchema,
      `SELECT seq,type,data FROM events WHERE seq>? AND type IN (${placeholders}) ORDER BY seq LIMIT 200`,
      cursor,
      ...REPORTED_EVENTS,
    );
    for (const row of rows) {
      const report = this.describe(row.type, fields(row.data));
      if (report !== null) {
        this.ledger.record('report', report.text);
        this.isUrgent ||= report.isUrgent;
      }
      this.ledger.advance('events', row.seq);
    }
  }

  /**
   * Describe one event as a report, or skip it.
   *
   * @param type - Event type.
   * @param data - Event payload.
   * @returns Report text and urgency, or null.
   */
  private describe(type: string, data: Record<string, unknown>): { text: string; isUrgent: boolean } | null {
    const issue = typeof data['issue'] === 'number' ? `#${String(data['issue'])}` : 'A delivery';
    switch (type) {
      case 'FACTORY_MANAGER_HANDOFF': {
        const row = selectOne(
          this.repository.store.db,
          handoffSchema,
          'SELECT data FROM factory_handoffs WHERE job_id=?',
          String(data['jobId']),
        );
        const summary = row === undefined ? null : fields(row.data)['summary'];
        const text = isRecord(summary) && typeof summary['text'] === 'string' ? summary['text'] : 'no summary';
        return {
          text: `${String(data['from'])} → ${String(data['to'])}: ${String(data['resultOutcome'] ?? data['processState'])}. ${text}`,
          isUrgent: data['resultOutcome'] === 'blocked',
        };
      }
      case 'FACTORY_TASK_UPDATED': {
        return this.phaseReport(`task:${String(data['taskId'])}`, String(data['phase']), issue);
      }
      case 'FACTORY_FEATURE_UPDATED': {
        return this.phaseReport(`feature:${String(data['featureId'])}`, String(data['phase']), 'An objective');
      }
      case 'FACTORY_TRIAGE_REPORTED': {
        return { text: `Triage needs attention: ${String(data['summary'] ?? data['action'])}`, isUrgent: true };
      }
      case 'FACTORY_RESOURCE_STOP': {
        return { text: `Work stopped for resource pressure: ${String(data['reason'])}`, isUrgent: true };
      }
      default: {
        return { text: 'The scope was replaced; affected deliveries were parked for re-planning.', isUrgent: false };
      }
    }
  }

  /**
   * Report a terminal or blocked phase once per record and phase.
   *
   * @param key - Record key.
   * @param phase - New phase.
   * @param label - Display label.
   * @returns Report, or null when not reportable or already reported.
   */
  private phaseReport(key: string, phase: string, label: string): { text: string; isUrgent: boolean } | null {
    const reportable = ['blocked', 'done', 'merge_ready', 'verifying'];
    const index = reportable.indexOf(phase);
    if (index === -1 || this.ledger.cursor(`phase:${key}`) === index + 1) {
      return null;
    }
    this.ledger.mark(`phase:${key}`, index + 1);
    const words: Record<string, string> = {
      blocked: 'is blocked',
      done: 'is done',
      merge_ready: 'is approved for merge',
      verifying: 'merged; verifying main',
    };
    return { text: `${label} ${words[phase] ?? phase}.`, isUrgent: phase === 'blocked' };
  }

  /** Batch pending reports into one digest when urgency or the routine interval allows. */
  private scheduleDigest(): void {
    if (!this.isLive()) {
      return;
    }
    const reports = this.ledger.pendingReports();
    if (reports.length === 0 || this.ledger.queuedCount() > 0) {
      return;
    }
    const policy = this.policy();
    const now = this.now();
    // Urgent reports respect only the gap since the last wakeup; routine ones wait for the digest interval.
    const isUrgentDue = this.isUrgent && now - this.lastWakeAt >= policy.urgentDelayMs;
    if (!isUrgentDue && now < this.digestDueAt) {
      return;
    }
    const shown = reports.slice(-DIGEST_MAX);
    const omitted = reports.length - shown.length;
    const lines = [
      `Reports since your last update (${String(reports.length)}):`,
      ...(omitted > 0 ? [`(${String(omitted)} earlier reports omitted; the brief has the current state.)`] : []),
      ...shown.map((report) => `- ${report.body}`),
      'Steer if anything needs it and tell the operator only what they need to know.',
    ];
    const digest = this.ledger.enqueue('digest', lines.join('\n'));
    this.ledger.markDelivered(
      reports.map((report) => report.id),
      digest.id,
    );
    this.lastWakeAt = now;
    this.digestDueAt = now + policy.digestMs;
    this.isUrgent = false;
  }

  /**
   * Context for a fresh session: the current brief and the recent conversation.
   *
   * @returns Restore preamble.
   */
  private restoreContext(): string {
    const recent = this.ledger
      .recent(RESTORE_ENTRIES)
      .filter((entry) => entry.author === 'operator' || entry.author === 'manager')
      .map((entry) => `${entry.author}: ${entry.body.slice(0, RESTORE_ENTRY_MAX)}`);
    return [
      'Context restored after a restart. Current mission brief:',
      briefText(this.brief()),
      ...(recent.length > 0 ? ['Recent conversation:', ...recent] : []),
    ].join('\n');
  }
}
