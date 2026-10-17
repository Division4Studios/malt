/** @file Jira Cloud transport: site validation, typed keys, credential handles and read-only, redacted requests. */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { test } from 'node:test';

import {
  JiraRequestError,
  environmentCredential,
  jiraGet,
  jiraIssueKeySchema,
  jiraProjectKeySchema,
  jiraSend,
  parseJiraSite,
  redactCredential,
} from '../src/jira/client.ts';

import type { JiraFetch, JiraRequest, JiraTransport } from '../src/jira/client.ts';

/** Fixture site. */
const SITE = 'https://example.atlassian.net';
/** Fixture credential; the token must never appear in any message. */
const CREDENTIAL = { email: 'robot@example.com', token: ['fixture', 'credential', 'value'].join('-') };
// eslint-disable-next-line unicorn/prefer-uint8array-base64 -- Node 24 lacks Uint8Array#toBase64.
const BASIC = Buffer.from(`${CREDENTIAL.email}:${CREDENTIAL.token}`).toString('base64');

/**
 * A transport answering every request with one status and body.
 *
 * @param status - HTTP status.
 * @param body - Body text.
 * @param headers - Response headers.
 * @returns The transport and the requests it received.
 */
function answering(
  status: number,
  body: string,
  headers: Readonly<Record<string, string>> = {},
): { transport: JiraTransport; calls: { url: string; init: JiraRequest }[] } {
  const calls: { url: string; init: JiraRequest }[] = [];
  const fetch: JiraFetch = async (url, init) => {
    await Promise.resolve();
    calls.push({ url, init });
    return {
      status,
      headers: { get: (name) => headers[name.toLowerCase()] ?? null },
      text: async () => {
        await Promise.resolve();
        return body;
      },
    };
  };
  return { transport: { site: { origin: SITE, deployment: 'cloud' }, credential: CREDENTIAL, fetch }, calls };
}

/**
 * Await a request expected to fail with one failure kind.
 *
 * @param promise - Pending request.
 * @param kind - Expected failure kind.
 * @returns The error, for further checks.
 */
async function failure(promise: Promise<unknown>, kind: JiraRequestError['failure']): Promise<JiraRequestError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof JiraRequestError);
    assert.equal(error.failure, kind);
    return error;
  }
  throw new Error('Expected the Jira request to fail.');
}

await test('sites must be https origins; anything off Atlassian Cloud is Data Center', () => {
  assert.deepEqual(parseJiraSite(' https://Example.atlassian.net/ '), { origin: SITE, deployment: 'cloud' });
  assert.equal(parseJiraSite(['http', '//example.atlassian.net'].join(':')), null, 'plain HTTP is refused');
  assert.equal(parseJiraSite('https://user:pass@example.atlassian.net'), null);
  assert.equal(parseJiraSite('https://example.atlassian.net/jira'), null);
  assert.equal(parseJiraSite('https://example.atlassian.net?x=1'), null);
  assert.equal(parseJiraSite('not a url'), null);
  assert.equal(parseJiraSite('https://atlassian.net')?.deployment, 'data-center');
  assert.equal(parseJiraSite('https://jira.example.com')?.deployment, 'data-center');
  assert.equal(parseJiraSite('https://example.atlassian.net:8443')?.deployment, 'data-center');
});

await test('keys stay typed strings, never numbers', () => {
  assert.equal(jiraIssueKeySchema.safeParse('PROJ-123').success, true);
  assert.equal(jiraIssueKeySchema.safeParse('123').success, false);
  assert.equal(jiraIssueKeySchema.safeParse('PROJ-0').success, false);
  assert.equal(jiraProjectKeySchema.safeParse('PROJ').success, true);
  assert.equal(jiraProjectKeySchema.safeParse('proj').success, false);
});

await test('environment handles resolve the token at call time and never store it', () => {
  const environment: NodeJS.ProcessEnv = {};
  const source = environmentCredential({ email: CREDENTIAL.email, tokenVariable: 'JIRA_TOKEN' }, environment);
  assert.equal(source(), null, 'an unset variable is no credential');
  environment['JIRA_TOKEN'] = '';
  assert.equal(source(), null, 'an empty variable is no credential');
  environment['JIRA_TOKEN'] = CREDENTIAL.token;
  assert.deepEqual(source(), CREDENTIAL);
  assert.equal(environmentCredential({ email: '', tokenVariable: 'JIRA_TOKEN' }, environment)(), null);
});

