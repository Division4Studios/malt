import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { MeshError } from './protocol.js';
import { Coordination } from './coordination.js';
import { log } from './log.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const agentFields = 'id, name, provider, runtime, role, status, status_text, created_at, last_seen';

export class Store {
  // One broker owns this connection. WAL persists committed changes across
  // process/container restarts; BEGIN IMMEDIATE serializes competing mutations.
  constructor(config, { now = Date.now } = {}) {
    this.config = config;
    this.now = now;
    this.db = new DatabaseSync(config.database);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
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
    const existing = this.db.prepare("SELECT value FROM metadata WHERE key = 'project_id'").get();
    if (existing && existing.value !== config.projectId) { this.db.close(); throw new Error('Database belongs to a different project.'); }
    this.db.prepare("INSERT OR IGNORE INTO metadata VALUES ('project_id', ?)").run(config.projectId);
    const version = this.db.prepare("SELECT value FROM metadata WHERE key='schema_version'").get().value;
    if (!['1', '2'].includes(version)) { this.db.close(); throw new Error(`Unsupported database schema version: ${version}`); }
    this.coordination = new Coordination(this);
    this.transaction(() => {
      this.db.exec(`CREATE TABLE IF NOT EXISTS worker_coordination (
        agent_id TEXT PRIMARY KEY REFERENCES agents(id), phase TEXT NOT NULL,
        request_id TEXT UNIQUE, request_message_id TEXT REFERENCES messages(id),
        summary TEXT NOT NULL, instructions TEXT, decision_note TEXT,
        revision INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );`);
      if (version === '1') {
        const agents = this.db.prepare('SELECT id,role,status FROM agents ORDER BY created_at').all();
        for (const agent of agents) this.coordination.ensure(agent.id);
        const lead = agents.find(agent => agent.role === 'lead');
        if (lead) this.coordination.setLead(lead.id);
        for (const agent of agents) {
          if (this.coordination.isWorker(agent.id) && this.coordination.row(agent.id).phase === 'CHECKIN_REQUIRED' && !this.coordination.unread(agent.id)) this.coordination.checkIn(agent.id, 'Available after coordination upgrade.');
          if (agent.status === 'IDLE' && this.coordination.isWorker(agent.id)) this.setStatus(agent.id, 'WAITING', 'Orchestrator approval required');
        }
        this.db.prepare("UPDATE metadata SET value='2' WHERE key='schema_version'").run();
      }
    });
    log('info', 'storage', 'database_ready', { schemaVersion: 2, migrated: version === '1' });
  }
  close() { this.db.close(); log('info', 'storage', 'database_closed'); }
  // No async callback is accepted here: an open SQLite transaction must never
  // span an HTTP wait, model turn, or another network request.
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); log('debug', 'storage', 'transaction_rolled_back', { code: error.code ?? 'ERROR' }); throw error; }
  }
  event(type, actor, data = {}) {
    this.db.prepare('INSERT INTO events(type, actor, data, created_at) VALUES (?, ?, ?, ?)').run(type, actor, JSON.stringify(data), this.now());
    // This is a diagnostic of an event being staged. The transaction can still
    // roll back; SQLite's events table is the authoritative committed history.
    log('debug', 'coordination', 'event_staged', { type, actor });
  }
  agent(id) {
    const row = this.db.prepare(`SELECT ${agentFields} FROM agents WHERE id = ? OR name = ?`).get(id, id);
    if (!row) throw new MeshError('NOT_FOUND', 'Agent not found.', 404);
    return row;
  }
  register(input) {
    return this.transaction(() => {
      const prior = this.db.prepare('SELECT * FROM agents WHERE name = ?').get(input.name);
      const now = this.now();
      if (prior) {
        if (prior.secret_hash !== hash(input.secret)) throw new MeshError('IDENTITY_CONFLICT', 'This name belongs to another identity.', 409);
        // The secret proves durable identity; the session UUID provides a
        // lease so two live bridges cannot accidentally share one inbox owner.
        if (prior.session_id !== input.sessionId && prior.last_seen > now - this.config.offlineMs && !['OFFLINE', 'STOPPED', 'FAILED'].includes(prior.status)) {
          throw new MeshError('AGENT_ACTIVE', 'Another live bridge uses this name. Choose a distinct name or wait for the offline timeout.', 409);
        }
        const status = ['OFFLINE', 'STOPPED', 'FAILED'].includes(prior.status) ? 'IDLE' : prior.status;
        this.db.prepare('UPDATE agents SET session_id=?, provider=?, runtime=?, role=?, status=?, last_seen=? WHERE id=?').run(input.sessionId, input.provider, input.runtime, input.role, status, now, prior.id);
        if (prior.session_id !== input.sessionId || status !== prior.status) this.event('AGENT_RECONNECTED', prior.id);
        this.coordination.registered(prior.id);
        return this.agent(prior.id);
      }
      const id = `ag_${randomUUID()}`;
      this.db.prepare('INSERT INTO agents(id,name,secret_hash,session_id,provider,runtime,role,status,created_at,last_seen) VALUES (?,?,?,?,?,?,?,?,?,?)').run(id, input.name, hash(input.secret), input.sessionId, input.provider, input.runtime, input.role, 'IDLE', now, now);
      this.event('AGENT_REGISTERED', id, { name: input.name, provider: input.provider });
      this.coordination.registered(id);
      return this.agent(id);
    });
  }
  authenticate(credentials) {
    // Never trust a caller-supplied name as authorization. Match the stored
    // identity secret AND the current session before any agent operation.
    const row = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(credentials?.agentId ?? '');
    if (!row || row.secret_hash !== hash(credentials?.secret ?? '') || row.session_id !== credentials?.sessionId) throw new MeshError('UNAUTHORIZED_AGENT', 'Agent credentials or session are invalid.', 401);
    return row.id;
  }
  heartbeat(id) {
    const agent = this.agent(id);
    const status = agent.status === 'OFFLINE' ? this.coordination.presence(id) : agent.status;
    this.db.prepare('UPDATE agents SET last_seen=?, status=? WHERE id=?').run(this.now(), status, id);
    if (status !== agent.status) this.event('AGENT_RECONNECTED', id);
    return { ok: true };
  }
  expire() {
    // Offline is a connectivity observation, not an idle/work decision. The
    // coordination row and pending request deliberately survive lease expiry.
    return this.transaction(() => {
      const stale = this.db.prepare("SELECT id FROM agents WHERE last_seen <= ? AND status NOT IN ('OFFLINE','STOPPED','FAILED')").all(this.now() - this.config.offlineMs);
      for (const { id } of stale) {
        this.db.prepare("UPDATE agents SET status='OFFLINE' WHERE id=?").run(id);
        this.event('AGENT_DISCONNECTED', id, { reason: 'heartbeat_timeout' });
      }
      return stale.length;
    });
  }
  setStatus(id, status, text = '') {
    this.db.prepare('UPDATE agents SET status=?, status_text=?, last_seen=? WHERE id=?').run(status, text, this.now(), id);
    this.event(status === 'OFFLINE' ? 'AGENT_DISCONNECTED' : 'AGENT_STATUS_CHANGED', id, { status, text });
    return this.agent(id);
  }
  send(sender, recipient, input, replyTo = null) {
    // Message + event + idle-revocation share the caller's transaction. A lead
    // cannot approve a stale request between delivery and revocation.
    const id = `msg_${randomUUID()}`;
    const result = this.db.prepare('INSERT INTO messages(id,sender,recipient,type,body,task_id,handoff,reply_to,created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(id, sender, recipient, input.type ?? 'direct', input.body, input.taskId ?? null, input.handoff ? JSON.stringify(input.handoff) : null, replyTo, this.now());
    this.event('MESSAGE_SENT', sender, { id, recipient, type: input.type ?? 'direct' });
    this.coordination.onMessage(recipient);
    return { id, seq: Number(result.lastInsertRowid), recipient };
  }
  inboxMessage(id, recipient) {
    const row = this.db.prepare('SELECT * FROM messages WHERE id=? AND recipient=?').get(id, recipient);
    if (!row) throw new MeshError('NOT_FOUND', 'Message not found in your inbox.', 404);
    return row;
  }
  execute(operation, input, actor) {
    return this.transaction(() => {
      switch (operation) {
        case 'whoami': return this.agent(actor);
        case 'heartbeat': return this.heartbeat(actor);
        case 'disconnect': return this.setStatus(actor, 'OFFLINE', 'Bridge disconnected');
        case 'set_status': {
          if (input.status === 'IDLE' && this.coordination.isWorker(actor) && this.coordination.row(actor)?.phase !== 'IDLE_APPROVED') throw new MeshError('IDLE_NOT_APPROVED', 'Check in and wait for explicit idle approval from the orchestrator.', 409);
          return this.setStatus(actor, input.status, input.text);
        }
        case 'set_lead': return this.coordination.setLead(this.agent(input.agent).id);
        case 'check_in': return this.coordination.checkIn(actor, input.summary);
        case 'work_status': return this.coordination.snapshot(actor);
        case 'list_check_ins': return this.coordination.list(actor);
        case 'answer_check_in': return this.coordination.answer(actor, input);
        case 'list_agents': return input.status ? this.db.prepare(`SELECT ${agentFields} FROM agents WHERE status=? ORDER BY name`).all(input.status) : this.db.prepare(`SELECT ${agentFields} FROM agents ORDER BY name`).all();
        case 'team_status': return {
          project: this.config.name, projectId: this.config.projectId,
          counts: this.db.prepare('SELECT status, COUNT(*) AS count FROM agents GROUP BY status').all(),
          blocked: this.db.prepare("SELECT id,name,status_text FROM agents WHERE status IN ('BLOCKED','NEEDS_INPUT') ORDER BY name").all(),
          unreadMessages: this.db.prepare('SELECT COUNT(*) AS count FROM messages WHERE acknowledged_at IS NULL').get().count,
          orchestrator: this.coordination.leadId(),
          pendingCheckIns: this.db.prepare("SELECT COUNT(*) AS count FROM worker_coordination WHERE phase='AWAITING_LEAD'").get().count,
        };
        case 'send_message': return this.send(actor, this.agent(input.to).id, input);
        case 'broadcast': return { messages: this.db.prepare('SELECT id FROM agents WHERE id != ? ORDER BY name').all(actor).map(({ id }) => this.send(actor, id, { ...input, type: 'broadcast' })) };
        case 'get_messages': {
          const rows = this.db.prepare(`SELECT m.*, a.name AS sender_name FROM messages m JOIN agents a ON a.id=m.sender WHERE m.recipient=? AND m.seq>? ${input.unreadOnly ? 'AND m.acknowledged_at IS NULL' : ''} ORDER BY m.seq LIMIT ?`).all(actor, input.after, input.limit + 1);
          const hasMore = rows.length > input.limit;
          const messages = rows.slice(0, input.limit).map(row => ({ ...row, handoff: row.handoff ? JSON.parse(row.handoff) : null }));
          return { messages, hasMore, nextCursor: messages.at(-1)?.seq ?? input.after };
        }
        case 'ack_message': {
          const message = this.inboxMessage(input.id, actor);
          if (message.acknowledged_at === null) {
            this.db.prepare('UPDATE messages SET acknowledged_at=? WHERE id=?').run(this.now(), input.id);
            this.event('MESSAGE_READ', actor, { id: input.id });
          }
          return { id: input.id, acknowledged: true };
        }
        case 'reply': return this.send(actor, this.inboxMessage(input.id, actor).sender, { body: input.body, type: 'direct' }, input.id);
        case 'events': {
          const events = this.db.prepare('SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT ?').all(input.after, input.limit);
          return { events: events.map(row => ({ ...row, data: JSON.parse(row.data) })), nextCursor: events.at(-1)?.seq ?? input.after };
        }
        default: throw new MeshError('UNKNOWN_OPERATION', 'Unknown operation.', 404);
      }
    });
  }
}
