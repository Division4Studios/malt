/**
 * The orchestrator-controlled work/idle state machine.
 *
 * Each worker has one durable coordination row whose `phase` moves as shown below.
 *
 * ```text
 *   CHECKIN_REQUIRED --check_in--> AWAITING_LEAD --answer(work)--> WORK_ASSIGNED
 *          ^                            |                              |
 *          |                            +--answer(idle)--> IDLE_APPROVED
 *          |                                                   |      |
 *          +---------- new message (revokes idle/pending) -----+      |
 *                                                                     |
 *   WORK_ASSIGNED --check_in (finished)--> AWAITING_LEAD <------------+
 * ```
 *
 * Invariants this module maintains:
 *
 * - **Silence never grants idle.** Only the designated orchestrator's explicit
 *   `answer_check_in(idle)` produces `IDLE_APPROVED`.
 * - **New information revokes stale decisions.** A message to a worker that is
 *   idle-approved or awaiting a decision returns it to `CHECKIN_REQUIRED`, in
 *   the same transaction as the message insert.
 * - **Assignments survive messages.** A worker in `WORK_ASSIGNED` keeps its
 *   instructions when messages arrive; it handles them alongside the work.
 * - **Decisions are compare-and-set.** A decision names the exact pending
 *   `requestId`, so a delayed answer cannot apply to a newer request.
 * - **Authority is stored, not claimed.** The `lead_id` metadata row decides
 *   who the orchestrator is; a role label of "lead" only bootstraps it. A
 *   session agent may claim the role only while it is vacant (no lead, or a
 *   lead whose session ended) or its holder is disconnected.
 * - **Ended sessions leave cleanly.** A session agent that disconnects can
 *   never return, so its request is withdrawn, unfinished assigned work is
 *   reported to the lead, and its unread inbox passes to the next lead.
 *
 * Every method here runs inside a transaction opened by the store; this module
 * never opens transactions itself and never awaits.
 *
 * @file
 */

import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import {
  agentRowSchema,
  coordinationRowSchema,
  idRowSchema,
  run,
  selectAll,
  selectCount,
  selectOne,
  valueRowSchema,
} from './database.ts';
import { AGENT_STATES, DISCONNECTED_STATES, MeshError } from './protocol.ts';

import type { AgentRow, CoordinationRow } from './database.ts';
import type { AgentStatus, Handoff, OperationInput, StoredMessageType } from './protocol.ts';
import type { DatabaseSync } from 'node:sqlite';

/** Arbitrary JSON-serialisable data recorded with an event. */
export type EventData = Readonly<Record<string, unknown>>;

/** A message the store is asked to deliver. */
export interface OutgoingMessage {
  /** The message type; defaults to `direct`. */
  readonly type?: StoredMessageType | undefined;
  /** The message text. */
  readonly body: string;
  /** Optional task identifier the message relates to. */
  readonly taskId?: string | undefined;
  /** Optional structured handoff payload. */
  readonly handoff?: Handoff | undefined;
}

/** The result of delivering one message. */
export interface SentMessage {
  /** The new message's ID. */
  readonly id: string;
  /** Its monotonically increasing sequence number (the inbox cursor). */
  readonly seq: number;
  /** The recipient agent's ID. */
  readonly recipient: string;
}

/**
 * The services coordination needs from its owning store.
 *
 * Depending on this narrow interface (rather than importing the Store class)
 * keeps the module graph acyclic and documents exactly which store
 * capabilities the state machine relies on.
 */
export interface CoordinationHost {
  /** The open database connection. */
  readonly db: DatabaseSync;
  /** The clock, injectable for tests. */
  readonly now: () => number;
  /** Stage an event in the current transaction. */
  readonly event: (type: string, actor: string | null, data?: EventData) => void;
  /** Look up an agent by ID or name, throwing NOT_FOUND if absent. */
  readonly agent: (idOrName: string) => AgentRow;
  /** Insert a message (and run its coordination side effects). */
  readonly send: (sender: string, recipient: string, message: OutgoingMessage, replyTo?: string | null) => SentMessage;
  /** Update an agent's presence and status text. */
  readonly setStatus: (id: string, status: AgentStatus, text?: string) => AgentRow;
}

/** How an agent participates in coordination. */
export type Participant = 'observer' | 'orchestrator' | 'worker';

