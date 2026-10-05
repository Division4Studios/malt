/**
 * Event-driven long polling for `wait_for_work`.
 *
 * A waiting agent holds one open HTTP request. While it waits it holds no
 * SQLite transaction and consumes no model turn: the request is parked in an
 * in-memory registry until something relevant changes or the bounded timeout
 * elapses.
 *
 * The broker calls {@link Waiters.notify} only AFTER a mutation commits, so a
 * resumed waiter always observes committed state, never a half-applied
 * transaction. Durable state lives in SQLite; these wait handles deliberately
 * do not survive a restart (the client simply waits again).
 *
 * A wait resolves with a {@link WakeReason}, checked in priority order:
 * unread messages, then an assignment, then a required check-in, then any
 * revision change (an idle approval or another state change), and finally a
 * timeout. A timeout is transport housekeeping; it never means "you are idle".
 *
 * @file
 */

import { log } from './log.ts';
import { MeshError } from './protocol.ts';

import type { WorkState } from './coordination.ts';
import type { OperationInput } from './protocol.ts';
import type { PresentedCredentials, InboxPage, Store } from './store.ts';

/** Why a wait returned. */
export type WakeReason =
  'CHECKIN_REQUIRED' | 'IDLE_APPROVED' | 'MESSAGES' | 'STATE_CHANGED' | 'TIMEOUT' | 'WORK_ASSIGNED';

/** The response to a completed wait: the reason, state and unread inbox. */
export interface WaitResult extends InboxPage {
  /** Why the wait returned. */
  readonly reason: WakeReason;
  /** The agent's coordination view at the moment of waking. */
  readonly state: WorkState;
  /** Convenience flag: `true` exactly when `reason` is `TIMEOUT`. */
  readonly timedOut: boolean;
}

/** The first page of the unread inbox, attached to every wake result. */
const WAKE_INBOX = { unreadOnly: true, after: 0, limit: 50 } as const;

/** Everything needed to park one wait. */
interface ParkedWaitOptions {
  /** The waiting agent's ID; the registry key. */
  readonly actor: string;
  /** The revision the waiter has already observed. */
  readonly revision: number;
  /** How long to wait before returning `TIMEOUT`, in milliseconds. */
  readonly timeoutMs: number;
  /** Aborted when the HTTP client disconnects. */
  readonly signal: AbortSignal | undefined;
  /** Re-reads the waiter's state; returns the wake result or `null` to keep waiting. */
  readonly evaluate: (isTimeout: boolean) => WaitResult | null;
  /** Removes this wait from the registry once it settles. */
  readonly unregister: () => void;
}

/**
 * One parked wait: a promise settled exactly once by a wake condition, the
 * timeout, a client disconnect or broker shutdown.
 *
 * Every settlement path runs the same cleanup (timer, abort listener and
 * registry entry), so a disconnected client can never leave anything behind.
 */
class ParkedWait {
  /** Settled with the wake result or failure. */
  public readonly promise: Promise<WaitResult>;

  /** The wait's configuration and callbacks. */
  private readonly options: ParkedWaitOptions;

  /** Resolves {@link ParkedWait.promise}. */
  private readonly resolve: (result: WaitResult) => void;

  /** Rejects {@link ParkedWait.promise}. */
  private readonly reject: (error: MeshError) => void;

  /** Fires the timeout check. */
  private readonly timer: NodeJS.Timeout;

  /** Whether the wait has already settled; later settlements are ignored. */
  private isSettled = false;

  /**
   * Park a wait and start its timeout.
   *
   * @param options - The wait's configuration and callbacks.
   */
  public constructor(options: ParkedWaitOptions) {
    this.options = options;
    const { promise, resolve, reject } = Promise.withResolvers<WaitResult>();
    this.promise = promise;
    this.resolve = resolve;
    this.reject = reject;
    options.signal?.addEventListener('abort', this.onAbort, { once: true });
    this.timer = setTimeout(() => {
      this.check(true);
    }, options.timeoutMs);
    log('debug', 'wait', 'wait_opened', {
      actor: options.actor,
      revision: options.revision,
      timeoutMs: options.timeoutMs,
    });
  }

  /**
   * Re-evaluate the waiter's state, settling it if a wake condition holds.
   *
   * @param isTimeout - Whether this check is the timeout firing.
   */
  public check(isTimeout = false): void {
    if (this.isSettled) {
      return;
    }
    let result: WaitResult | null;
    try {
      result = this.options.evaluate(isTimeout);
    } catch (error) {
      // Typically UNAUTHORIZED_AGENT: a newer session fenced this one out.
      this.fail(error instanceof MeshError ? error : new MeshError('INTERNAL', 'Wait failed.', { cause: error }));
      return;
    }
    if (result === null) {
      // Nothing relevant changed yet; keep waiting.
      return;
    }
    this.settle();
    log('debug', 'wait', 'wait_finished', { actor: this.options.actor, reason: result.reason });
    this.resolve(result);
  }

  /**
   * Settle the wait with an error.
   *
   * @param error - The failure to report to the waiting client.
   */
  public fail(error: MeshError): void {
    if (this.isSettled) {
      return;
    }
    this.settle();
    log('debug', 'wait', 'wait_finished', { actor: this.options.actor, code: error.code });
    this.reject(error);
  }

