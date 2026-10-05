import { MeshError } from './protocol.js';
import { log } from './log.js';

/**
 * Event-driven long polling. A pending request holds no SQLite transaction and
 * consumes no model turn while asleep. The broker calls notify() only after a
 * mutation commits, so a resumed worker always sees the committed decision.
 * State is durable; these HTTP wait handles deliberately are not.
 */
export class Waiters {
  constructor(store) { this.store = store; this.pending = new Map(); }
  snapshot(credentials) {
    // Re-authenticate on EVERY wake, including timeout: a replacement session
    // must fence out a request left behind by an older bridge process.
    const actor = this.store.authenticate(credentials);
    return this.store.execute('work_status', {}, actor);
  }
  result(state, reason) {
    const inbox = this.store.execute('get_messages', { unreadOnly: true, after: 0, limit: 50 }, state.agent_id);
    return { reason, state, ...inbox, timedOut: reason === 'TIMEOUT' };
  }
  reason(state, revision) {
    if (state.unreadMessages) return 'MESSAGES';
    if (state.participant === 'worker' && state.phase === 'WORK_ASSIGNED') return 'WORK_ASSIGNED';
    if (state.participant === 'worker' && state.phase === 'CHECKIN_REQUIRED') return 'CHECKIN_REQUIRED';
    if (state.revision > revision) return state.phase === 'IDLE_APPROVED' ? 'IDLE_APPROVED' : 'STATE_CHANGED';
    return null;
  }
  wait(credentials, { timeoutMs, afterRevision }, signal) {
    const state = this.snapshot(credentials);
    const actor = state.agent_id;
    if (this.pending.has(actor)) throw new MeshError('WAIT_ALREADY_ACTIVE', 'Only one wait may be open per agent.', 409);
    if (afterRevision !== undefined && afterRevision > state.revision) throw new MeshError('INVALID_REVISION', 'afterRevision cannot be ahead of your current state.');
    const revision = afterRevision ?? state.revision;
    const ready = this.reason(state, revision);
    if (ready) return Promise.resolve(this.result(state, ready));
    if (signal?.aborted) return Promise.reject(new MeshError('WAIT_CANCELLED', 'Wait cancelled.', 499));

    return new Promise((resolve, reject) => {
      let timer;
      // Cleanup is shared by success, cancellation, shutdown, and timeout. This
      // prevents disconnected clients from accumulating server-side listeners.
      const finish = (error, result) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        this.pending.delete(actor);
        log('debug', 'wait', 'wait_finished', { actor, reason: result?.reason, code: error?.code });
        if (error) reject(error); else resolve(result);
      };
      const cancel = () => finish(new MeshError('WAIT_CANCELLED', 'Wait cancelled.', 499));
      const check = (timedOut = false) => {
        try {
          const current = this.snapshot(credentials);
          const reason = this.reason(current, revision) ?? (timedOut ? 'TIMEOUT' : null);
          if (reason) finish(null, this.result(current, reason));
        } catch (error) { finish(error); }
      };
      this.pending.set(actor, { check, finish });
      log('debug', 'wait', 'wait_opened', { actor, revision, timeoutMs });
      signal?.addEventListener('abort', cancel, { once: true });
      timer = setTimeout(() => check(true), timeoutMs);
      // No await occurs between the initial read and subscription. Node cannot
      // process another message in that gap, avoiding a lost-wakeup race.
    });
  }
  notify() { for (const waiter of [...this.pending.values()]) waiter.check(); }
  close() {
    for (const waiter of [...this.pending.values()]) waiter.finish(new MeshError('BROKER_STOPPING', 'Broker stopping; reconnect and wait again.', 503));
  }
}
