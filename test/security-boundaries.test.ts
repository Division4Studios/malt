/**
 * Trust boundaries reviewed during CodeQL triage (#245): operator browser
 * sessions and the broker request sink. Team slug routing is covered by
 * `teams.test.ts`.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import test from 'node:test';

import { rpc } from '../src/client.ts';
import { OperatorSessions } from '../src/web/security.ts';

import { createCleanup, createProject } from './helpers.ts';

import type { TestContext } from 'node:test';

/** Bound console origin used by every session scenario. */
const ORIGIN = 'http://127.0.0.1:5555';

/** Cookie name prefix derived from {@link ORIGIN}. */
const PREFIX = 'mlt_operator_5555=';

/** Issued cookies carry 32 random bytes as lowercase hex. */
const SESSION_COOKIE = /^mlt_operator_5555=(?<secret>[\da-f]{64}); HttpOnly; SameSite=Strict; Path=\/; Max-Age=\d+$/v;

/** Maximum concurrent browser sessions in `src/web/security.ts`. */
const SESSION_LIMIT = 8;

/** Pairing attempts per rate window in `src/web/security.ts`. */
const ATTEMPT_LIMIT = 5;

/**
 * Change the first character of a hex secret.
 *
 * @param secret - Hex text.
 * @returns Same length, different value.
 */
function tamper(secret: string): string {
  return `${secret.startsWith('0') ? '1' : '0'}${secret.slice(1)}`;
}

/**
 * Build a real request/response pair over an unconnected socket.
 *
 * @param t - Owns socket disposal.
 * @param cookie - Optional Cookie header.
 * @returns The request and its response.
 */
function exchange(t: TestContext, cookie?: string): { request: IncomingMessage; response: ServerResponse } {
  const socket = new Socket();
  const request = new IncomingMessage(socket);
  if (cookie !== undefined) {
    request.headers.cookie = cookie;
  }
  const response = new ServerResponse(request);
  t.after(() => {
    response.destroy();
    request.destroy();
    socket.destroy();
  });
  return { request, response };
}

/**
 * Create console sessions bound to {@link ORIGIN}.
 *
 * @returns Sessions and their private server-side map.
 */
function bound(): { sessions: OperatorSessions; state: Map<unknown, unknown> } {
  const sessions = new OperatorSessions();
  sessions.origin = ORIGIN;
  const state: unknown = Reflect.get(sessions, 'sessions');
  assert.ok(state instanceof Map);
  return { sessions, state };
}

/**
 * Pair successfully and return the issued secret.
 *
 * @param t - Owns the exchange.
 * @param sessions - Console sessions under test.
 * @returns The secret from the HttpOnly cookie.
 */
function pairSecret(t: TestContext, sessions: OperatorSessions): string {
  const { response } = exchange(t);
  assert.equal(sessions.pair(sessions.pairingCode, response), true);
  const secret = SESSION_COOKIE.exec(String(response.getHeader('set-cookie')))?.groups?.['secret'];
  assert.ok(secret !== undefined, 'pairing issues one HttpOnly SameSite=Strict session cookie');
  return secret;
}

/**
 * Whether a Cookie header authenticates.
 *
 * @param t - Owns the exchange.
 * @param sessions - Console sessions under test.
 * @param cookie - Cookie header, if any.
 * @returns Authentication outcome.
 */
function isAccepted(t: TestContext, sessions: OperatorSessions, cookie?: string): boolean {
  return sessions.authenticated(exchange(t, cookie).request);
}

await test('operator sessions authenticate only live issued cookies and keep no usable secret in memory', (t) => {
  const { sessions, state } = bound();
  const secret = pairSecret(t, sessions);

  assert.equal(isAccepted(t, sessions, `other=1; ${PREFIX}${secret}`), true);
  assert.equal(isAccepted(t, sessions, `${PREFIX}${tamper(secret)}`), false);
  assert.equal(isAccepted(t, sessions, PREFIX), false);
  assert.equal(isAccepted(t, sessions, `mlt_operator_4444=${secret}`), false);
  assert.equal(isAccepted(t, sessions), false);
  assert.equal(state.size, 1);
  assert.equal(state.has(secret), false, 'server state is keyed by digest, not by the bearer secret');

  const logout = exchange(t, `${PREFIX}${secret}`);
  sessions.logout(logout.request, logout.response);
  assert.match(
    String(logout.response.getHeader('set-cookie')),
    /^mlt_operator_5555=; HttpOnly; SameSite=Strict; Path=\/; Max-Age=0$/v,
  );
  assert.equal(isAccepted(t, sessions, `${PREFIX}${secret}`), false);
  assert.equal(state.size, 0);
});

await test('operator logout of an unknown or absent cookie revokes nothing and still expires the cookie', (t) => {
  const { sessions, state } = bound();
  const secret = pairSecret(t, sessions);
  for (const cookie of [`${PREFIX}${tamper(secret)}`, PREFIX, undefined]) {
    const { request, response } = exchange(t, cookie);
    sessions.logout(request, response);
    assert.match(String(response.getHeader('set-cookie')), /Max-Age=0$/v);
  }
  assert.equal(state.size, 1);
  assert.equal(isAccepted(t, sessions, `${PREFIX}${secret}`), true);
});

await test('operator sessions evict the oldest digest at the session limit', (t) => {
  const { sessions, state } = bound();
  const issued: string[] = [];
  for (let index = 0; index <= SESSION_LIMIT; index += 1) {
    if (index % ATTEMPT_LIMIT === 0) {
      // Successful pairings also spend attempts; open a fresh rate window.
      Reflect.set(sessions, 'windowAt', 0);
    }
    issued.push(pairSecret(t, sessions));
  }
  assert.equal(state.size, SESSION_LIMIT);
  assert.equal(isAccepted(t, sessions, `${PREFIX}${issued[0] ?? ''}`), false, 'the oldest session was evicted');
  for (const secret of issued.slice(1)) {
    assert.equal(isAccepted(t, sessions, `${PREFIX}${secret}`), true);
  }
});

await test('operator pairing rejects wrong codes without a cookie and rate-limits the window', (t) => {
  const { sessions } = bound();
  const wrong = tamper(sessions.pairingCode);
  for (let attempt = 0; attempt < ATTEMPT_LIMIT; attempt += 1) {
    const rejected = exchange(t).response;
    assert.equal(sessions.pair(wrong, rejected), false);
    assert.equal(rejected.getHeader('set-cookie'), undefined);
  }
  const { response } = exchange(t);
  assert.equal(sessions.pair(sessions.pairingCode, response), false, 'the correct code is refused once spent');
  assert.equal(response.getHeader('set-cookie'), undefined);
});

await test('a broker request never leaves the host, even from a configuration built in memory', async (t) => {
  const defer = createCleanup(t);
  const config = createProject(defer);
  const fetchMock = t.mock.method(globalThis, 'fetch', () => {
    throw new Error('A refused broker URL reached fetch.');
  });
  const refused = [
    // eslint-disable-next-line sonarjs/no-clear-text-protocols -- Refused before any request is made.
    'http://192.0.2.1:4317',
    'https://127.0.0.1:4317',
    'http://127.0.0.1.example:4317',
  ];
  for (const url of refused) {
    await assert.rejects(rpc({ ...config, url }, 'team_status'), { message: 'The broker URL must use local HTTP.' });
  }
  assert.equal(fetchMock.mock.callCount(), 0, 'no token or body was sent');
});