  /** Cancels the wait when the client disconnects; a stable reference so the listener can be removed. */
  private readonly onAbort = (): void => {
    this.fail(new MeshError('WAIT_CANCELLED', 'Wait cancelled.'));
  };

  /** Mark the wait settled and release its timer, abort listener and registry entry. */
  private settle(): void {
    this.isSettled = true;
    clearTimeout(this.timer);
    this.options.signal?.removeEventListener('abort', this.onAbort);
    this.options.unregister();
  }
}

/** Registry of parked `wait_for_work` requests, at most one per agent. */
export class Waiters {
  /** Parked waits keyed by agent ID. Exposed for diagnostics and tests. */
  public readonly pending = new Map<string, ParkedWait>();

  /** The store whose committed state the waiters observe. */
  private readonly store: Store;

  /**
   * Create an empty registry over a store.
   *
   * @param store - The project store.
   */
  public constructor(store: Store) {
    this.store = store;
  }

  /**
   * Wait until something relevant happens to the calling agent.
   *
   * The initial state read and the registration of the waiter happen with no
   * `await` in between. Node.js cannot process another request in that gap,
   * so a notification can never fall between "checked" and "subscribed" (the
   * classic lost-wakeup race).
   *
   * @param credentials - The waiting agent's credentials.
   * @param input - Timeout and the revision the caller has already observed.
   * @param signal - Aborted when the HTTP client disconnects.
   * @returns The wake result.
   * @throws {MeshError} UNAUTHORIZED_AGENT, WAIT_ALREADY_ACTIVE,
   *   INVALID_REVISION, WAIT_CANCELLED or BROKER_STOPPING.
   */
  public async wait(
    credentials: PresentedCredentials | undefined,
    input: OperationInput<'wait_for_work'>,
    signal?: AbortSignal,
  ): Promise<WaitResult> {
    const state = this.snapshot(credentials);
    const actor = state.agent_id;
    if (this.pending.has(actor)) {
      throw new MeshError('WAIT_ALREADY_ACTIVE', 'Only one wait may be open per agent.');
    }
    if (input.afterRevision !== undefined && input.afterRevision > state.revision) {
      throw new MeshError('INVALID_REVISION', 'afterRevision cannot be ahead of your current state.');
    }
    // Without an explicit revision, "changed" means "changed from now".
    const revision = input.afterRevision ?? state.revision;
    const ready = this.reason(state, revision);
    if (ready !== null) {
      return this.result(state, ready);
    }
    if (signal?.aborted === true) {
      throw new MeshError('WAIT_CANCELLED', 'Wait cancelled.');
    }

    const parked = new ParkedWait({
      actor,
      revision,
      timeoutMs: input.timeoutMs,
      signal,
      evaluate: (isTimeout) => {
        const current = this.snapshot(credentials);
        const reason = this.reason(current, revision) ?? (isTimeout ? 'TIMEOUT' : null);
        return reason === null ? null : this.result(current, reason);
      },
      unregister: () => {
        this.pending.delete(actor);
      },
    });
    this.pending.set(actor, parked);
    return parked.promise;
  }

  /** Re-evaluate every parked waiter; called after each committed mutation. */
  public notify(): void {
    // A waiter that settles deletes its own entry. Deleting the current entry
    // while iterating a Map is well defined in JavaScript: iteration simply
    // continues with the next remaining entry.
    for (const waiter of this.pending.values()) {
      waiter.check();
    }
  }

  /** Fail every parked waiter because the broker is shutting down. */
  public close(): void {
    for (const waiter of this.pending.values()) {
      waiter.fail(new MeshError('BROKER_STOPPING', 'Broker stopping; reconnect and wait again.'));
    }
  }

  /**
   * Authenticate the waiter and read its coordination view.
   *
   * Authentication is repeated on EVERY wake, including timeouts: a
   * replacement session must fence out a request left behind by an older
   * bridge process.
   *
   * @param credentials - The waiting agent's credentials.
   * @returns The agent's coordination view.
   */
  private snapshot(credentials: PresentedCredentials | undefined): WorkState {
    const actor = this.store.authenticate(credentials);
    return this.store.execute('work_status', {}, actor);
  }

  /**
   * Build the wake response, including the first page of unread messages.
   *
   * @param state - The agent's coordination view.
   * @param reason - Why the wait is returning.
   * @returns The wake result.
   */
  private result(state: WorkState, reason: WakeReason): WaitResult {
    const inbox = this.store.execute('get_messages', WAKE_INBOX, state.agent_id);
    return { reason, state, ...inbox, timedOut: reason === 'TIMEOUT' };
  }

  /**
   * Decide whether a waiter should wake, in priority order.
   *
   * @param state - The agent's current coordination view.
   * @param revision - The revision the waiter has already observed.
   * @returns The wake reason, or `null` to keep waiting.
   */
  private reason(state: WorkState, revision: number): WakeReason | null {
    if (state.unreadMessages > 0) {
      return 'MESSAGES';
    }
    if (state.participant === 'worker' && state.phase === 'WORK_ASSIGNED') {
      return 'WORK_ASSIGNED';
    }
    if (state.participant === 'worker' && state.phase === 'CHECKIN_REQUIRED') {
      return 'CHECKIN_REQUIRED';
    }
    if (state.revision > revision) {
      return state.phase === 'IDLE_APPROVED' ? 'IDLE_APPROVED' : 'STATE_CHANGED';
    }
    return null;
  }
}
