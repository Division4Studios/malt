/** @file Read-only Jira Cloud discovery against fixture responses: no network, no mutation, no token in any output. */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { test } from 'node:test';

import { environmentCredential } from '../src/jira/client.ts';
import { JIRA_PERMISSION_NAMES, discoverJira } from '../src/jira/discovery.ts';

import type { JiraFetch, JiraRequest, JiraResponse } from '../src/jira/client.ts';

/** Fixture site. */
const SITE = 'https://example.atlassian.net';
/** Fixture token; it must never appear in any result. */
const TOKEN = ['fixture', 'credential', 'value'].join('-');
/** Fixture account email. */
const EMAIL = 'robot@example.com';
/** Base64 of `email:token`, which must not leak either. */
// eslint-disable-next-line unicorn/prefer-uint8array-base64 -- Node 24 lacks Uint8Array#toBase64.
const BASIC = Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64');

/** One fixture route's answer. */
interface Answer {
  /** HTTP status. */
  readonly status: number;
  /** JSON body, or raw text. */
  readonly body?: unknown;
  /** Response headers. */
  readonly headers?: Readonly<Record<string, string>>;
}

/** Create fields every fixture issue type has: MALT fills the required ones, and the reporter has a default. */
const CREATE_FIELDS = [
  { fieldId: 'summary', name: 'Summary', required: true, hasDefaultValue: false },
  { fieldId: 'issuetype', name: 'Issue Type', required: true, hasDefaultValue: false },
  { fieldId: 'reporter', name: 'Reporter', required: true, hasDefaultValue: true },
  { fieldId: 'priority', name: 'Priority', required: false, hasDefaultValue: true },
];

/**
 * A healthy Cloud site where the account holds every permission.
 *
 * @returns Fixture routes keyed by API path.
 */
function healthy(): Map<string, Answer> {
  return new Map<string, Answer>([
    ['/rest/api/3/serverInfo', { status: 200, body: { deploymentType: 'Cloud', version: '1001.0.0' } }],
    [
      '/rest/api/3/myself',
      { status: 200, body: { accountId: 'acc-1', displayName: 'MALT robot', emailAddress: EMAIL } },
    ],
    ['/rest/api/3/project/PROJ', { status: 200, body: { id: '10000', key: 'PROJ', name: 'Project' } }],
    [
      '/rest/api/3/project/PROJ/statuses',
      {
        status: 200,
        body: [
          { id: '1', name: 'Story', subtask: false, statuses: [{ id: '10', name: 'To Do' }] },
          { id: '2', name: 'Sub-task', subtask: true, statuses: [{ id: '10', name: 'To Do' }] },
        ],
      },
    ],
    [
      '/rest/api/3/mypermissions',
      {
        status: 200,
        body: {
          permissions: Object.fromEntries(JIRA_PERMISSION_NAMES.map((name) => [name, { havePermission: true }])),
        },
      },
    ],
    ['/rest/api/3/issue/createmeta/PROJ/issuetypes/1', { status: 200, body: { fields: CREATE_FIELDS } }],
    ['/rest/api/3/issue/createmeta/PROJ/issuetypes/2', { status: 200, body: { values: CREATE_FIELDS } }],
  ]);
}

/**
 * A fixture transport recording every request it receives.
 *
 * @param routes - Answers keyed by API path; anything else is a 404.
 * @returns The transport and the requests it received.
 */
function transport(routes: Map<string, Answer>): { fetch: JiraFetch; calls: { url: URL; init: JiraRequest }[] } {
  const calls: { url: URL; init: JiraRequest }[] = [];
  const fetch: JiraFetch = async (raw, init): Promise<JiraResponse> => {
    await Promise.resolve();
    const url = new URL(raw);
    calls.push({ url, init });
    const answer = routes.get(url.pathname) ?? { status: 404, body: { errorMessages: ['missing'] } };
    const text = typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body ?? {});
    const headers = new Map(Object.entries(answer.headers ?? {}));
    return {
      status: answer.status,
      headers: { get: (name) => headers.get(name.toLowerCase()) ?? null },
      text: async () => {
        await Promise.resolve();
        return text;
      },
    };
  };
  return { fetch, calls };
}

/** A credential source holding the fixture token. */
const credential = environmentCredential({ email: EMAIL, tokenVariable: 'JIRA_TOKEN' }, { JIRA_TOKEN: TOKEN });

/**
 * Assert a result never carries the token, in raw or Basic form.
 *
 * @param value - Any discovery output.
 */
function assertNoToken(value: unknown): void {
  const text = JSON.stringify(value);
  assert.equal(text.includes(TOKEN), false, 'token leaked');
  assert.equal(text.includes(BASIC), false, 'Basic credential leaked');
  assert.equal(text.includes(EMAIL), false, 'account email leaked');
}