/** The single next step an agent should take, derived from its state. */
export type NextAction =
  'CHECK_IN' | 'DO_ASSIGNED_WORK' | 'PROCESS_MESSAGES' | 'REVIEW_MESSAGES' | 'WAIT_FOR_ORCHESTRATOR' | 'WAIT_FOR_WORK';

/** An agent's complete coordination view, as returned by `work_status`. */
export interface WorkState extends CoordinationRow {
  /** The designated orchestrator, or `null` if none is designated yet. */
  readonly orchestrator: AgentRow | null;
  /** Number of unacknowledged messages in this agent's inbox. */
  readonly unreadMessages: number;
  /** How this agent participates. */
  readonly participant: Participant;
  /** The recommended next step. */
  readonly nextAction: NextAction;
}

/** A pending check-in row joined with the worker's name and presence. */
const pendingCheckInSchema = coordinationRowSchema.extend({ name: z.string(), status: z.enum(AGENT_STATES) });

/** A pending check-in as listed for the orchestrator. */
export type PendingCheckIn = z.output<typeof pendingCheckInSchema>;

/** The next action for a worker with an empty inbox, by phase. */
const WORKER_NEXT_ACTION: Readonly<Record<CoordinationRow['phase'], NextAction>> = {
  CHECKIN_REQUIRED: 'CHECK_IN',
  AWAITING_LEAD: 'WAIT_FOR_ORCHESTRATOR',
  WORK_ASSIGNED: 'DO_ASSIGNED_WORK',
  IDLE_APPROVED: 'WAIT_FOR_WORK',
};

/**
 * Determine whether a presence state means the agent has no live bridge.
 *
 * @param status - The agent's presence state.
 * @returns Whether the agent is offline, stopped or failed.
 */
export function isDisconnected(status: AgentStatus): boolean {
  return DISCONNECTED_STATES.includes(status);
}

/**
 * The work/idle coordination state machine. See the file overview for the
 * transitions and invariants.
 */
export class Coordination {
  /** The owning store's services. */
  private readonly host: CoordinationHost;

  /**
   * Bind the state machine to its owning store.
   *
   * @param host - The store services used for persistence and side effects.
   */
  public constructor(host: CoordinationHost) {
    this.host = host;
  }

  /**
   * The database connection, read through the host on every use.
   *
   * @returns The host's open database connection.
   */
  private get db(): DatabaseSync {
    return this.host.db;
  }

  /**
   * The current orchestrator's agent ID.
   *
   * @returns The designated orchestrator's ID, or `null` if none.
   */
  public leadId(): string | null {
    return selectOne(this.db, valueRowSchema, "SELECT value FROM metadata WHERE key = 'lead_id'")?.value ?? null;
  }

  /**
   * The orchestrator who can still act: the stored lead, unless its session
   * has ended for good.
   *
   * @returns The acting orchestrator's ID, or `null` while the role is vacant.
   */
  public activeLeadId(): string | null {
    const lead = this.leadId();
    return lead === null || this.host.agent(lead).lifetime === 'ended' ? null : lead;
  }

  /**
   * Read an agent's coordination row without creating it.
   *
   * @param id - The agent's ID.
   * @returns The row, or `undefined` if it has never been created.
   */
  public row(id: string): CoordinationRow | undefined {
    return selectOne(this.db, coordinationRowSchema, 'SELECT * FROM worker_coordination WHERE agent_id = ?', id);
  }

  /**
   * Read an agent's coordination row, creating a default row if needed.
   *
   * @param id - The agent's ID.
   * @returns The existing or newly created row.
   * @throws {Error} When the row cannot be read back after creation.
   */
  public requireRow(id: string): CoordinationRow {
    this.ensure(id);
    const row = this.row(id);
    if (row === undefined) {
      // INSERT OR IGNORE just guaranteed the row; absence is a storage fault.
      throw new Error(`Coordination row for ${id} is missing.`);
    }
    return row;
  }

  /**
   * Create an agent's coordination row if it does not exist yet.
   *
   * New rows start in `CHECKIN_REQUIRED` at revision 0.
   *
   * @param id - The agent's ID.
   */
  public ensure(id: string): void {
    run(
      this.db,
      "INSERT OR IGNORE INTO worker_coordination(agent_id, phase, summary, revision, updated_at) VALUES (?, 'CHECKIN_REQUIRED', '', 0, ?)",
      id,
      this.host.now(),
    );
  }

