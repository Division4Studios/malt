/**
 * Local operator sessions are separate from project and provider credentials.
 *
 * @file
 */
import { Buffer } from 'node:buffer';
import { randomBytes, timingSafeEqual } from 'node:crypto';

import type { IncomingMessage, ServerResponse } from 'node:http';

/** Local operator session lifetime. */
const SESSION_MS = 28_800_000;
/** Maximum concurrent browser sessions. */
const SESSION_LIMIT = 8;
/** Pairing attempts per rate window. */
const ATTEMPT_LIMIT = 5;
/** Pairing rate window. */
const RATE_MS = 60_000;
/** Pairing code entropy in bytes. */
const PAIR_BYTES = 8;
/** Session secret entropy in bytes. */
const SESSION_BYTES = 32;
/** Cookie duration conversion. */
const SECOND_MS = 1000;

/**
 * Compare session credentials without exposing them in a response.
 *
 * @param left - Presented secret.
 * @param right - Expected secret.
 * @returns Whether they match.
 */
function isSameSecret(left: string, right: string): boolean {
  const actual = Buffer.from(left);
  const expected = Buffer.from(right);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * A random pairing code held only in memory.
 *
 * @returns Hex pairing code.
 */
function memoryCode(): string {
  return randomBytes(PAIR_BYTES).toString('hex');
}

/** Authenticated loopback-only control boundary. */
export class OperatorSessions {
  /** Trusted server origin established after binding. */
  public origin = '';
  /** Session secrets remain only in HttpOnly cookies and server memory. */
  private readonly sessions = new Map<string, number>();
  /** Single loopback rate window prevents pairing brute force. */
  private attempts = 0;
  /** Current rate window. */
  private windowAt = 0;
  /** Reads the current pairing code; a persisted source honours rotation without a restart. */
  private readonly code: () => string;

  /**
   * Create the session boundary.
   *
   * @param code - Current pairing code source; defaults to one random code kept in memory.
   */
  public constructor(code?: () => string) {
    const fixed = memoryCode();
    this.code = code ?? ((): string => fixed);
  }

  /**
   * The current code, displayed only by the owning CLI and never in a browser URL.
   *
   * @returns Code a browser must present to pair.
   */
  public get pairingCode(): string {
    return this.code();
  }

  /**
   * Validate host, origin and Fetch Metadata before any control request.
   *
   * @param request - Incoming browser request.
   * @returns Whether the local origin matches.
   */
  public accepts(request: IncomingMessage): boolean {
    const { port } = new URL(this.origin);
    const { host } = request.headers;
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      return false;
    }
    const { origin } = request.headers;
    const requestOrigin = `http://${host}`;
    if (origin !== undefined && origin !== requestOrigin) {
      return false;
    }
    const isCrossSiteApi =
      request.headers['sec-fetch-site'] === 'cross-site' && request.url?.startsWith('/api/') === true;
    return !isCrossSiteApi && (request.method === 'GET' || origin === requestOrigin);
  }

  /**
   * Authenticate a cookie without revealing project bearer tokens.
   *
   * @param request - Browser request.
   * @returns Whether its session is live.
   */
  public authenticated(request: IncomingMessage): boolean {
    const cookie = request.headers.cookie ?? '';
    const prefix = this.cookiePrefix();
    const secret =
      cookie
        .split(';')
        .map((part) => part.trim())
        .find((part) => part.startsWith(prefix))
        ?.slice(prefix.length) ?? '';
    const expires = this.sessions.get(secret);
    return expires !== undefined && expires > Date.now();
  }

  /**
   * Pair one local browser with a bounded expiring operator session.
   *
   * @param code - Code entered by the operator.
   * @param response - Receives only an HttpOnly session cookie.
   * @returns Whether pairing succeeded.
   */
  public pair(code: string, response: ServerResponse): boolean {
    const now = Date.now();
    if (this.windowAt + RATE_MS < now) {
      this.windowAt = now;
      this.attempts = 0;
    }
    this.attempts += 1;
    if (this.attempts > ATTEMPT_LIMIT || !this.matches(code)) {
      return false;
    }
    for (const [expiredSecret, expires] of this.sessions) {
      if (expires <= now) {
        this.sessions.delete(expiredSecret);
      }
    }
    if (this.sessions.size >= SESSION_LIMIT) {
      const first = this.sessions.keys().next().value;
      if (first !== undefined) {
        this.sessions.delete(first);
      }
    }
    const secret = randomBytes(SESSION_BYTES).toString('hex');
    this.sessions.set(secret, now + SESSION_MS);
    response.setHeader(
      'Set-Cookie',
      `${this.cookiePrefix()}${secret}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${String(SESSION_MS / SECOND_MS)}`,
    );
    return true;
  }

  /**
   * Revoke the current operator cookie.
   *
   * @param request - Authenticated browser request.
   * @param response - Expires its cookie.
   */
  public logout(request: IncomingMessage, response: ServerResponse): void {
    const prefix = this.cookiePrefix();
    const secret = (request.headers.cookie ?? '')
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(prefix))
      ?.slice(prefix.length);
    this.sessions.delete(secret ?? '');
    response.setHeader('Set-Cookie', `${prefix}; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
  }

  /**
   * Compare a presented code with the current one; an unreadable code source fails closed.
   *
   * @param presented - Code entered by the operator.
   * @returns Whether it matches.
   */
  private matches(presented: string): boolean {
    let expected: string;
    try {
      expected = this.code();
    } catch {
      return false;
    }
    return isSameSecret(presented, expected);
  }

  /**
   * Cookies are host-scoped rather than port-scoped, so each console names its own session.
   *
   * @returns Public cookie prefix for the bound operator origin.
   */
  private cookiePrefix(): string {
    const { port } = new URL(this.origin);
    return `mlt_operator_${port === '' ? '80' : port}=`;
  }
}
