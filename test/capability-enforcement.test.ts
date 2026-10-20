/**
 * Connector capability enforcement (#78, #92): every entry point to
 * ProjectGitHub.execute (operator RPC, the lead and a real MCP tool call, the
 * factory CLI, the paired console and the supervisor's own delivery adapter)
 * is decided by the project's policy before any remote call or journal write.
 * A connection switch never replays an intent recorded for the previous
 * repository, and an unconfigured Jira tracker reports external setup.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { z } from 'zod/v3';

import { startBroker } from '../src/broker.ts';
import { CapabilityPolicyStore } from '../src/capability-policy.ts';
import { AgentClient, rpc } from '../src/client.ts';
import { parseConnection } from '../src/connector.ts';
import { GitHubDelivery } from '../src/factory/remote.ts';
import { featureSchema } from '../src/factory/schema.ts';
import { runFactoryCommand } from '../src/factory-cli.ts';
import { ProjectGitHub } from '../src/github.ts';
import { MeshError } from '../src/protocol.ts';
import { startWebConsole } from '../src/web/server.ts';

import { brokerUrl, createCleanup, createProject, startBridge, toolErrorCode, updateConfig } from './helpers.ts';

import type { Defer } from './helpers.ts';
import type { Broker } from '../src/broker.ts';
import type { MeshConfig } from '../src/config.ts';
import type { GitHubRunner } from '../src/github.ts';
import type { JiraFetch } from '../src/jira/client.ts';
import type { TestContext } from 'node:test';

/** Existing Project selection used by connect calls. */
const connection = { repository: 'example/app', owner: 'example', projectNumber: 4 };

/** A feature issue request; the project need not be connected to be denied first. */
const issue = {
  requestId: 'policy-issue',
  kind: 'feature' as const,
  title: 'Denied feature',
  description: 'Never reaches GitHub.',
  acceptanceCriteria: ['Nothing is created.'],
};

/** Broker fixture whose GitHub CLI records every attempted call. */
interface Fixture {
  readonly defer: Defer;
  readonly config: MeshConfig;
  readonly calls: string[][];
  /** The running broker, whose store the supervisor's policy reads. */
  readonly broker: Broker;
  /** The fixture GitHub CLI. */
  readonly runner: GitHubRunner;
  /** Requests that reached the fixture Jira site. */
  readonly jiraCalls: string[];
}

/**
 * Start a broker whose GitHub CLI fails visibly once reached, so a passing
 * authorization shows up as GITHUB_UNAVAILABLE and a denial as no call at all.
 *
 * @param t - Owns the broker.
 * @returns Home configuration and the recorded calls.
 */
async function fixture(t: TestContext): Promise<Fixture> {
  const defer = createCleanup(t);
  const initial = createProject(defer, 'malt-enforcement-');
  const calls: string[][] = [];
  const runner: GitHubRunner = async (args) => {
    calls.push([...args]);
    await Promise.resolve();
    throw new MeshError('GITHUB_UNAVAILABLE', 'Fixture GitHub is offline.');
  };
  const jiraCalls: string[] = [];
  const jiraFetch: JiraFetch = async (url) => {
    jiraCalls.push(url);
    await Promise.resolve();
    throw new Error('Fixture Jira is offline.');
  };
  const broker = await startBroker(initial, { port: 0, githubRunner: () => runner, jiraFetch });
  defer(async () => broker.close());
  return { defer, config: updateConfig(initial, { url: brokerUrl(broker.port) }), calls, broker, runner, jiraCalls };
}

/**
 * Save a verified connection and its Project, as a connect would.
 *
 * @param config - Target project.
 * @param repository - Connected `owner/name`.
 * @returns The project's GitHub integration directory.
 */
function connect(config: MeshConfig, repository = 'example/app'): string {
  const directory = path.join(config.directory, 'github');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Disposable project fixture.
  mkdirSync(directory, { recursive: true });
  const verifiedAt = new Date();
  const { v2 } = parseConnection({
    version: 1,
    repository,
    owner: 'example',
    project: { id: 'P_4', number: 4, url: 'https://github.com/users/example/projects/4' },
    statusField: { id: 'status', name: 'Status', options: [] },
    verifiedAt: verifiedAt.toISOString(),
  });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Disposable project fixture.
  writeFileSync(path.join(directory, 'connection.json'), JSON.stringify(v2));
  return directory;
}

/**
 * Allow one capability to the human operator only, as the operator.
 *
 * @param config - Target project.
 * @param capability - Capability name.
 */
async function humanOnly(config: MeshConfig, capability: string): Promise<void> {
  await rpc(config, 'capability_policy_set', { capability, policy: { mode: 'human-only', roles: [] } });
}

/**
 * Apply one operator edit to `project-connect` through the broker.
 *
 * @param config - Target project.
 * @param mode - New mode.
 * @param roles - Approved roles for approved-agent-roles.
 */
