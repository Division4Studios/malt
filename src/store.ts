/**
 * Durable SQLite state for one Agent Mesh project.
 *
 * The store owns the project's single database connection and is the only
 * component that reads or writes it. Its responsibilities:
 *
 * - **Schema and migrations.** Creating tables, refusing a database that
 *   belongs to another project, and migrating older schema versions (2 added
 *   coordination, 3 added agent lifetimes) without losing existing agents or
 *   messages.
 * - **Identity.** Registering agents, verifying their secrets and fencing out
 *   stale sessions so two live bridges can never share one identity. Session
 *   identities end when their bridge disconnects and then drop out of the
 *   roster, broadcasts and messaging.
 * - **Presence.** Heartbeats and expiry of silent agents to OFFLINE.
 * - **Messaging.** Durable inboxes, replies, broadcasts and acknowledgements.
 * - **Operations.** A typed dispatcher executing every non-waiting RPC
 *   operation inside one SQLite transaction.
 *
 * Concurrency model: every mutation runs synchronously inside
 * `BEGIN IMMEDIATE ... COMMIT`. Because `node:sqlite` is synchronous and no
 * `await` occurs inside a transaction, a transaction can never interleave with
 * another request on the event loop, and `BEGIN IMMEDIATE` additionally
 * serialises against any other process opening the same file. WAL mode makes
 * committed changes survive process and container restarts.
 *
 * @file
 */

import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { z } from 'zod';

import { Coordination, isDisconnected } from './coordination.ts';
import {
  AGENT_PUBLIC_COLUMNS,
  agentCredentialRowSchema,
  agentRowSchema,
  columnRowSchema,
  countRowSchema,
  eventRowSchema,
  idRowSchema,
  inboxRowSchema,
  run,
  selectAll,
  selectCount,
  selectOne,
  valueRowSchema,
} from './database.ts';
import { log } from './log.ts';
import { AGENT_STATES, MeshError, handoffSchema, parseInput } from './protocol.ts';

import type { MeshConfig } from './config.ts';
import type {
  CoordinationHost,
  EventData,
  OutgoingMessage,
  PendingCheckIn,
  SentMessage,
  WorkState,
} from './coordination.ts';
import type { AgentRow } from './database.ts';
import type { AgentLifetime, AgentStatus, Handoff, Operation, OperationInput, OperationRawInput } from './protocol.ts';

// -----------------------------------------------------------------------------
// Operation typing
// -----------------------------------------------------------------------------

/**
 * Operations the store does not execute: registration has its own entry
 * point, waiting is implemented by the broker's waiter registry, and team
 * operations span projects, so the broker handles them above any one store.
 */
const NON_STORE_OPERATIONS = [
  'list_teams',
  'open_team',
  'register',
  'wait_for_work',
] as const satisfies readonly Operation[];

/** Operations executed by {@link Store.execute}. */
export type StoreOperation = Exclude<Operation, (typeof NON_STORE_OPERATIONS)[number]>;

/**
 * Operations a caller may perform without agent credentials, authenticated by
 * the project token alone: read-only team views and the human lead control.
 */
export const PUBLIC_OPERATIONS = [
  'team_status',
  'list_agents',
  'events',
  'set_lead',
] as const satisfies readonly StoreOperation[];

/** An operation that does not require agent credentials. */
export type PublicOperation = (typeof PUBLIC_OPERATIONS)[number];

/**
 * The acting agent an operation requires: public operations accept `null`,
 * every other operation needs an authenticated agent ID.
 */
export type ActorFor<O extends StoreOperation> = O extends PublicOperation ? string | null : string;

/**
 * Determine whether an operation is executed by the store.
 *
 * @param operation - A validated operation name.
 * @returns Whether {@link Store.execute} handles it.
 */
export function isStoreOperation(operation: Operation): operation is StoreOperation {
  return !(NON_STORE_OPERATIONS as readonly Operation[]).includes(operation);
}

/**
 * Determine whether an operation can run without agent credentials.
 *
 * @param operation - A store operation name.
 * @returns Whether the operation is public.
 */
export function isPublicOperation(operation: StoreOperation): operation is PublicOperation {
  return (PUBLIC_OPERATIONS as readonly StoreOperation[]).includes(operation);
}

/** A message as returned by inbox reads, with its handoff payload decoded. */
export interface InboxMessage extends Omit<z.output<typeof inboxRowSchema>, 'handoff'> {
  /** The decoded structured handoff, or `null` for ordinary messages. */
  readonly handoff: Handoff | null;
}