  /**
   * Determine whether an agent takes part in the work loop as a worker.
   *
   * The orchestrator assigns rather than receives work, and observers (such as
   * the human CLI identity) opt out entirely.
   *
   * @param id - The agent's ID.
   * @returns Whether the agent is a worker.
   */
  public isWorker(id: string): boolean {
    const agent = this.host.agent(id);
    return (
      id !== this.leadId() &&
      agent.role !== 'observer' &&
      agent.runtime !== 'factory-managed' &&
      agent.lifetime !== 'ended'
    );
  }

  /**
   * Count an agent's unacknowledged messages.
   *
   * @param id - The agent's ID.
   * @returns The number of unread messages.
   */
  public unread(id: string): number {
    return selectCount(
      this.db,
      'SELECT COUNT(*) AS count FROM messages WHERE recipient = ? AND acknowledged_at IS NULL',
      id,
    );
  }

  /**
   * Derive the presence an online agent should display from its phase.
   *
   * @param id - The agent's ID.
   * @returns `IDLE` for idle-approved workers and non-workers, `WORKING` for
   *   assigned workers, otherwise `WAITING`.
   */
  public presence(id: string): AgentStatus {
    if (!this.isWorker(id)) {
      return 'IDLE';
    }
    const phase = this.row(id)?.phase;
    if (phase === 'IDLE_APPROVED') {
      return 'IDLE';
    }
    return phase === 'WORK_ASSIGNED' ? 'WORKING' : 'WAITING';
  }

  /**
   * Build an agent's complete coordination view.
   *
   * @param id - The agent's ID.
   * @returns The agent's row plus orchestrator, inbox count and next action.
   */
  public snapshot(id: string): WorkState {
    const state = this.requireRow(id);
    const lead = this.activeLeadId();
    const unreadMessages = this.unread(id);
    let participant: Participant = 'observer';
    if (this.isWorker(id)) {
      participant = 'worker';
    } else if (id === lead) {
      participant = 'orchestrator';
    }

    // Unread messages always come first; then non-workers simply review, and
    // workers follow their phase.
    let nextAction: NextAction = WORKER_NEXT_ACTION[state.phase];
    if (unreadMessages > 0) {
      nextAction = 'PROCESS_MESSAGES';
    } else if (participant !== 'worker') {
      nextAction = 'REVIEW_MESSAGES';
    }

    return {
      ...state,
      orchestrator: lead === null ? null : this.host.agent(lead),
      unreadMessages,
      participant,
      nextAction,
    };
  }

  /**
   * Apply registration side effects for a newly registered or reconnected agent.
   *
   * - An agent registering with role `lead` becomes orchestrator while the
   *   role is vacant (never designated, or held by a session that ended).
   * - A worker with nothing to process automatically checks in, so connecting
   *   is itself a request for work.
   * - Presence is refreshed from the coordination phase.
   *
   * @param id - The agent's ID.
   */
  public registered(id: string): void {
    this.ensure(id);
    if (this.activeLeadId() === null && this.host.agent(id).role === 'lead') {
      this.setLead(id);
    }
    if (this.isWorker(id) && this.requireRow(id).phase === 'CHECKIN_REQUIRED' && this.unread(id) === 0) {
      this.checkIn(id, 'Connected and available for work.');
    }
    const agent = this.host.agent(id);
    const refreshable: readonly AgentStatus[] = ['IDLE', 'WAITING', 'OFFLINE', 'STARTING'];
    if (refreshable.includes(agent.status)) {
      this.host.setStatus(id, this.presence(id), agent.status_text);
    }
  }

  /**
   * Resolve the orchestrator's inbox notification for a check-in request.
   *
   * Marking the `work_request` message acknowledged keeps the orchestrator's
   * inbox limited to requests that still need a decision.
   *
   * @param row - The coordination row whose request is being retired.
   */
  public retireRequest(row: CoordinationRow | undefined): void {
    const messageId = row?.request_message_id;
    if (row === undefined || messageId === null || messageId === undefined) {
      return;
    }
    const { changes } = run(
      this.db,
      'UPDATE messages SET acknowledged_at = ? WHERE id = ? AND acknowledged_at IS NULL',
      this.host.now(),
      messageId,
    );
    if (changes > 0) {
      this.host.event('CHECKIN_MESSAGE_RESOLVED', row.agent_id, { id: messageId });
    }
  }

