import { randomUUID } from 'node:crypto';
import { MeshError } from './protocol.js';

// All mutations run inside the Store's transaction, including message creation.
export class Coordination {
  constructor(store) { this.store = store; this.db = store.db; }
  leadId() { return this.db.prepare("SELECT value FROM metadata WHERE key='lead_id'").get()?.value ?? null; }
  row(id) { return this.db.prepare('SELECT * FROM worker_coordination WHERE agent_id=?').get(id); }
  ensure(id) {
    this.db.prepare("INSERT OR IGNORE INTO worker_coordination(agent_id,phase,summary,revision,updated_at) VALUES (?,'CHECKIN_REQUIRED','',0,?)").run(id, this.store.now());
  }
  isWorker(id) { return id !== this.leadId() && this.store.agent(id).role !== 'observer'; }
  unread(id) { return this.db.prepare('SELECT COUNT(*) AS count FROM messages WHERE recipient=? AND acknowledged_at IS NULL').get(id).count; }
  presence(id) {
    if (!this.isWorker(id)) return 'IDLE';
    const phase = this.row(id)?.phase;
    return phase === 'IDLE_APPROVED' ? 'IDLE' : phase === 'WORK_ASSIGNED' ? 'WORKING' : 'WAITING';
  }
  snapshot(id) {
    this.ensure(id);
    const lead = this.leadId();
    const state = this.row(id);
    const unreadMessages = this.unread(id);
    const participant = this.isWorker(id) ? 'worker' : id === lead ? 'orchestrator' : 'observer';
    return {
      ...state,
      orchestrator: lead ? this.store.agent(lead) : null,
      unreadMessages,
      participant,
      nextAction: unreadMessages ? 'PROCESS_MESSAGES' : participant !== 'worker' ? 'REVIEW_MESSAGES' : {
        CHECKIN_REQUIRED: 'CHECK_IN',
        AWAITING_LEAD: 'WAIT_FOR_ORCHESTRATOR', WORK_ASSIGNED: 'DO_ASSIGNED_WORK', IDLE_APPROVED: 'WAIT_FOR_WORK',
      }[state.phase],
    };
  }
  registered(id) {
    this.ensure(id);
    if (!this.leadId() && this.store.agent(id).role === 'lead') this.setLead(id);
    if (this.isWorker(id) && this.row(id).phase === 'CHECKIN_REQUIRED' && !this.unread(id)) this.checkIn(id, 'Connected and available for work.');
    const agent = this.store.agent(id);
    if (['IDLE', 'WAITING', 'OFFLINE', 'STARTING'].includes(agent.status)) this.store.setStatus(id, this.presence(id), agent.status_text);
  }
  retireRequest(row) {
    if (row?.request_message_id) {
      const result = this.db.prepare('UPDATE messages SET acknowledged_at=? WHERE id=? AND acknowledged_at IS NULL').run(this.store.now(), row.request_message_id);
      if (result.changes) this.store.event('CHECKIN_MESSAGE_RESOLVED', row.agent_id, { id: row.request_message_id });
    }
  }
  setLead(id) {
    // Role labels alone do not authorize decisions. The stored lead_id is the
    // single source of authority; replacement invalidates old idle approvals.
    this.store.agent(id);
    if (this.leadId() === id) return this.snapshot(id);
    this.db.prepare("INSERT INTO metadata(key,value) VALUES ('lead_id',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(id);
    this.store.event('ORCHESTRATOR_CHANGED', id);
    for (const agent of this.db.prepare('SELECT id FROM agents').all()) {
      this.ensure(agent.id);
      const row = this.row(agent.id);
      if (row.phase === 'WORK_ASSIGNED' && agent.id !== id) continue;
      this.retireRequest(row);
      this.db.prepare("UPDATE worker_coordination SET phase='CHECKIN_REQUIRED',request_id=NULL,request_message_id=NULL,instructions=NULL,decision_note=NULL,revision=revision+1,updated_at=? WHERE agent_id=?").run(this.store.now(), agent.id);
      if (this.isWorker(agent.id) && !this.unread(agent.id)) this.checkIn(agent.id, row.summary || 'Available after orchestrator change.');
      // Routing changes must not make a disconnected bridge appear online.
      if (!['OFFLINE', 'STOPPED', 'FAILED'].includes(this.store.agent(agent.id).status)) this.store.setStatus(agent.id, this.presence(agent.id), 'Orchestrator changed');
    }
    return this.snapshot(id);
  }
  checkIn(id, summary) {
    // Asking for work ends the previous assignment. Retried pending requests
    // reuse the same request ID rather than repeatedly notifying the lead.
    this.ensure(id);
    if (!this.isWorker(id)) throw new MeshError('NOT_A_WORKER', 'The orchestrator and observers do not request work.');
    if (this.unread(id)) throw new MeshError('UNREAD_MESSAGES', 'Process and acknowledge your inbox before requesting more work.', 409);
    const prior = this.row(id);
    if (prior.phase === 'AWAITING_LEAD') return this.snapshot(id);
    this.retireRequest(prior);
    const requestId = `req_${randomUUID()}`;
    this.db.prepare("UPDATE worker_coordination SET phase='AWAITING_LEAD',request_id=?,request_message_id=NULL,summary=?,instructions=NULL,decision_note=NULL,revision=revision+1,updated_at=? WHERE agent_id=?").run(requestId, summary, this.store.now(), id);
    const lead = this.leadId();
    if (lead) {
      const message = this.store.send(id, lead, {
        type: 'work_request', body: JSON.stringify({ requestId, worker: this.store.agent(id).name, summary, action: 'Use mesh_answer_check_in to assign work or explicitly approve idle.' }),
      });
      this.db.prepare('UPDATE worker_coordination SET request_message_id=? WHERE agent_id=?').run(message.id, id);
    }
    if (!['OFFLINE', 'STOPPED', 'FAILED'].includes(this.store.agent(id).status)) this.store.setStatus(id, 'WAITING', 'Awaiting an explicit orchestrator decision');
    this.store.event('WORK_REQUESTED', id, { requestId, orchestrator: lead, summary });
    return this.snapshot(id);
  }
  answer(actor, input) {
    // Checking the exact request ID implements compare-and-set semantics. A
    // delayed response cannot approve idle after a newer message/check-in.
    if (actor !== this.leadId()) throw new MeshError('NOT_ORCHESTRATOR', 'Only the designated orchestrator can answer check-ins.', 403);
    const row = this.db.prepare('SELECT * FROM worker_coordination WHERE request_id=?').get(input.requestId);
    if (!row || row.phase !== 'AWAITING_LEAD') throw new MeshError('STALE_CHECKIN', 'This check-in is no longer awaiting a decision.', 409);
    if (this.unread(row.agent_id)) throw new MeshError('UNREAD_MESSAGES', 'The worker has unread messages and must process them before an idle/work decision.', 409);
    if (input.decision === 'work' && !input.instructions?.trim()) throw new MeshError('INSTRUCTIONS_REQUIRED', 'Work assignments require instructions.');
    const phase = input.decision === 'idle' ? 'IDLE_APPROVED' : 'WORK_ASSIGNED';
    this.db.prepare('UPDATE worker_coordination SET phase=?,instructions=?,decision_note=?,revision=revision+1,updated_at=? WHERE agent_id=?').run(phase, input.decision === 'work' ? input.instructions : null, input.reason ?? '', this.store.now(), row.agent_id);
    this.retireRequest(row);
    if (!['OFFLINE', 'STOPPED', 'FAILED'].includes(this.store.agent(row.agent_id).status)) this.store.setStatus(row.agent_id, this.presence(row.agent_id), input.decision === 'idle' ? 'Idle approved by orchestrator' : 'Work assigned by orchestrator');
    this.store.event(input.decision === 'idle' ? 'IDLE_APPROVED' : 'WORK_ASSIGNED', actor, { worker: row.agent_id, requestId: row.request_id, reason: input.reason ?? '' });
    return this.snapshot(row.agent_id);
  }
  onMessage(recipient) {
    // A direct message is never itself an idle grant. Any new communication
    // revokes idle/pending decisions but preserves an assignment in progress.
    this.ensure(recipient);
    if (!this.isWorker(recipient)) return;
    const row = this.row(recipient);
    if (['IDLE_APPROVED', 'AWAITING_LEAD'].includes(row.phase)) {
      this.retireRequest(row);
      this.db.prepare("UPDATE worker_coordination SET phase='CHECKIN_REQUIRED',request_id=NULL,request_message_id=NULL,instructions=NULL,decision_note=NULL,revision=revision+1,updated_at=? WHERE agent_id=?").run(this.store.now(), recipient);
      if (!['OFFLINE', 'STOPPED', 'FAILED'].includes(this.store.agent(recipient).status)) this.store.setStatus(recipient, 'WAITING', 'New message; process it and check in again');
      this.store.event('CHECKIN_REQUIRED', recipient, { reason: 'message_received' });
    }
  }
  list(actor) {
    if (actor !== this.leadId()) throw new MeshError('NOT_ORCHESTRATOR', 'Only the designated orchestrator can list check-ins.', 403);
    return this.db.prepare("SELECT c.*,a.name,a.status FROM worker_coordination c JOIN agents a ON a.id=c.agent_id WHERE c.phase='AWAITING_LEAD' AND c.agent_id!=? AND a.role!='observer' ORDER BY c.updated_at,c.agent_id").all(actor);
  }
}