/** One page of an inbox. */
export interface InboxPage {
  /** The messages on this page, oldest first. */
  readonly messages: InboxMessage[];
  /** Whether more messages follow `nextCursor`. */
  readonly hasMore: boolean;
  /** The `after` value that fetches the next page. */
  readonly nextCursor: number;
}

/** One durable event, with its data payload decoded. */
export interface MeshEvent extends Omit<z.output<typeof eventRowSchema>, 'data'> {
  /** The decoded event payload. */
  readonly data: unknown;
}

/** One page of the event log. */
export interface EventPage {
  /** The events on this page, oldest first. */
  readonly events: MeshEvent[];
  /** The `after` value that fetches the next page. */
  readonly nextCursor: number;
}

/** The number of agents in one presence state. */
export interface StatusCount {
  /** The presence state. */
  readonly status: AgentStatus;
  /** How many agents are in it. */
  readonly count: number;
}

/** An agent that is blocked or needs human input. */
export interface BlockedAgent {
  /** The agent's ID. */
  readonly id: string;
  /** The agent's name. */
  readonly name: string;
  /** What the agent reported it is blocked on. */
  readonly status_text: string;
}

/** Acknowledgement of a heartbeat. */
export interface HeartbeatResult {
  /** Always `true`; present so callers can assert success. */
  readonly ok: true;
}

/** The messages created by a broadcast. */
export interface BroadcastResult {
  /** One delivered message per recipient. */
  readonly messages: SentMessage[];
}

/** Confirmation that a message is acknowledged. */
export interface AckResult {
  /** The acknowledged message's ID. */
  readonly id: string;
  /** Always `true`; acknowledgement is idempotent. */
  readonly acknowledged: true;
}

/** A compact overview of the whole team. */
export interface TeamStatus {
  /** The project's display name. */
  readonly project: string;
  /** The project's unique ID. */
  readonly projectId: string;
  /** Number of agents in each presence state. */
  readonly counts: StatusCount[];
  /** Agents that are blocked or need input, with their status text. */
  readonly blocked: BlockedAgent[];
  /** Unacknowledged messages across all inboxes. */
  readonly unreadMessages: number;
  /** The orchestrator's agent ID, or `null`. */
  readonly orchestrator: string | null;
  /** Number of workers awaiting an orchestrator decision. */
  readonly pendingCheckIns: number;
}

/** The result type of every store operation. */
export interface StoreResults {
  /** The caller's own agent row. */
  readonly whoami: AgentRow;
  /** Heartbeat acknowledgement. */
  readonly heartbeat: HeartbeatResult;
  /** The caller's agent row after going offline. */
  readonly disconnect: AgentRow;
  /** The caller's agent row after the update. */
  readonly set_status: AgentRow;
  /** The new orchestrator's coordination view. */
  readonly set_lead: WorkState;
  /** The caller's coordination view after checking in. */
  readonly check_in: WorkState;
  /** The caller's coordination view. */
  readonly work_status: WorkState;
  /** Pending check-ins awaiting the orchestrator. */
  readonly list_check_ins: PendingCheckIn[];
  /** The worker's coordination view after the decision. */
  readonly answer_check_in: WorkState;
  /** Agents in the project, by name. */
  readonly list_agents: AgentRow[];
  /** The team overview. */
  readonly team_status: TeamStatus;
  /** The delivered message. */
  readonly send_message: SentMessage;
  /** One delivered message per recipient. */
  readonly broadcast: BroadcastResult;
  /** One page of the caller's inbox. */
  readonly get_messages: InboxPage;
  /** Acknowledgement confirmation. */
  readonly ack_message: AckResult;
  /** The delivered reply. */
  readonly reply: SentMessage;
  /** One page of the event log. */
  readonly events: EventPage;
}

/**
 * A handler per operation. Declaring the table as a mapped type lets
 * TypeScript correlate `handlers[operation]` with `OperationInput<operation>`
 * and `StoreResults[operation]` for a generic `operation`.
 */
type Handlers = {
  readonly [O in StoreOperation]: (input: OperationInput<O>, actor: string | null) => StoreResults[O];
};

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** The SQLite schema version this code writes. */
const SCHEMA_VERSION = '3';

/** Every schema version this code can open (older ones are migrated). */
const SUPPORTED_SCHEMA_VERSIONS: ReadonlySet<string> = new Set(['1', '2', SCHEMA_VERSION]);

/** SQLite lock wait before reporting SQLITE_BUSY, in milliseconds. */
const BUSY_TIMEOUT_MS = 5000;