async function setConnect(config: MeshConfig, mode: string, roles: string[] = []): Promise<void> {
  await rpc(config, 'capability_policy_set', { capability: 'project-connect', policy: { mode, roles } });
}

await test('operator RPC is denied by policy before any remote call or journal write', async (t) => {
  const { config, calls } = await fixture(t);
  await assert.rejects(rpc(config, 'github_create_issue', issue), {
    code: 'CAPABILITY_DENIED',
    message: /issue-create is disabled.*human project-operator/v,
  });
  await assert.rejects(rpc(config, 'github_set_status', { issue: 1, status: 'Done' }), {
    code: 'CAPABILITY_DENIED',
  });
  await setConnect(config, 'disabled');
  await assert.rejects(rpc(config, 'github_connect', connection), { code: 'CAPABILITY_DENIED' });
  await assert.rejects(
    rpc(config, 'github_connect', { ...connection, projectNumber: undefined, createProject: true }),
    {
      code: 'CAPABILITY_DENIED',
      message: /project-connect/v,
    },
  );
  assert.deepEqual(calls, []);
  // Reads need no capability and still work.
  await rpc(config, 'github_status', {});

  await setConnect(config, 'human-only');
  await assert.rejects(rpc(config, 'github_connect', connection), { code: 'GITHUB_UNAVAILABLE' });
  assert.equal(calls.length, 1, 'an authorized operator reaches GitHub');
});

await test('the lead agent and a real MCP tool call are denied unless their role is approved', async (t) => {
  const { defer, config, calls } = await fixture(t);
  const lead = new AgentClient(config, { role: 'lead' });
  await lead.connect();
  defer(async () => lead.close());
  // A fresh project keeps connection human-only: the lead is refused, not the operator.
  await assert.rejects(lead.call('github_connect', connection), {
    code: 'CAPABILITY_DENIED',
    message: /project-connect is human-only.*as team-lead/v,
  });
  assert.deepEqual(calls, []);
  await setConnect(config, 'approved-agent-roles', ['team-lead']);
  await assert.rejects(lead.call('github_connect', connection), { code: 'GITHUB_UNAVAILABLE' });
  assert.equal(calls.length, 1);
  await lead.close();

  const bridge = await startBridge(config, { name: 'policy-lead', role: 'team-lead' });
  defer(async () => bridge.client.close());
  await rpc(config, 'set_lead', { agent: 'policy-lead' });
  const denied = await bridge.callRaw('mesh_github_set_status', { issue: 1, status: 'Done' });
  assert.equal(denied.isError, true);
  assert.equal(toolErrorCode(denied.payload), 'CAPABILITY_DENIED');
  assert.equal(calls.length, 1, 'the MCP call made no remote request');
});

await test('the factory CLI and paired console cannot bypass a disabled capability', async (t) => {
  const { defer, config, calls } = await fixture(t);
  await setConnect(config, 'disabled');
  const file = path.join(config.directory, 'connect.json');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Disposable CLI input file.
  writeFileSync(file, JSON.stringify(connection));
  await assert.rejects(runFactoryCommand('github-connect', config, { file }), { code: 'CAPABILITY_DENIED' });

  const web = await startWebConsole(config, 0);
  defer(async () => web.close());
  const pair = await fetch(`${web.url}/api/pair`, {
    method: 'POST',
    headers: { Origin: web.url, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: web.pairingCode }),
  });
  const cookie = (pair.headers.get('set-cookie') ?? '').split(';', 1)[0] ?? '';
  const response = await fetch(`${web.url}/api/control?project=home`, {
    method: 'POST',
    headers: { Origin: web.url, 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ operation: 'github_connect', input: connection }),
  });
  assert.equal(response.status, 403);
  assert.match(await response.text(), /project-connect is disabled/v);
  assert.deepEqual(calls, []);
});

await test('a connected project denies a revoked issue creation before its journal or any remote call', async (t) => {
  const { defer, config, calls } = await fixture(t);
  const directory = path.join(config.directory, 'github');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Disposable project fixture.
  mkdirSync(directory, { recursive: true });
  const saved = new Date();
  const { v2 } = parseConnection({
    version: 1,
    repository: 'example/app',
    owner: 'example',
    project: { id: 'P_4', number: 4, url: 'https://github.com/users/example/projects/4' },
    statusField: { id: 'status', name: 'Status', options: [] },
    verifiedAt: saved.toISOString(),
  });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Disposable project fixture.
  writeFileSync(path.join(directory, 'connection.json'), JSON.stringify(v2));
  const lead = new AgentClient(config, { role: 'lead' });
  await lead.connect();
  defer(async () => lead.close());
  await rpc(config, 'capability_policy_set', { capability: 'issue-create', policy: { mode: 'disabled', roles: [] } });
  await assert.rejects(lead.call('github_create_issue', issue), { code: 'CAPABILITY_DENIED' });
  await assert.rejects(rpc(config, 'github_create_issue', issue), { code: 'CAPABILITY_DENIED' });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Inspect only the disposable project's journal directory.
  assert.equal(existsSync(path.join(directory, 'operations')), false, 'no journal was written');
  assert.deepEqual(calls, []);
  // The connected project's lead still holds its other legacy grants.
  await assert.rejects(lead.call('github_set_status', { issue: 1, status: 'Done' }), { code: 'GITHUB_UNAVAILABLE' });
});