  /**
   * Let a session agent take the orchestrator role it asked for.
   *
   * A live orchestrator is never displaced this way; that remains a human
   * decision through the CLI.
   *
   * @param id - The claiming agent's ID.
   * @throws {MeshError} LEAD_ACTIVE while another orchestrator is connected.
   */
  public claimLead(id: string): void {
    const lead = this.activeLeadId();
    if (lead === id) {
      return;
    }
    if (lead !== null && !isDisconnected(this.host.agent(lead).status)) {
      throw new MeshError(
        'LEAD_ACTIVE',
        `${this.host.agent(lead).name} already leads this team. Join as a worker, or have a human replace the lead with the CLI lead command.`,
      );
    }
    this.setLead(id);
  }

  /**
   * Designate (or replace) the orchestrator.
   *
   * Replacement invalidates every outstanding decision except assignments in
   * progress: pending requests are re-raised to the new orchestrator, and idle
   * approvals granted by the old one are revoked. When the previous lead's
   * session ended, its unread inbox (handoffs, questions, notices of departed
   * workers) passes to the new lead, since nobody else could ever read it.
   *
   * @param id - The new orchestrator's agent ID.
   * @returns The new orchestrator's coordination view.
   */
  public setLead(id: string): WorkState {
    // Validates that the agent exists (throws NOT_FOUND otherwise).
    this.host.agent(id);
    const previous = this.leadId();
    if (previous === id) {
      return this.snapshot(id);
    }
    run(
      this.db,
      "INSERT INTO metadata(key, value) VALUES ('lead_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      id,
    );
    this.host.event('ORCHESTRATOR_CHANGED', id);
    if (previous !== null) {
      this.inheritInbox(previous, id);
    }

    for (const agent of selectAll(this.db, idRowSchema, 'SELECT id FROM agents')) {
      const row = this.requireRow(agent.id);
      // Work already assigned to someone other than the new lead stands.
      if (row.phase === 'WORK_ASSIGNED' && agent.id !== id) {
        continue;
      }
      this.retireRequest(row);
      this.resetToCheckInRequired(agent.id);
      if (this.isWorker(agent.id) && this.unread(agent.id) === 0) {
        this.checkIn(agent.id, row.summary === '' ? 'Available after orchestrator change.' : row.summary);
      }
      // Routing changes must never make a disconnected bridge appear online.
      if (!isDisconnected(this.host.agent(agent.id).status)) {
        this.host.setStatus(agent.id, this.presence(agent.id), 'Orchestrator changed');
      }
    }
    return this.snapshot(id);
  }

  /**
   * Request work from the orchestrator.
   *
   * Asking for work ends any previous assignment. Repeating a still-pending
   * request is idempotent: it returns the existing request rather than
   * notifying the orchestrator again.
   *
   * @param id - The worker's agent ID.
   * @param summary - The worker's results or availability summary.
   * @returns The worker's updated coordination view.
   * @throws {MeshError} NOT_A_WORKER for orchestrators and observers;
   *   UNREAD_MESSAGES while the worker's inbox is not empty.
   */
  public checkIn(id: string, summary: string): WorkState {
    this.ensure(id);
    if (!this.isWorker(id)) {
      throw new MeshError('NOT_A_WORKER', 'The orchestrator and observers do not request work.');
    }
    if (this.unread(id) > 0) {
      throw new MeshError('UNREAD_MESSAGES', 'Process and acknowledge your inbox before requesting more work.');
    }
    const prior = this.requireRow(id);
    if (prior.phase === 'AWAITING_LEAD') {
      return this.snapshot(id);
    }
    this.retireRequest(prior);

    const requestId = `req_${randomUUID()}`;
    run(
      this.db,
      "UPDATE worker_coordination SET phase = 'AWAITING_LEAD', request_id = ?, request_message_id = NULL, summary = ?, instructions = NULL, decision_note = NULL, revision = revision + 1, updated_at = ? WHERE agent_id = ?",
      requestId,
      summary,
      this.host.now(),
      id,
    );

    // Notify the orchestrator through its inbox, so a waiting orchestrator
    // wakes up. With no orchestrator yet (or one whose session ended), the
    // request simply stays pending and is re-raised when one is designated.
    const lead = this.activeLeadId();
    if (lead !== null) {
      const message = this.host.send(id, lead, {
        type: 'work_request',
        body: JSON.stringify({
          requestId,
          worker: this.host.agent(id).name,
          summary,
          action: 'Use mesh_answer_check_in to assign work or explicitly approve idle.',
        }),
      });
      run(this.db, 'UPDATE worker_coordination SET request_message_id = ? WHERE agent_id = ?', message.id, id);
    }
    if (!isDisconnected(this.host.agent(id).status)) {
      this.host.setStatus(id, 'WAITING', 'Awaiting an explicit orchestrator decision');
    }
    this.host.event('WORK_REQUESTED', id, { requestId, orchestrator: lead, summary });
    return this.snapshot(id);
  }