await test('requests are read-only GETs to the configured site, with redirects refused', async () => {
  const fixture = answering(200, '{"ok":true}');
  assert.deepEqual(await jiraGet(fixture.transport, '/rest/api/3/mypermissions', { projectKey: 'PROJ' }), { ok: true });
  const [call] = fixture.calls;
  assert.ok(call !== undefined);
  assert.equal(call.url, `${SITE}/rest/api/3/mypermissions?projectKey=PROJ`);
  assert.equal(call.init.method, 'GET');
  assert.equal(call.init.redirect, 'error');
  assert.equal(call.init.headers['authorization'], `Basic ${BASIC}`);
  await failure(jiraGet(fixture.transport, 'https://other.example/rest/api/3/myself'), 'invalid');
  await failure(jiraGet(fixture.transport, '/secure/admin'), 'invalid');
  assert.equal(fixture.calls.length, 1, 'refused requests are never sent');
});

await test('HTTP failures map to kinds, with Retry-After for rate limits', async () => {
  await failure(jiraGet(answering(401, '').transport, '/rest/api/3/myself'), 'unauthorized');
  await failure(jiraGet(answering(403, '').transport, '/rest/api/3/myself'), 'forbidden');
  await failure(jiraGet(answering(404, '').transport, '/rest/api/3/project/PROJ'), 'not_found');
  await failure(jiraGet(answering(500, '').transport, '/rest/api/3/myself'), 'unreachable');
  const limited = await failure(
    jiraGet(answering(429, '', { 'retry-after': '30' }).transport, '/rest/api/3/myself'),
    'rate_limited',
  );
  assert.equal(limited.retryAfterSeconds, 30);
  const vague = await failure(
    jiraGet(answering(429, '', { 'retry-after': 'soon' }).transport, '/rest/api/3/myself'),
    'rate_limited',
  );
  assert.equal(vague.retryAfterSeconds, null);
  await failure(jiraGet(answering(200, '<html></html>').transport, '/rest/api/3/myself'), 'invalid');
  const oversized = answering(200, `"${'x'.repeat(1_048_577)}"`);
  await failure(jiraGet(oversized.transport, '/rest/api/3/myself'), 'invalid');
});

await test('transport errors and messages never carry the token', async () => {
  const leaky: JiraFetch = async (_url, init) => {
    await Promise.resolve();
    throw new Error(`socket hang up sending ${init.headers['authorization'] ?? ''} for ${CREDENTIAL.token}`);
  };
  const error = await failure(
    jiraGet({ ...answering(200, '').transport, fetch: leaky }, '/rest/api/3/myself'),
    'unreachable',
  );
  assert.match(error.message, /Could not reach Jira/v);
  assert.equal(error.message.includes(CREDENTIAL.token), false);
  assert.equal(error.message.includes(BASIC), false);
  assert.equal(redactCredential(CREDENTIAL, `a ${CREDENTIAL.token} b ${BASIC}`).includes(CREDENTIAL.token), false);
});

await test('mutations send JSON bodies and report Jira validation messages, redacted', async () => {
  const sent = answering(204, '');
  assert.equal(await jiraSend(sent.transport, 'POST', '/rest/api/3/issueLink', { type: { name: 'Blocks' } }), null);
  const [call] = sent.calls;
  assert.ok(call !== undefined);
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers['content-type'], 'application/json');
  assert.equal(call.init.body, '{"type":{"name":"Blocks"}}');
  const refused = answering(400, '{"errorMessages":["Transition is not valid"],"errors":{"resolution":"Required"}}');
  await assert.rejects(jiraSend(refused.transport, 'POST', '/rest/api/3/issue/PROJ-1/transitions', {}), {
    name: 'JiraRequestError',
    failure: 'invalid',
    message: 'Jira refused POST /rest/api/3/issue/PROJ-1/transitions: Transition is not valid; resolution: Required',
  });
  const leaky = answering(400, `{"errorMessages":["token ${CREDENTIAL.token} was rejected"]}`);
  const error = await failure(jiraSend(leaky.transport, 'PUT', '/rest/api/3/issue/PROJ-1', {}), 'invalid');
  assert.equal(error.message.includes(CREDENTIAL.token), false);
  await failure(jiraSend(answering(403, '').transport, 'PUT', '/rest/api/3/issue/PROJ-1', {}), 'forbidden');
  assert.deepEqual(
    await jiraSend(answering(201, '{"id":"5"}').transport, 'POST', '/rest/api/3/issue/PROJ-1/comment', {}),
    {
      id: '5',
    },
  );
});