await test('a healthy Cloud project is verified, with capabilities derived from the permissions response', async () => {
  const fixture = transport(healthy());
  const now = new Date('2026-10-17T12:00:00.000Z');
  const result = await discoverJira({
    site: SITE,
    projectKey: 'PROJ',
    credential,
    fetch: fixture.fetch,
    now: () => now,
  });
  assert.equal(result.state, 'verified');
  assert.equal(result.deployment, 'cloud');
  assert.deepEqual(result.caller, { accountId: 'acc-1', displayName: 'MALT robot' });
  assert.deepEqual(result.project, { id: '10000', key: 'PROJ', name: 'Project', url: `${SITE}/browse/PROJ` });
  assert.equal(result.issueTypes.length, 2);
  assert.deepEqual(result.fields[0], {
    issueTypeId: '1',
    issueTypeName: 'Story',
    required: [
      { id: 'summary', name: 'Summary', isFilled: true },
      { id: 'issuetype', name: 'Issue Type', isFilled: true },
    ],
  });
  assert.equal(result.fields.length, 2, 'older sites answering with values are read too');
  assert.equal(result.verifiedAt, now.toISOString());
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.capabilities, {
    issue_create: 'supported',
    sub_issues: 'supported',
    dependencies: 'supported',
    labels: 'supported',
    milestones: 'unverified',
    views: 'unsupported',
    pull_requests: 'unsupported',
  });
  for (const { url, init } of fixture.calls) {
    assert.equal(url.origin, SITE, 'only the configured site is contacted');
    assert.equal(init.method, 'GET', 'discovery never mutates Jira');
    assert.equal(init.redirect, 'error', 'redirects never carry the credential elsewhere');
    assert.equal(init.headers['authorization'], `Basic ${BASIC}`);
  }
  const permissions = fixture.calls.find(({ url }) => url.pathname === '/rest/api/3/mypermissions');
  assert.ok(permissions !== undefined);
  assert.equal(permissions.url.searchParams.get('projectKey'), 'PROJ');
  assert.equal(permissions.url.searchParams.get('permissions'), JIRA_PERMISSION_NAMES.join(','));
  assertNoToken(result);
});

await test('missing permissions degrade the connection and name the Jira admin action', async () => {
  const routes = healthy();
  routes.set('/rest/api/3/mypermissions', {
    status: 200,
    body: {
      permissions: {
        ...Object.fromEntries(JIRA_PERMISSION_NAMES.map((name) => [name, { havePermission: true }])),
        CREATE_ISSUES: { havePermission: false },
        LINK_ISSUES: { havePermission: false },
      },
    },
  });
  const result = await discoverJira({ site: SITE, projectKey: 'PROJ', credential, fetch: transport(routes).fetch });
  assert.equal(result.state, 'degraded');
  assert.deepEqual(
    result.missing.map(({ permission }) => permission),
    ['CREATE_ISSUES', 'LINK_ISSUES'],
  );
  assert.match(result.missing[0]?.action ?? '', /Create Issues/v);
  assert.equal(result.capabilities.issue_create, 'unsupported');
  assert.equal(result.verifiedAt, null);
});

await test('a required field MALT cannot fill degrades the connection and names the field', async () => {
  const routes = healthy();
  routes.set('/rest/api/3/issue/createmeta/PROJ/issuetypes/1', {
    status: 200,
    body: {
      fields: [...CREATE_FIELDS, { fieldId: 'customfield_10050', name: 'Customer', required: true }],
    },
  });
  const fixture = transport(routes);
  const result = await discoverJira({ site: SITE, projectKey: 'PROJ', credential, fetch: fixture.fetch });
  assert.equal(result.state, 'degraded');
  assert.deepEqual(result.missing, [], 'the permissions are all held');
  assert.equal(result.problems.length, 1);
  assert.equal(result.problems[0]?.scope, 'fields');
  assert.match(result.problems[0].message, /Story requires "Customer" \(customfield_10050\)/v);
  const meta = fixture.calls.find(({ url }) => url.pathname.endsWith('/issuetypes/1'));
  assert.equal(meta?.url.searchParams.get('maxResults'), '200');
  const unreadable = healthy();
  unreadable.delete('/rest/api/3/issue/createmeta/PROJ/issuetypes/2');
  const partial = await discoverJira({
    site: SITE,
    projectKey: 'PROJ',
    credential,
    fetch: transport(unreadable).fetch,
  });
  assert.equal(partial.state, 'degraded');
  assert.equal(partial.problems[0]?.scope, 'fields');
});

await test('without Create Issues no create fields are read', async () => {
  const routes = healthy();
  routes.set('/rest/api/3/mypermissions', {
    status: 200,
    body: {
      permissions: {
        ...Object.fromEntries(JIRA_PERMISSION_NAMES.map((name) => [name, { havePermission: true }])),
        CREATE_ISSUES: { havePermission: false },
      },
    },
  });
  const fixture = transport(routes);
  const result = await discoverJira({ site: SITE, projectKey: 'PROJ', credential, fetch: fixture.fetch });
  assert.deepEqual(result.fields, []);
  assert.equal(
    fixture.calls.some(({ url }) => url.pathname.includes('/createmeta/')),
    false,
  );
});