/**
 * Hash an identity secret for storage. Secrets are high-entropy random
 * values, so a fast unsalted hash is sufficient: it only prevents the raw
 * secret from being readable in the database.
 *
 * @param value - The secret.
 * @returns Its SHA-256 hex digest.
 */
function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Parse a JSON column that this store itself wrote.
 *
 * @param text - The column value.
 * @returns The decoded, still untyped value.
 */
function parseJson(text: string): unknown {
  return JSON.parse(text);
}

/**
 * Require an authenticated actor for an operation that is not public.
 *
 * @param actor - The authenticated agent ID, or `null`.
 * @returns The agent ID.
 * @throws {MeshError} UNAUTHORIZED_AGENT when no agent is authenticated.
 */
function requireActor(actor: string | null): string {
  if (actor === null) {
    throw new MeshError('UNAUTHORIZED_AGENT', 'Agent credentials or session are invalid.');
  }
  return actor;
}

/** The credentials a bridge presents with every agent operation. */
export interface Credentials {
  /** The agent's durable ID. */
  readonly agentId: string;
  /** The agent's identity secret. */
  readonly secret: string;
  /** The current bridge session's ID. */
  readonly sessionId: string;
}

/**
 * Credentials as presented by an untrusted caller: any field may be missing,
 * in which case authentication fails.
 */
export type PresentedCredentials = { readonly [K in keyof Credentials]?: Credentials[K] | undefined };

/** Options for constructing a {@link Store}. */
export interface StoreOptions {
  /** Clock override, used by tests to control time. */
  readonly now?: (() => number) | undefined;
}

// -----------------------------------------------------------------------------
// Store
// -----------------------------------------------------------------------------

/** Durable project state. See the file overview. */
export class Store implements CoordinationHost {
  /** The open database connection, owned exclusively by this store. */
  public readonly db: DatabaseSync;

  /** The work/idle state machine, sharing this store's transactions. */
  public readonly coordination: Coordination;

  /** Paths, token, timing thresholds and display name of the project. */
  private readonly config: MeshConfig;

  /** Source of the current time; `Date.now` unless a test injects one. */
  private readonly clock: () => number;

  /** Operation handlers, built once per store. */
  private readonly handlers: Handlers;

  /**
   * Open (creating or migrating as needed) the project's database.
   *
   * @param config - Paths, token and thresholds of the project to open.
   * @param options - Store options, such as a test clock.
   * @throws {Error} When the database belongs to another project or has an
   *   unsupported schema version.
   */
  public constructor(config: MeshConfig, options: StoreOptions = {}) {
    this.config = config;
    this.clock = options.now ?? Date.now;
    this.db = new DatabaseSync(config.database);
    this.createBaseSchema();
    this.verifyProject();
    const version = this.schemaVersion();
    this.coordination = new Coordination(this);
    this.handlers = this.createHandlers();
    this.migrate(version);
    log('info', 'storage', 'database_ready', {
      schemaVersion: Number(SCHEMA_VERSION),
      migrated: version !== SCHEMA_VERSION,
    });
  }

  /**
   * The current time in milliseconds, from the injectable clock.
   *
   * @returns Milliseconds since the Unix epoch.
   */
  public readonly now = (): number => this.clock();

  /** Close the database connection. */
  public close(): void {
    this.db.close();
    log('info', 'storage', 'database_closed');
  }