  /**
   * Record the orchestrator's decision on a pending check-in.
   *
   * @param actor - The deciding agent's ID; must be the orchestrator.
   * @param input - The request ID, decision and instructions or reason.
   * @returns The worker's updated coordination view.
   * @throws {MeshError} NOT_ORCHESTRATOR, STALE_CHECKIN, UNREAD_MESSAGES or
   *   INSTRUCTIONS_REQUIRED when the decision cannot be applied.
   */
  public answer(actor: string, input: OperationInput<'answer_check_in'>): WorkState {
    const row = this.decidableRequest(actor, input);
    const isIdle = input.decision === 'idle';
    run(
      this.db,
      'UPDATE worker_coordination SET phase = ?, instructions = ?, decision_note = ?, revision = revision + 1, updated_at = ? WHERE agent_id = ?',
      isIdle ? 'IDLE_APPROVED' : 'WORK_ASSIGNED',
      // Stored verbatim (untrimmed), exactly as the orchestrator wrote them.
      isIdle ? null : (input.instructions ?? null),
      input.reason ?? '',
      this.host.now(),
      row.agent_id,
    );
    // The decision and the resolution of its inbox notification commit together.
    this.retireRequest(row);
    if (!isDisconnected(this.host.agent(row.agent_id).status)) {
      this.host.setStatus(
        row.agent_id,
        this.presence(row.agent_id),
        isIdle ? 'Idle approved by orchestrator' : 'Work assigned by orchestrator',
      );
    }
    this.host.event(isIdle ? 'IDLE_APPROVED' : 'WORK_ASSIGNED', actor, {
      worker: row.agent_id,
      requestId: row.request_id,
      reason: input.reason ?? '',
    });
    return this.snapshot(row.agent_id);
  }

  /**
   * Withdraw a session agent that is leaving for good.
   *
   * Its pending request is retired, so the orchestrator never answers it, and
   * the coordination row is reset. If it still held assigned work, the lead
   * receives a `worker_left` notice with the instructions so the work can be
   * reassigned. The notice goes to the stored lead even if that lead's own
   * session ended; the next lead then inherits it with the rest of the inbox.
   *
   * @param id - The departing agent's ID.
   */
  public depart(id: string): void {
    const row = this.requireRow(id);
    const lead = this.leadId();
    if (lead !== null && lead !== id && row.phase === 'WORK_ASSIGNED') {
      this.host.send(id, lead, {
        type: 'worker_left',
        body: JSON.stringify({
          worker: this.host.agent(id).name,
          instructions: row.instructions,
          action: 'This session ended before checking in. Reassign the work if it is still needed.',
        }),
      });
    }
    this.retireRequest(row);
    this.resetToCheckInRequired(id);
    this.host.event('AGENT_LEFT', id, { phase: row.phase });
  }

  /**
   * Apply the coordination effects of a message delivered to `recipient`.
   *
   * A message is never itself an idle grant. Any new communication revokes an
   * idle approval or a pending request, but preserves an assignment in
   * progress. Runs inside the same transaction as the message insert.
   *
   * @param recipient - The receiving agent's ID.
   */
  public onMessage(recipient: string): void {
    this.ensure(recipient);
    if (!this.isWorker(recipient)) {
      return;
    }
    const row = this.requireRow(recipient);
    if (row.phase !== 'IDLE_APPROVED' && row.phase !== 'AWAITING_LEAD') {
      return;
    }
    this.retireRequest(row);
    this.resetToCheckInRequired(recipient);
    if (!isDisconnected(this.host.agent(recipient).status)) {
      this.host.setStatus(recipient, 'WAITING', 'New message; process it and check in again');
    }
    this.host.event('CHECKIN_REQUIRED', recipient, { reason: 'message_received' });
  }

  /**
   * List workers awaiting a decision, oldest first.
   *
   * @param actor - The requesting agent's ID; must be the orchestrator.
   * @returns The pending check-ins with worker name and presence.
   * @throws {MeshError} NOT_ORCHESTRATOR for anyone else.
   */
  public list(actor: string): PendingCheckIn[] {
    if (actor !== this.leadId()) {
      throw new MeshError('NOT_ORCHESTRATOR', 'Only the designated orchestrator can list check-ins.');
    }
    return selectAll(
      this.db,
      pendingCheckInSchema,
      "SELECT c.*, a.name, a.status FROM worker_coordination c JOIN agents a ON a.id = c.agent_id WHERE c.phase = 'AWAITING_LEAD' AND c.agent_id != ? AND a.role != 'observer' ORDER BY c.updated_at, c.agent_id",
      actor,
    );
  }