await test('the supervisor cannot bypass a capability through the real delivery adapter', async (t) => {
  const { config, calls, broker, runner } = await fixture(t);
  const directory = connect(config);
  // Human only lets the operator create and move issues but not the supervisor, which acts as team-lead.
  await humanOnly(config, 'issue-create');
  await humanOnly(config, 'transition');
  const github = new ProjectGitHub(config, runner, new CapabilityPolicyStore(broker.store, config));
  const delivery = new GitHubDelivery(config, github, runner);
  const plan = {
    outcome: 'success',
    summary: 'One slice.',
    findings: [],
    deliveries: [
      {
        key: 'only',
        title: 'Only slice',
        description: 'One observable result.',
        acceptanceCriteria: ['The result is observable.'],
        dependencies: [],
      },
    ],
  };
  const feature = featureSchema.parse({
    id: randomUUID(),
    objective: 'Deliver one scoped outcome.',
    phase: 'provisioning',
    productPlan: plan,
    plan,
    parentIssue: null,
    error: null,
    createdAt: 1,
    updatedAt: 1,
  });
  await assert.rejects(delivery.provision(feature), { code: 'CAPABILITY_DENIED', message: /issue-create/v });
  const status = { id: 'bypass-status', kind: 'status' as const, issue: 1, value: 'Done', attempts: 0, retryAt: 0 };
  await assert.rejects(delivery.effect({ ...status, error: null }), {
    code: 'CAPABILITY_DENIED',
    message: /transition/v,
  });
  assert.deepEqual(calls, [], 'no supervisor request reached GitHub');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Inspect only the disposable project's journal directory.
  assert.equal(existsSync(path.join(directory, 'operations')), false, 'no journal was written');
  // The same policy lets the human operator through, so the denial is the supervisor's own.
  await assert.rejects(rpc(config, 'github_create_issue', issue), { code: 'GITHUB_UNAVAILABLE' });
  assert.equal(calls.length > 0, true);
});

await test('a connection switch never replays an intent recorded for the previous repository', async (t) => {
  const { config, calls, jiraCalls } = await fixture(t);
  connect(config);
  await humanOnly(config, 'label-manage');
  await humanOnly(config, 'milestone-manage');
  const label = { requestId: 'switch-label', action: 'create', name: 'triage' };
  const milestone = { requestId: 'switch-milestone', action: 'create', title: 'v2' };
  // Each change is recorded as pending, then fails against the original repository.
  await assert.rejects(rpc(config, 'github_label_manage', label), { code: 'GITHUB_UNAVAILABLE' });
  await assert.rejects(rpc(config, 'github_milestone_manage', milestone), { code: 'GITHUB_UNAVAILABLE' });
  assert.ok(calls.some((call) => call.some((part) => part.includes('repos/example/app/'))));
  const before = calls.length;

  // A saved but unverified switch refuses every change; once the new repository is verified, the old intents are refused.
  await rpc(config, 'github_section_save', { source: { repository: 'example/other', repositoryId: 'R_2' } });
  await assert.rejects(rpc(config, 'github_label_manage', label), { message: /not verified/v });
  connect(config, 'example/other');
  await assert.rejects(rpc(config, 'github_label_manage', label), {
    code: 'INVALID_INPUT',
    message: /different change/v,
  });
  await assert.rejects(rpc(config, 'github_milestone_manage', milestone), {
    code: 'INVALID_INPUT',
    message: /different change/v,
  });
  assert.equal(calls.length, before, 'the old intents made no request after the switch');
  assert.equal(
    calls.some((call) => call.some((part) => part.includes('example/other'))),
    false,
    'nothing reached the new repository',
  );

  // Switching the tracker to Jira without its token set needs setup outside MALT and never connects.
  await rpc(config, 'github_section_save', {
    jiraTracker: {
      site: 'https://example.atlassian.net',
      projectKey: 'PROJ',
      projectId: '10000',
      email: 'robot@example.com',
      tokenVariable: 'MALT_UNSET_FIXTURE_JIRA_TOKEN',
    },
  });
  const stepError = z.object({ step: z.string() });
  const verification = z.object({ state: z.string(), errors: z.array(stepError) });
  const tracker = z.object({ provider: z.literal('jira'), verification });
  const status = z
    .object({ connected: z.boolean(), connectionV2: z.object({ tracker }) })
    .parse(await rpc(config, 'github_verify', {}));
  assert.equal(status.connectionV2.tracker.verification.state, 'external');
  assert.equal(status.connectionV2.tracker.verification.errors[0]?.step, 'credential');
  assert.equal(status.connected, false);
  assert.deepEqual(jiraCalls, [], 'an unset token is never sent');
});
