/** @file Jira mutations ask the project's capability policy first: a denial makes no request; allowed calls send exact bodies. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CapabilityPolicyStore } from '../src/capability-policy.ts';
import {
  JIRA_WRITE_CAPABILITIES,
  adfDocument,
  commentOnJiraIssue,
  createJiraIssue,
  editJiraLabels,
  linkJiraIssues,
  transitionJiraIssue,
} from '../src/jira/writes.ts';
import { MeshError } from '../src/protocol.ts';
import { Store } from '../src/store.ts';

import { createCleanup, createProject } from './helpers.ts';

import type { JiraFetch, JiraRequest, JiraTransport } from '../src/jira/client.ts';
import type { JiraWriteContext } from '../src/jira/writes.ts';
import type { TestContext } from 'node:test';

/** The project operator, as the broker derives it from a project-token caller. */
const OPERATOR = { kind: 'human', id: 'project-operator' } as const;
/** The supervisor acting for the product owner. */
const OWNER = { kind: 'supervisor', role: 'product-owner' } as const;

/** One recorded request. */
interface Call {
  /** Requested URL. */
  readonly url: string;
  /** Request options. */
  readonly init: JiraRequest;
}

/**
 * A transport recording requests and answering each with one status and body.
 *
 * @param status - HTTP status.
 * @param body - Response body.
 * @returns The transport and its calls.
 */
function recording(status = 201, body = '{"id":"10001","key":"PROJ-7"}'): { transport: JiraTransport; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: JiraFetch = async (url, init) => {
    await Promise.resolve();
    calls.push({ url, init });
    return {
      status,
      headers: { get: () => null },
      text: async () => {
        await Promise.resolve();
        return body;
      },
    };
  };
  return {
    transport: {
      site: { origin: 'https://example.atlassian.net', deployment: 'cloud' },
      credential: { email: 'robot@example.com', token: 'fixture-credential' },
      fetch,
    },
    calls,
  };
}

/**
 * A project policy store.
 *
 * @param t - Owns cleanup.
 * @returns Store bound to a fresh project.
 */
function policies(t: TestContext): CapabilityPolicyStore {
  const defer = createCleanup(t);
  const config = createProject(defer);
  const store = new Store(config);
  defer(() => {
    store.close();
  });
  return new CapabilityPolicyStore(store, config);
}

/**
 * The JSON body of a recorded request.
 *
 * @param call - Recorded request.
 * @returns Parsed body.
 */
function sent(call: Call | undefined): unknown {
  assert.ok(call?.init.body !== undefined);
  return JSON.parse(call.init.body);
}

/**
 * Whether an error is the denial of the comment capability.
 *
 * @param error - Rejection.
 * @returns True for CAPABILITY_DENIED naming the disabled comment capability.
 */
function isCommentDenial(error: unknown): boolean {
  return (
    error instanceof MeshError && error.code === 'CAPABILITY_DENIED' && error.message.includes('comment is disabled')
  );
}

/**
 * A request as `METHOD /path`.
 *
 * @param call - Recorded request.
 * @returns Method and path.
 */
function describeCall(call: Call): string {
  const url = new URL(call.url);
  return `${call.init.method} ${url.pathname}`;
}

await test('a disabled or ungranted capability denies the mutation before any request', async (t) => {
  const store = policies(t);
  const fixture = recording();
  const context: JiraWriteContext = { transport: fixture.transport, gate: store, principal: OWNER };
  await assert.rejects(commentOnJiraIssue(context, 'PROJ-1', 'Progress'), isCommentDenial);
  store.set(OPERATOR, 'comment', { mode: 'human-only', roles: [] });
  await assert.rejects(commentOnJiraIssue(context, 'PROJ-1', 'Progress'), { code: 'CAPABILITY_DENIED' });
  store.set(OPERATOR, 'comment', { mode: 'approved-agent-roles', roles: ['team-lead'] });
  await assert.rejects(commentOnJiraIssue(context, 'PROJ-1', 'Progress'), { code: 'CAPABILITY_DENIED' });
  assert.equal(fixture.calls.length, 0, 'no denied mutation reaches Jira');
  store.set(OPERATOR, 'comment', { mode: 'approved-agent-roles', roles: ['product-owner'] });
  const comment = recording(201, '{"id":"5"}');
  assert.deepEqual(await commentOnJiraIssue({ ...context, transport: comment.transport }, 'PROJ-1', 'One\n\nTwo'), {
    id: '5',
  });
  assert.deepEqual(sent(comment.calls[0]), { body: adfDocument('One\nTwo') });
});

await test('creating a child needs relationships as well as issue creation', async (t) => {
  const store = policies(t);
  store.set(OPERATOR, 'issue-create', { mode: 'approved-agent-roles', roles: ['product-owner'] });
  const fixture = recording();
  const context: JiraWriteContext = { transport: fixture.transport, gate: store, principal: OWNER };
  const root = { projectKey: 'PROJ', issueTypeId: '10', summary: 'Child', description: 'Body' };
  await assert.rejects(createJiraIssue(context, { ...root, parentKey: 'PROJ-1' }), /relationships is disabled/v);
  assert.equal(fixture.calls.length, 0);
  assert.deepEqual(await createJiraIssue(context, { ...root, labels: ['malt'] }), {
    id: '10001',
    key: 'PROJ-7',
  });
  const [call] = fixture.calls;
  assert.ok(call !== undefined);
  assert.equal(call.url, 'https://example.atlassian.net/rest/api/3/issue');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers['content-type'], 'application/json');
  assert.deepEqual(sent(call), {
    fields: {
      project: { key: 'PROJ' },
      issuetype: { id: '10' },
      summary: 'Child',
      description: adfDocument('Body'),
      labels: ['malt'],
    },
  });
  assert.deepEqual(JIRA_WRITE_CAPABILITIES.createChild, ['issue-create', 'relationships']);
});

await test('the human operator may mutate under human-only policies, with exact request bodies', async (t) => {
  const store = policies(t);
  for (const capability of ['transition', 'relationships', 'label-use'] as const) {
    store.set(OPERATOR, capability, { mode: 'human-only', roles: [] });
  }
  const fixture = recording(204, '');
  const context: JiraWriteContext = { transport: fixture.transport, gate: store, principal: OPERATOR };
  await transitionJiraIssue(context, 'PROJ-1', '31');
  await linkJiraIssues(context, { type: 'Blocks', inwardKey: 'PROJ-2', outwardKey: 'PROJ-1' });
  await editJiraLabels(context, 'PROJ-1', { add: ['malt'], remove: ['triage'] });
  assert.deepEqual(
    fixture.calls.map((call) => describeCall(call)),
    ['POST /rest/api/3/issue/PROJ-1/transitions', 'POST /rest/api/3/issueLink', 'PUT /rest/api/3/issue/PROJ-1'],
  );
  assert.deepEqual(sent(fixture.calls[0]), { transition: { id: '31' } });
  assert.deepEqual(sent(fixture.calls[1]), {
    type: { name: 'Blocks' },
    inwardIssue: { key: 'PROJ-2' },
    outwardIssue: { key: 'PROJ-1' },
  });
  assert.deepEqual(sent(fixture.calls[2]), { update: { labels: [{ add: 'malt' }, { remove: 'triage' }] } });
});

await test('ADF drops blank lines, which Jira rejects as empty text', () => {
  assert.deepEqual(adfDocument('First\n\n  \nSecond'), {
    type: 'doc',
    version: 1,
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'First' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Second' }] },
    ],
  });
});
