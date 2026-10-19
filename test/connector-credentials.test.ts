/** @file Connector credential handles: stored by reference only, scoped per section, checked for presence and redacted once resolved. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { parseConnection, unverifiedCapabilities } from '../src/connector.ts';
import {
  cachedProbe,
  credentialHandleSchema,
  credentialPresence,
  resolveCredential,
  scopedHandle,
} from '../src/credentials.ts';
import { log } from '../src/log.ts';
import { MeshError } from '../src/protocol.ts';
import { redactResolvedSecrets } from '../src/secrets.ts';

/** A token-shaped value that must never be stored or printed. */
const TOKEN = 'jira-token-5f1c0d6e9a7b';
/** Fixed timestamp for saved sections. */
const SAVED = '2026-10-17T00:00:00.000Z';

/**
 * A version 2 connection record whose sections carry the given handles.
 *
 * @param tracker - Tracker section overrides.
 * @param source - Source section overrides.
 * @returns Raw record as it would be read from connection.json.
 */
function record(tracker: Record<string, unknown>, source: Record<string, unknown> = {}): unknown {
  return {
    version: 2,
    tracker: {
      provider: 'github-projects',
      owner: 'example',
      projectId: 'P_1',
      projectNumber: 4,
      url: 'https://github.com/orgs/example/projects/4',
      workflowField: { id: 'field', name: 'Status' },
      capabilities: unverifiedCapabilities(),
      savedAt: SAVED,
      ...tracker,
    },
    source: {
      provider: 'github',
      repository: 'example/app',
      capabilities: unverifiedCapabilities(),
      savedAt: SAVED,
      ...source,
    },
  };
}

await test('a handle stores only its kind and reference name, never a value', () => {
  assert.deepEqual(credentialHandleSchema.parse({ kind: 'github-cli' }), { kind: 'github-cli' });
  assert.deepEqual(credentialHandleSchema.parse({ kind: 'env', name: 'JIRA_API_TOKEN' }), {
    kind: 'env',
    name: 'JIRA_API_TOKEN',
  });
  assert.equal(credentialHandleSchema.safeParse({ kind: 'env', name: 'JIRA_API_TOKEN', value: TOKEN }).success, false);
  assert.equal(credentialHandleSchema.safeParse({ kind: 'github-cli', token: TOKEN }).success, false);
  assert.equal(credentialHandleSchema.safeParse({ kind: 'env', name: 'jira token' }).success, false);
  const saved = parseConnection(record({ credential: { kind: 'github-cli' } }, { credential: { kind: 'github-cli' } }));
  assert.deepEqual(saved.v2.tracker.credential, { kind: 'github-cli' });
  assert.equal(JSON.stringify(saved).includes(TOKEN), false);
  assert.throws(() => parseConnection(record({ credential: { kind: 'github-cli', token: TOKEN } })), {
    code: 'INVALID_INPUT',
  });
});

await test('handles are scoped to the provider of their section', () => {
  assert.deepEqual(scopedHandle({ section: 'tracker', provider: 'jira' }, { kind: 'env', name: 'JIRA_API_TOKEN' }), {
    kind: 'env',
    name: 'JIRA_API_TOKEN',
  });
  assert.throws(() => scopedHandle({ section: 'tracker', provider: 'jira' }, { kind: 'github-cli' }), {
    code: 'INVALID_INPUT',
  });
  assert.throws(() => scopedHandle({ section: 'source', provider: 'github' }, { kind: 'env', name: 'GITHUB_TOKEN' }), {
    code: 'INVALID_INPUT',
  });
  assert.throws(() => parseConnection(record({ credential: { kind: 'env', name: 'JIRA_API_TOKEN' } })), {
    code: 'INVALID_INPUT',
  });
  assert.throws(() => parseConnection(record({}, { credential: { kind: 'env', name: 'JIRA_API_TOKEN' } })), {
    code: 'INVALID_INPUT',
  });
});

await test('presence reports missing for an unset variable or a logged-out gh session, never connected', async () => {
  const handle = { kind: 'env', name: 'JIRA_API_TOKEN' } as const;
  const loggedIn = { ghAuthenticated: async () => await delay(0, true), environment: { JIRA_API_TOKEN: TOKEN } };
  assert.equal(await credentialPresence(handle, loggedIn), 'present');
  assert.equal(await credentialPresence(handle, { ...loggedIn, environment: {} }), 'missing');
  assert.equal(await credentialPresence(handle, { ...loggedIn, environment: { JIRA_API_TOKEN: ' ' } }), 'missing');
  const gh = { kind: 'github-cli' } as const;
  assert.equal(await credentialPresence(gh, loggedIn), 'present');
  assert.equal(
    await credentialPresence(gh, { ...loggedIn, ghAuthenticated: async () => await delay(0, false) }),
    'missing',
  );
  assert.equal(
    await credentialPresence(gh, { ...loggedIn, ghAuthenticated: async () => await delay(0, null) }),
    'unverified',
  );
});

await test('the gh presence answer is reused briefly, then checked again', async () => {
  let calls = 0;
  let now = 0;
  const probe = cachedProbe(
    async () => {
      calls += 1;
      return await delay(0, calls === 1);
    },
    () => now,
  );
  assert.equal(await probe(), true);
  now = 30_000;
  assert.equal(await probe(), true);
  assert.equal(calls, 1);
  now = 61_000;
  assert.equal(await probe(), false, 'clearing the session reports missing after the cache expires');
  assert.equal(calls, 2);
});

await test('a resolved value is redacted from logs and error responses', (t) => {
  assert.throws(() => resolveCredential({ kind: 'env', name: 'JIRA_API_TOKEN' }, {}), {
    code: 'CREDENTIALS_MISSING',
  });
  assert.equal(resolveCredential({ kind: 'env', name: 'JIRA_API_TOKEN' }, { JIRA_API_TOKEN: TOKEN }), TOKEN);
  const failure = new MeshError('GITHUB_UNAVAILABLE', `Jira rejected Basic ${TOKEN} for this request.`);
  assert.equal(redactResolvedSecrets(failure.message), 'Jira rejected Basic [REDACTED] for this request.');
  const written: string[] = [];
  const level = process.env['AGENTMESH_LOG_LEVEL'];
  process.env['AGENTMESH_LOG_LEVEL'] = 'debug';
  t.mock.method(process.stderr, 'write', (chunk: string) => {
    written.push(chunk);
    return true;
  });
  log('warn', 'connector', 'request_failed', { detail: `token ${TOKEN}` });
  t.mock.restoreAll();
  if (level === undefined) {
    delete process.env['AGENTMESH_LOG_LEVEL'];
  } else {
    process.env['AGENTMESH_LOG_LEVEL'] = level;
  }
  assert.equal(written.length, 1);
  const [line] = written;
  assert.equal(line?.includes(TOKEN), false);
  assert.match(written.join(''), /\[REDACTED\]/v);
});