  /**
   * Run `fn` inside one `BEGIN IMMEDIATE` transaction.
   *
   * No async callback is accepted: an open SQLite transaction must never span
   * an HTTP wait, a model turn or another network request.
   *
   * @param work - Synchronous work to perform atomically.
   * @returns The value returned by `work`.
   * @throws {unknown} Whatever `work` throws, after rolling back.
   */
  public transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      log('debug', 'storage', 'transaction_rolled_back', { code: error instanceof MeshError ? error.code : 'ERROR' });
      throw error;
    }
  }

  /**
   * Stage an event in the current transaction.
   *
   * @param type - Event type, for example `MESSAGE_SENT`.
   * @param actor - The agent responsible, or `null` for system events.
   * @param data - JSON-serialisable event details.
   */
  public readonly event = (type: string, actor: string | null, data: EventData = {}): void => {
    run(
      this.db,
      'INSERT INTO events(type, actor, data, created_at) VALUES (?, ?, ?, ?)',
      type,
      actor,
      JSON.stringify(data),
      this.now(),
    );
    // A diagnostic of an event being STAGED: the transaction can still roll
    // back. The events table is the authoritative committed history.
    log('debug', 'coordination', 'event_staged', { type, actor });
  };

  /**
   * Look up an agent's public row by ID or by name.
   *
   * @param idOrName - Either the agent's `ag_` identifier or its unique name.
   * @returns The agent's public row.
   * @throws {MeshError} NOT_FOUND when no such agent exists.
   */
  public readonly agent = (idOrName: string): AgentRow => {
    const row = selectOne(
      this.db,
      agentRowSchema,
      `SELECT ${AGENT_PUBLIC_COLUMNS} FROM agents WHERE id = ? OR name = ?`,
      idOrName,
      idOrName,
    );
    if (row === undefined) {
      throw new MeshError('NOT_FOUND', 'Agent not found.');
    }
    return row;
  };

  /**
   * Register a new agent or resume an existing identity.
   *
   * The secret proves durable identity; the session UUID is a lease, so two
   * live bridges can never accidentally share one inbox owner. A different
   * session may only take over once the previous one is offline.
   *
   * A session identity (`ephemeral`) registering with role `lead` claims the
   * orchestrator role in the same transaction, so a refused claim leaves no
   * trace of the registration.
   *
   * @param rawInput - Registration details; validated here.
   * @returns The registered agent's public row.
   * @throws {MeshError} IDENTITY_CONFLICT for a wrong secret; AGENT_ACTIVE
   *   while another live session holds the name; AGENT_LEFT for an ended
   *   session; LEAD_ACTIVE for a refused lead claim; INVALID_INPUT.
   */
  public register(rawInput: OperationRawInput<'register'>): AgentRow {
    const input = parseInput('register', rawInput);
    return this.transaction(() => {
      const id = this.upsertAgent(input);
      // Claim before the registration hooks run, which would otherwise treat
      // the new agent as a worker and request work on its behalf.
      if (input.ephemeral && input.role === 'lead') {
        this.coordination.claimLead(id);
      }
      this.coordination.registered(id);
      return this.agent(id);
    });
  }

  /**
   * Verify an agent's credentials and current session.
   *
   * A caller-supplied name is never trusted for authorisation: both the
   * stored identity secret AND the current session must match.
   *
   * @param credentials - The credentials presented by a bridge, if any.
   * @returns The authenticated agent's ID.
   * @throws {MeshError} UNAUTHORIZED_AGENT on any mismatch.
   */
  public authenticate(credentials: PresentedCredentials | undefined): string {
    const row = selectOne(
      this.db,
      agentCredentialRowSchema,
      'SELECT * FROM agents WHERE id = ?',
      credentials?.agentId ?? '',
    );
    // An unknown agent leaves `row` undefined, which fails the first check. An
    // ended session can never act again, even with its old credentials.
    if (
      row?.secret_hash !== hash(credentials?.secret ?? '') ||
      row.session_id !== credentials?.sessionId ||
      row.lifetime === 'ended'
    ) {
      throw new MeshError('UNAUTHORIZED_AGENT', 'Agent credentials or session are invalid.');
    }
    return row.id;
  }

  /**
   * Mark every agent whose lease lapsed as OFFLINE.
   *
   * Offline is a connectivity observation, not an idle/work decision: the
   * coordination row and any pending request deliberately survive expiry.
   *
   * @returns The number of agents newly marked offline.
   */
  public expire(): number {
    return this.transaction(() => {
      const stale = selectAll(
        this.db,
        idRowSchema,
        "SELECT id FROM agents WHERE last_seen <= ? AND status NOT IN ('OFFLINE', 'STOPPED', 'FAILED')",
        this.now() - this.config.offlineMs,
      );
      for (const { id } of stale) {
        run(this.db, "UPDATE agents SET status = 'OFFLINE' WHERE id = ?", id);
        this.event('AGENT_DISCONNECTED', id, { reason: 'heartbeat_timeout' });
      }
      return stale.length;
    });
  }

  /**
   * Update an agent's presence and status text, renewing its lease.
   *
   * @param id - The agent's ID.
   * @param status - The new presence.
   * @param text - Short status text.
   * @returns The updated agent row.
   */
  public readonly setStatus = (id: string, status: AgentStatus, text = ''): AgentRow => {
    run(
      this.db,
      'UPDATE agents SET status = ?, status_text = ?, last_seen = ? WHERE id = ?',
      status,
      text,
      this.now(),
      id,
    );
    this.event(status === 'OFFLINE' ? 'AGENT_DISCONNECTED' : 'AGENT_STATUS_CHANGED', id, { status, text });
    return this.agent(id);
  };

  /**
   * Insert a message and apply its coordination side effects.
   *
   * The insert, its event, and any idle revocation share the caller's
   * transaction, so an orchestrator cannot approve a stale request between
   * delivery and revocation.
   *
   * @param sender - The sending agent's ID.
   * @param recipient - The receiving agent's ID.
   * @param message - The message contents.
   * @param replyTo - The ID of the message being replied to, if any.
   * @returns The delivered message's identifiers.
   */
  public readonly send = (
    sender: string,
    recipient: string,
    message: OutgoingMessage,
    replyTo: string | null = null,
  ): SentMessage => {
    const id = `msg_${randomUUID()}`;
    const type = message.type ?? 'direct';
    const { lastInsertRowid } = run(
      this.db,
      'INSERT INTO messages(id, sender, recipient, type, body, task_id, handoff, reply_to, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      sender,
      recipient,
      type,
      message.body,
      message.taskId ?? null,
      message.handoff === undefined ? null : JSON.stringify(message.handoff),
      replyTo,
      this.now(),
    );
    this.event('MESSAGE_SENT', sender, { id, recipient, type });
    this.coordination.onMessage(recipient);
    return { id, seq: lastInsertRowid, recipient };
  };

  /**
   * Execute a store operation with compile-time checked input.
   *
   * The input is still validated at runtime: the store is the final authority
   * on every bound, whoever the caller is.
   *
   * @param operation - The operation to run.
   * @param input - The operation's input.
   * @param actor - The authenticated agent, or `null` for public operations.
   * @returns The operation's typed result.
   */
  public execute<O extends StoreOperation>(
    operation: O,
    input: OperationRawInput<O>,
    actor: ActorFor<O>,
  ): StoreResults[O] {
    return this.invoke(operation, input, actor);
  }

  /**
   * Execute a store operation with untrusted input from the HTTP boundary.
   *
   * @param operation - The validated operation name.
   * @param input - The untrusted input from the request body.
   * @param actor - The authenticated agent, or `null` for public operations.
   * @returns The operation's result, to be serialised as JSON.
   */
  public executeRequest(operation: StoreOperation, input: unknown, actor: string | null): unknown {
    return this.invoke(operation, input, actor);
  }

  /**
   * Validate input and run the operation's handler in one transaction.
   *
   * @param operation - The operation to run.
   * @param input - The raw input.
   * @param actor - The authenticated agent, or `null`.
   * @returns The handler's result.
   */
  private invoke<O extends StoreOperation>(operation: O, input: unknown, actor: string | null): StoreResults[O] {
    const parsed = parseInput(operation, input);
    const handler = this.handlers[operation];
    return this.transaction(() => handler(parsed, actor));
  }

  /**
   * Build the operation handler table.
   *
   * @returns One handler per store operation.
   */
  private createHandlers(): Handlers {
    return {
      whoami: (_input, actor) => this.agent(requireActor(actor)),
      heartbeat: (_input, actor) => this.heartbeat(requireActor(actor)),
      disconnect: (_input, actor) => {
        const id = requireActor(actor);
        // A session identity cannot reconnect, so disconnecting ends it.
        return this.agent(id).lifetime === 'session'
          ? this.depart(id)
          : this.setStatus(id, 'OFFLINE', 'Bridge disconnected');
      },
      set_status: (input, actor) => {
        const id = requireActor(actor);
        // A worker may not declare itself idle; only the orchestrator's
        // explicit decision permits that.
        if (
          input.status === 'IDLE' &&
          this.coordination.isWorker(id) &&
          this.coordination.row(id)?.phase !== 'IDLE_APPROVED'
        ) {
          throw new MeshError(
            'IDLE_NOT_APPROVED',
            'Check in and wait for explicit idle approval from the orchestrator.',
          );
        }
        return this.setStatus(id, input.status, input.text);
      },
      set_lead: (input) => this.coordination.setLead(this.recipient(input.agent)),
      check_in: (input, actor) => this.coordination.checkIn(requireActor(actor), input.summary),
      work_status: (_input, actor) => this.coordination.snapshot(requireActor(actor)),
      list_check_ins: (_input, actor) => this.coordination.list(requireActor(actor)),
      answer_check_in: (input, actor) => this.coordination.answer(requireActor(actor), input),
      list_agents: (input) => this.listAgents(input.status),
      team_status: () => this.teamStatus(),
      send_message: (input, actor) => this.send(requireActor(actor), this.recipient(input.to), input),
      broadcast: (input, actor) => {
        const sender = requireActor(actor);
        const recipients = selectAll(
          this.db,
          idRowSchema,
          "SELECT id FROM agents WHERE id != ? AND lifetime != 'ended' ORDER BY name",
          sender,
        );
        return { messages: recipients.map(({ id }) => this.send(sender, id, { body: input.body, type: 'broadcast' })) };
      },
      get_messages: (input, actor) => this.inbox(requireActor(actor), input),
      ack_message: (input, actor) => this.acknowledge(requireActor(actor), input.id),
      reply: (input, actor) => {
        const id = requireActor(actor);
        const original = this.inboxMessage(input.id, id);
        return this.send(id, this.recipient(original.sender), { body: input.body, type: 'direct' }, input.id);
      },
      events: (input) => this.events(input),
    };
  }

  /**
   * Insert a new agent, or update a returning one, without coordination
   * side effects. Runs inside the caller's transaction.
   *
   * @param input - Validated registration details.
   * @returns The agent's ID.
   * @throws {MeshError} IDENTITY_CONFLICT, AGENT_LEFT or AGENT_ACTIVE.
   */
  private upsertAgent(input: OperationInput<'register'>): string {
    const prior = selectOne(this.db, agentCredentialRowSchema, 'SELECT * FROM agents WHERE name = ?', input.name);
    const now = this.now();
    const lifetime: AgentLifetime = input.ephemeral ? 'session' : 'durable';

    if (prior !== undefined) {
      if (prior.secret_hash !== hash(input.secret)) {
        throw new MeshError('IDENTITY_CONFLICT', 'This name belongs to another identity.');
      }
      if (prior.lifetime === 'ended') {
        throw new MeshError('AGENT_LEFT', 'This session has ended. Start a new session to join again.');
      }
      const isLeaseHeld =
        prior.session_id !== input.sessionId &&
        prior.last_seen > now - this.config.offlineMs &&
        !isDisconnected(prior.status);
      if (isLeaseHeld) {
        throw new MeshError(
          'AGENT_ACTIVE',
          'Another live bridge uses this name. Choose a distinct name or wait for the offline timeout.',
        );
      }
      // A returning agent comes back IDLE; coordination refreshes presence.
      const status: AgentStatus = isDisconnected(prior.status) ? 'IDLE' : prior.status;
      run(
        this.db,
        'UPDATE agents SET session_id = ?, provider = ?, runtime = ?, role = ?, status = ?, lifetime = ?, last_seen = ? WHERE id = ?',
        input.sessionId,
        input.provider,
        input.runtime,
        input.role,
        status,
        lifetime,
        now,
        prior.id,
      );
      if (prior.session_id !== input.sessionId || status !== prior.status) {
        this.event('AGENT_RECONNECTED', prior.id);
      }
      return prior.id;
    }

    const id = `ag_${randomUUID()}`;
    run(
      this.db,
      'INSERT INTO agents(id, name, secret_hash, session_id, provider, runtime, role, status, lifetime, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      input.name,
      hash(input.secret),
      input.sessionId,
      input.provider,
      input.runtime,
      input.role,
      'IDLE',
      lifetime,
      now,
      now,
    );
    this.event('AGENT_REGISTERED', id, { name: input.name, provider: input.provider, lifetime });
    return id;
  }

  /**
   * End a session identity whose bridge disconnected.
   *
   * @param id - The session agent's ID.
   * @returns The agent's final row, now STOPPED.
   */
  private depart(id: string): AgentRow {
    this.coordination.depart(id);
    run(this.db, "UPDATE agents SET lifetime = 'ended' WHERE id = ?", id);
    return this.setStatus(id, 'STOPPED', 'Session ended');
  }

  /**
   * Resolve a message recipient (or lead candidate) that can still read its
   * inbox.
   *
   * @param idOrName - The agent's ID or name.
   * @returns The agent's ID.
   * @throws {MeshError} NOT_FOUND for an unknown agent; AGENT_LEFT for an
   *   ended session.
   */
  private recipient(idOrName: string): string {
    const agent = this.agent(idOrName);
    if (agent.lifetime === 'ended') {
      throw new MeshError('AGENT_LEFT', `${agent.name} has left the team; its session ended.`);
    }
    return agent.id;
  }

  /**
   * Renew an agent's lease. A heartbeat from an agent marked OFFLINE restores
   * the presence implied by its coordination phase.
   *
   * @param id - The agent's ID.
   * @returns A heartbeat acknowledgement.
   */
  private heartbeat(id: string): HeartbeatResult {
    const agent = this.agent(id);
    const status = agent.status === 'OFFLINE' ? this.coordination.presence(id) : agent.status;
    run(this.db, 'UPDATE agents SET last_seen = ?, status = ? WHERE id = ?', this.now(), status, id);
    if (status !== agent.status) {
      this.event('AGENT_RECONNECTED', id);
    }
    return { ok: true };
  }

  /**
   * List agents by name, optionally only those in one presence state.
   *
   * @param status - The presence state to filter by, if any.
   * @returns The matching agents' public rows.
   */
  private listAgents(status: AgentStatus | undefined): AgentRow[] {
    // Ended sessions can never return, so they are history, not team members.
    return status === undefined
      ? selectAll(
          this.db,
          agentRowSchema,
          `SELECT ${AGENT_PUBLIC_COLUMNS} FROM agents WHERE lifetime != 'ended' ORDER BY name`,
        )
      : selectAll(
          this.db,
          agentRowSchema,
          `SELECT ${AGENT_PUBLIC_COLUMNS} FROM agents WHERE status = ? AND lifetime != 'ended' ORDER BY name`,
          status,
        );
  }

  /**
   * Summarise the team.
   *
   * @returns Presence counts, blocked agents, unread totals and decisions.
   */
  private teamStatus(): TeamStatus {
    return {
      project: this.config.name,
      projectId: this.config.projectId,
      counts: selectAll(
        this.db,
        countRowSchema.extend({ status: z.enum(AGENT_STATES) }),
        "SELECT status, COUNT(*) AS count FROM agents WHERE lifetime != 'ended' GROUP BY status",
      ),
      blocked: selectAll(
        this.db,
        z.object({ id: z.string(), name: z.string(), status_text: z.string() }),
        "SELECT id, name, status_text FROM agents WHERE status IN ('BLOCKED', 'NEEDS_INPUT') ORDER BY name",
      ),
      unreadMessages: selectCount(
        this.db,
        "SELECT COUNT(*) AS count FROM messages m JOIN agents a ON a.id = m.recipient WHERE m.acknowledged_at IS NULL AND a.lifetime != 'ended'",
      ),
      orchestrator: this.coordination.leadId(),
      pendingCheckIns: selectCount(
        this.db,
        "SELECT COUNT(*) AS count FROM worker_coordination WHERE phase = 'AWAITING_LEAD'",
      ),
    };
  }

  /**
   * Read one page of an agent's inbox. Reading never acknowledges.
   *
   * @param actor - The inbox owner's ID.
   * @param input - Pagination and unread filter.
   * @returns The page and the cursor for the next one.
   */
  private inbox(actor: string, input: OperationInput<'get_messages'>): InboxPage {
    // Fetch one extra row to learn whether another page exists.
    const rows = selectAll(
      this.db,
      inboxRowSchema,
      `SELECT m.*, a.name AS sender_name FROM messages m JOIN agents a ON a.id = m.sender WHERE m.recipient = ? AND m.seq > ? ${input.unreadOnly ? 'AND m.acknowledged_at IS NULL' : ''} ORDER BY m.seq LIMIT ?`,
      actor,
      input.after,
      input.limit + 1,
    );
    const messages = rows.slice(0, input.limit).map((row): InboxMessage => {
      // Decode the stored handoff JSON and re-validate its structure.
      const handoff = row.handoff === null ? null : handoffSchema.parse(parseJson(row.handoff));
      return { ...row, handoff };
    });
    return { messages, hasMore: rows.length > input.limit, nextCursor: messages.at(-1)?.seq ?? input.after };
  }

  /**
   * Find a message in a specific agent's inbox.
   *
   * @param id - The `msg_` identifier to look up.
   * @param recipient - The agent whose inbox must contain the message.
   * @returns The message row.
   * @throws {MeshError} NOT_FOUND unless the message is in that inbox.
   */
  private inboxMessage(id: string, recipient: string): z.output<typeof inboxRowSchema> {
    const row = selectOne(
      this.db,
      inboxRowSchema,
      'SELECT m.*, a.name AS sender_name FROM messages m JOIN agents a ON a.id = m.sender WHERE m.id = ? AND m.recipient = ?',
      id,
      recipient,
    );
    if (row === undefined) {
      throw new MeshError('NOT_FOUND', 'Message not found in your inbox.');
    }
    return row;
  }

  /**
   * Acknowledge a message. Repeating an acknowledgement is safe and records
   * no further event.
   *
   * @param actor - The inbox owner's ID.
   * @param id - The message ID.
   * @returns Confirmation of the acknowledgement.
   */
  private acknowledge(actor: string, id: string): AckResult {
    const message = this.inboxMessage(id, actor);
    if (message.acknowledged_at === null) {
      run(this.db, 'UPDATE messages SET acknowledged_at = ? WHERE id = ?', this.now(), id);
      this.event('MESSAGE_READ', actor, { id });
    }
    return { id, acknowledged: true };
  }

  /**
   * Read one page of the durable event log.
   *
   * @param input - Pagination.
   * @returns The page and the cursor for the next one.
   */
  private events(input: OperationInput<'events'>): EventPage {
    const events = selectAll(
      this.db,
      eventRowSchema,
      'SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?',
      input.after,
      input.limit,
    ).map((row): MeshEvent => ({ ...row, data: parseJson(row.data) }));
    return { events, nextCursor: events.at(-1)?.seq ?? input.after };
  }

  /** Configure the connection and create the schema-1 tables if missing. */
  private createBaseSchema(): void {
    this.db.exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = ${String(BUSY_TIMEOUT_MS)};
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, secret_hash TEXT NOT NULL,
        session_id TEXT NOT NULL, provider TEXT NOT NULL, runtime TEXT NOT NULL, role TEXT NOT NULL,
        status TEXT NOT NULL, status_text TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        sender TEXT NOT NULL REFERENCES agents(id), recipient TEXT NOT NULL REFERENCES agents(id),
        type TEXT NOT NULL, body TEXT NOT NULL, task_id TEXT, handoff TEXT, reply_to TEXT REFERENCES messages(id),
        created_at INTEGER NOT NULL, acknowledged_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS inbox ON messages(recipient, acknowledged_at, seq);
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, actor TEXT,
        data TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO metadata VALUES ('schema_version', '1');`);
  }

  /**
   * Refuse to open a database created for a different project, and stamp a
   * new database with this project's ID.
   *
   * @throws {Error} When the database belongs to another project.
   */
  private verifyProject(): void {
    const existing = selectOne(this.db, valueRowSchema, "SELECT value FROM metadata WHERE key = 'project_id'");
    if (existing !== undefined && existing.value !== this.config.projectId) {
      this.db.close();
      throw new Error('Database belongs to a different project.');
    }
    run(this.db, "INSERT OR IGNORE INTO metadata VALUES ('project_id', ?)", this.config.projectId);
  }

  /**
   * Read the stored schema version and verify this code can open it.
   *
   * @returns The stored schema version.
   * @throws {Error} When the version is unknown, such as one written by newer code.
   */
  private schemaVersion(): string {
    const version = selectOne(
      this.db,
      valueRowSchema,
      "SELECT value FROM metadata WHERE key = 'schema_version'",
    )?.value;
    if (version === undefined || !SUPPORTED_SCHEMA_VERSIONS.has(version)) {
      this.db.close();
      throw new Error(`Unsupported database schema version: ${version ?? 'missing'}`);
    }
    return version;
  }

  /**
   * Create the coordination table and migrate older schemas if needed.
   *
   * Every migration is additive: existing agents, messages and events are
   * kept. Schema 3 adds the agent lifetime column; every existing identity is
   * durable. Schema 2 gives every agent a coordination row (see
   * {@link Coordination.migrate}).
   *
   * @param version - The schema version found on disk.
   */
  private migrate(version: string): void {
    this.transaction(() => {
      this.db.exec(`CREATE TABLE IF NOT EXISTS worker_coordination (
        agent_id TEXT PRIMARY KEY REFERENCES agents(id), phase TEXT NOT NULL,
        request_id TEXT UNIQUE, request_message_id TEXT REFERENCES messages(id),
        summary TEXT NOT NULL, instructions TEXT, decision_note TEXT,
        revision INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );`);
      // Checked by column rather than version, so the step is idempotent.
      const columns = selectAll(this.db, columnRowSchema, "SELECT name FROM pragma_table_info('agents')");
      if (columns.every((column) => column.name !== 'lifetime')) {
        this.db.exec("ALTER TABLE agents ADD COLUMN lifetime TEXT NOT NULL DEFAULT 'durable'");
      }
      if (version === SCHEMA_VERSION) {
        return;
      }
      if (version === '1') {
        this.coordination.migrate();
      }
      run(this.db, "UPDATE metadata SET value = ? WHERE key = 'schema_version'", SCHEMA_VERSION);
    });
  }
}