  /**
   * Apply the schema 1 to 2 coordination migration, inside the store's
   * migration transaction.
   *
   * Every agent receives a coordination row, the first `lead`-role agent
   * becomes orchestrator, idle workers lose their unapproved idle status, and
   * workers with nothing to process are checked in on their behalf.
   */
  public migrate(): void {
    const agents = selectAll(
      this.db,
      agentRowSchema.pick({ id: true, role: true, status: true }),
      'SELECT id, role, status FROM agents ORDER BY created_at',
    );
    for (const agent of agents) {
      this.ensure(agent.id);
    }
    const lead = agents.find((agent) => agent.role === 'lead');
    if (lead !== undefined) {
      this.setLead(lead.id);
    }
    for (const agent of agents) {
      const isWorker = this.isWorker(agent.id);
      if (isWorker && this.requireRow(agent.id).phase === 'CHECKIN_REQUIRED' && this.unread(agent.id) === 0) {
        this.checkIn(agent.id, 'Available after coordination upgrade.');
      }
      if (isWorker && agent.status === 'IDLE') {
        this.host.setStatus(agent.id, 'WAITING', 'Orchestrator approval required');
      }
    }
  }

  /**
   * Validate that a decision may be applied, returning the pending request.
   *
   * @param actor - The deciding agent's ID; must be the orchestrator.
   * @param input - The decision being applied.
   * @returns The coordination row of the worker awaiting this decision.
   * @throws {MeshError} NOT_ORCHESTRATOR, STALE_CHECKIN, UNREAD_MESSAGES or
   *   INSTRUCTIONS_REQUIRED when the decision cannot be applied.
   */
  private decidableRequest(actor: string, input: OperationInput<'answer_check_in'>): CoordinationRow {
    if (actor !== this.leadId()) {
      throw new MeshError('NOT_ORCHESTRATOR', 'Only the designated orchestrator can answer check-ins.');
    }
    // Compare-and-set on the exact request ID: a delayed answer cannot approve
    // idle after a newer message or check-in replaced the request.
    const row = selectOne(
      this.db,
      coordinationRowSchema,
      'SELECT * FROM worker_coordination WHERE request_id = ?',
      input.requestId,
    );
    if (row?.phase !== 'AWAITING_LEAD') {
      throw new MeshError('STALE_CHECKIN', 'This check-in is no longer awaiting a decision.');
    }
    if (this.unread(row.agent_id) > 0) {
      throw new MeshError(
        'UNREAD_MESSAGES',
        'The worker has unread messages and must process them before an idle/work decision.',
      );
    }
    // Whitespace-only instructions count as missing.
    const instructions = input.instructions?.trim() ?? '';
    if (instructions === '' && input.decision === 'work') {
      throw new MeshError('INSTRUCTIONS_REQUIRED', 'Work assignments require instructions.');
    }
    return row;
  }

  /**
   * Pass an ended lead's unread inbox to its successor, since nobody else
   * could ever read it. A previous lead that can still return keeps its own.
   *
   * @param previous - The previous orchestrator's ID.
   * @param successor - The new orchestrator's ID.
   */
  private inheritInbox(previous: string, successor: string): void {
    if (this.host.agent(previous).lifetime !== 'ended') {
      return;
    }
    const { changes } = run(
      this.db,
      'UPDATE messages SET recipient = ? WHERE recipient = ? AND acknowledged_at IS NULL',
      successor,
      previous,
    );
    if (changes > 0) {
      this.host.event('INBOX_INHERITED', successor, { from: previous, count: changes });
    }
  }

  /**
   * Return a worker to `CHECKIN_REQUIRED`, clearing any request or decision.
   *
   * @param id - The agent's ID.
   */
  private resetToCheckInRequired(id: string): void {
    run(
      this.db,
      "UPDATE worker_coordination SET phase = 'CHECKIN_REQUIRED', request_id = NULL, request_message_id = NULL, instructions = NULL, decision_note = NULL, revision = revision + 1, updated_at = ? WHERE agent_id = ?",
      this.host.now(),
      id,
    );
  }
}