await test('a rejected or unauthorized credential reports external setup required, never connected', async () => {
  for (const status of [401, 403]) {
    const routes = healthy();
    routes.set('/rest/api/3/myself', { status, body: { message: 'Client must be authenticated' } });
    const result = await discoverJira({ site: SITE, projectKey: 'PROJ', credential, fetch: transport(routes).fetch });
    assert.equal(result.state, 'external_setup_required');
    assert.equal(result.problems[0]?.scope, 'credential');
    assert.equal(result.verifiedAt, null);
    assert.equal(result.capabilities.issue_create, 'unverified');
    assertNoToken(result);
  }
});

await test('a wrong site or a missing project is a scoped setup problem', async () => {
  const html = healthy();
  html.set('/rest/api/3/serverInfo', { status: 200, body: '<html>Not Jira</html>' });
  const wrong = await discoverJira({ site: SITE, projectKey: 'PROJ', credential, fetch: transport(html).fetch });
  assert.equal(wrong.state, 'external_setup_required');
  assert.equal(wrong.problems[0]?.scope, 'site');
  const absent = healthy();
  absent.delete('/rest/api/3/serverInfo');
  assert.equal(
    (await discoverJira({ site: SITE, projectKey: 'PROJ', credential, fetch: transport(absent).fetch })).problems[0]
      ?.scope,
    'site',
  );
  const missing = healthy();
  missing.delete('/rest/api/3/project/PROJ');
  const project = await discoverJira({ site: SITE, projectKey: 'PROJ', credential, fetch: transport(missing).fetch });
  assert.equal(project.state, 'external_setup_required');
  assert.equal(project.problems[0]?.scope, 'project');
  assert.deepEqual(project.caller, { accountId: 'acc-1', displayName: 'MALT robot' });
});

await test('no site, credential or project key reports external setup required without any request', async () => {
  const fixture = transport(healthy());
  const result = await discoverJira({ site: null, projectKey: null, credential: () => null, fetch: fixture.fetch });
  assert.equal(result.state, 'external_setup_required');
  assert.deepEqual(
    result.problems.map(({ scope }) => scope),
    ['site', 'credential', 'project'],
  );
  assert.equal(fixture.calls.length, 0);
  const unset = environmentCredential({ email: EMAIL, tokenVariable: 'JIRA_TOKEN' }, {});
  assert.equal(unset(), null, 'an unset handle resolves to no credential');
  assert.equal(environmentCredential({ email: EMAIL, tokenVariable: 'JIRA_TOKEN' }, { JIRA_TOKEN: '' })(), null);
});

await test('Data Center and Server are stated unsupported', async () => {
  const fixture = transport(healthy());
  const selfHosted = await discoverJira({
    site: 'https://jira.example.com',
    projectKey: 'PROJ',
    credential,
    fetch: fixture.fetch,
  });
  assert.equal(selfHosted.state, 'unsupported');
  assert.equal(selfHosted.deployment, 'data-center');
  assert.match(selfHosted.problems[0]?.message ?? '', /Data Center and Server are not supported/v);
  assert.equal(fixture.calls.length, 0, 'a self-hosted site is never contacted');
  const server = healthy();
  server.set('/rest/api/3/serverInfo', { status: 200, body: { deploymentType: 'Server' } });
  assert.equal(
    (await discoverJira({ site: SITE, projectKey: 'PROJ', credential, fetch: transport(server).fetch })).state,
    'unsupported',
  );
});

/**
 * A transport whose error message carries the credential, as a careless library might.
 *
 * @param _url - Request URL, unused.
 * @param init - Request options carrying the credential.
 * @returns Never; it always rejects.
 */
const leaky: JiraFetch = async (_url, init) => {
  await Promise.resolve();
  throw new Error(`socket hang up while sending ${init.headers['authorization'] ?? ''} for ${TOKEN}`);
};

await test('rate limits and transport errors are reported without the token', async () => {
  const limited = healthy();
  limited.set('/rest/api/3/myself', { status: 429, headers: { 'retry-after': '30' } });
  const result = await discoverJira({ site: SITE, projectKey: 'PROJ', credential, fetch: transport(limited).fetch });
  assert.equal(result.state, 'external_setup_required');
  assert.match(result.problems[0]?.message ?? '', /Retry after 30 seconds/v);
  const failed = await discoverJira({ site: SITE, projectKey: 'PROJ', credential, fetch: leaky });
  assert.equal(failed.state, 'external_setup_required');
  assert.match(failed.problems[0]?.message ?? '', /Could not reach Jira/v);
  assertNoToken(failed);
});
