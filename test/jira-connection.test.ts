/** @file A saved Jira tracker verifies against Jira through its environment handle; jira_discover reads and saves nothing. */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { z } from 'zod/v3';

import { backupProject } from '../src/backup.ts';
import { startBroker } from '../src/broker.ts';
import { AgentClient, rpc } from '../src/client.ts';
import { savedSections } from '../src/connection-sections.ts';
import { GitHubDelivery } from '../src/factory/remote.ts';
import { runFactoryCommand } from '../src/factory-cli.ts';
import { ProjectGitHub } from '../src/github.ts';
import { discoverJiraConnection, verifyJiraTracker } from '../src/jira/connection.ts';
import { JIRA_PERMISSION_NAMES } from '../src/jira/discovery.ts';

import { OPERATOR, brokerUrl, createCleanup, createProject, mechanicsGitHub, updateConfig } from './helpers.ts';

import type { TrackerConnection } from '../src/connector.ts';
import type { GitHubRunner } from '../src/github.ts';
import type { JiraFetch } from '../src/jira/client.ts';
import type { TestContext } from 'node:test';

/** Verification time. */
const NOW = '2026-10-17T12:00:00.000Z';
/** A fixture token value, built at runtime so no token-shaped literal is committed. */
const TOKEN = ['fixture', 'credential', 'value'].join('-');
/** A Jira project chosen from discovery. */
const JIRA = {
  site: 'https://example.atlassian.net',
  projectKey: 'PROJ',
  projectId: '10000',
  email: 'robot@example.com',
  tokenVariable: 'JIRA_API_TOKEN',
};

/**
 * A fixture Jira site, optionally withholding permissions.
 *
 * @param withheld - Permissions the account lacks.
 * @returns The transport and the paths it was asked for.
 */
function jira(...withheld: string[]): { fetch: JiraFetch; paths: string[] } {
  const paths: string[] = [];
  const held = Object.fromEntries(
    JIRA_PERMISSION_NAMES.map((name) => [name, { havePermission: !withheld.includes(name) }]),
  );
  const routes = new Map<string, unknown>(
    Object.entries({
      '/rest/api/3/serverInfo': { deploymentType: 'Cloud' },
      '/rest/api/3/myself': { accountId: 'acc-1', displayName: 'MALT robot' },
      '/rest/api/3/project/PROJ': { id: '10000', key: 'PROJ', name: 'Project' },
      '/rest/api/3/project/PROJ/statuses': [
        {
          id: '1',
          name: 'Story',
          subtask: false,
          statuses: [
            { id: '10', name: 'To Do' },
            { id: '11', name: 'Done' },
          ],
        },
        { id: '2', name: 'Sub-task', subtask: true, statuses: [{ id: '10', name: 'To Do' }] },
      ],
      '/rest/api/3/mypermissions': { permissions: held },
      '/rest/api/3/issue/createmeta/PROJ/issuetypes/1': { fields: [] },
      '/rest/api/3/issue/createmeta/PROJ/issuetypes/2': { fields: [] },
    }),
  );
  const fetch: JiraFetch = async (raw) => {
    await Promise.resolve();
    const { pathname } = new URL(raw);
    paths.push(pathname);
    const text = JSON.stringify(routes.get(pathname) ?? {});
    return {
      status: routes.has(pathname) ? 200 : 404,
      headers: { get: () => null },
      text: async () => {
        await Promise.resolve();
        return text;
      },
    };
  };
  return { fetch, paths };
}

/**
 * The saved Jira tracker section.
 *
 * @returns Unverified section, as `github_section_save` stores it.
 */
function savedTracker(): TrackerConnection {
  return savedSections(null, { jiraTracker: JIRA, source: { repository: 'example/app', repositoryId: 'R_1' } }, NOW)
    .tracker;
}

await test('a saved Jira tracker verifies with the project identity, statuses and capabilities from Jira', async () => {
  const site = jira();
  const verified = await verifyJiraTracker(savedTracker(), { JIRA_API_TOKEN: TOKEN }, { fetch: site.fetch, now: NOW });
  assert.equal(verified.verification?.state, 'verified');
  assert.equal(verified.verifiedAt, NOW);
  assert.equal(verified.projectId, '10000');
  assert.equal(verified.url, 'https://example.atlassian.net/browse/PROJ');
  assert.deepEqual(verified.workflowField, {
    id: 'status',
    name: 'Status',
    options: [
      { id: '10', name: 'To Do' },
      { id: '11', name: 'Done' },
    ],
  });
  assert.equal(verified.capabilities.issue_create, 'supported');
  assert.equal(verified.capabilities.sub_issues, 'supported');
  assert.equal(JSON.stringify(verified).includes(TOKEN), false);
});

await test('an unset token variable needs external setup without contacting Jira', async () => {
  const site = jira();
  const failed = await verifyJiraTracker(savedTracker(), {}, { fetch: site.fetch, now: NOW });
  assert.equal(failed.verification?.state, 'external');
  assert.deepEqual(
    failed.verification.errors.map(({ step }) => step),
    ['credential'],
  );
  assert.equal(site.paths.length, 0);
  assert.equal(failed.verifiedAt, null);
});

await test('missing permissions degrade the tracker with each Jira admin action', async () => {
  const site = jira('CREATE_ISSUES');
  const degraded = await verifyJiraTracker(savedTracker(), { JIRA_API_TOKEN: TOKEN }, { fetch: site.fetch, now: NOW });
  assert.equal(degraded.verification?.state, 'degraded');
  assert.match(degraded.verification.errors[0]?.message ?? '', /Missing CREATE_ISSUES\. Grant "Create Issues"/v);
  assert.equal(degraded.capabilities.issue_create, 'unsupported');
  assert.equal(degraded.verifiedAt, null);
});

await test('jira_discover runs through the project integration, saves nothing and never returns the token', async (t) => {
  const defer = createCleanup(t);
  const config = createProject(defer);
  const site = jira();
  const github = new ProjectGitHub(
    config,
    async () => {
      await Promise.resolve();
      throw new Error('jira_discover must not call GitHub.');
    },
    {
      authorize: () => {
        /* Reads need no capability. */
      },
      grantConnectionDefaults: () => {
        /* Not exercised. */
      },
    },
    { ghAuthenticated: null, environment: { JIRA_API_TOKEN: TOKEN }, jiraFetch: site.fetch },
  );
  const { tokenVariable, site: url, projectKey, email } = JIRA;
  const discovery = await github.execute(OPERATOR, 'jira_discover', { site: url, projectKey, email, tokenVariable });
  assert.equal(JSON.stringify(discovery).includes(TOKEN), false);
  assert.match(JSON.stringify(discovery), /"state":"verified"/v);
  const status = await github.execute(OPERATOR, 'github_status', {});
  assert.match(JSON.stringify(status), /"connected":false/v, 'discovery saves nothing');
  const leaky: JiraFetch = async (_url, init) => {
    await Promise.resolve();
    throw new Error(`reset while sending ${init.headers['authorization'] ?? ''} ${TOKEN}`);
  };
  const failed = await discoverJiraConnection({ ...JIRA }, { JIRA_API_TOKEN: TOKEN }, leaky);
  assert.equal(failed.state, 'external_setup_required');
  assert.equal(JSON.stringify(failed).includes(TOKEN), false);
});

/**
 * Every file below a folder, recursively.
 *
 * @param root - Folder to walk.
 * @returns Absolute file paths.
 */
function filesBelow(root: string): string[] {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- This test's own temporary project and backup.
  const entries = readdirSync(root, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath, entry.name));
}

/**
 * A GitHub CLI that is offline and names the token in its failure.
 *
 * @returns Never; it always rejects.
 */
async function offlineGitHub(): Promise<never> {
  await Promise.resolve();
  throw new Error(`gh is offline, not ${TOKEN}`);
}

/**
 * Capture everything written to stderr, where the broker logs, at debug level.
 *
 * @param t - Owns the capture.
 * @returns Lines written so far.
 */
function captureLogs(t: TestContext): string[] {
  const written: string[] = [];
  const level = process.env['AGENTMESH_LOG_LEVEL'];
  process.env['AGENTMESH_LOG_LEVEL'] = 'debug';
  t.mock.method(process.stderr, 'write', (chunk: string | Uint8Array) => {
    written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  });
  t.after(() => {
    if (level === undefined) {
      delete process.env['AGENTMESH_LOG_LEVEL'];
    } else {
      process.env['AGENTMESH_LOG_LEVEL'] = level;
    }
  });
  return written;
}

await test('through the CLI and broker the token never reaches logs, responses, errors, events or .malt and its backup', async (t) => {
  const defer = createCleanup(t);
  const variable = 'MALT_FIXTURE_JIRA_TOKEN';
  process.env['MALT_FIXTURE_JIRA_TOKEN'] = TOKEN;
  t.after(() => {
    delete process.env['MALT_FIXTURE_JIRA_TOKEN'];
  });
  // eslint-disable-next-line unicorn/prefer-uint8array-base64 -- Node 24 lacks Uint8Array#toBase64.
  const basic = Buffer.from(`${JIRA.email}:${TOKEN}`).toString('base64');
  const healthy = jira();
  let isRejecting = false;
  let requests = 0;
  // A rejecting site echoes the credential back, as a careless proxy might.
  const fetch: JiraFetch = async (url, init) => {
    requests += 1;
    if (!isRejecting) {
      return healthy.fetch(url, init);
    }
    await Promise.resolve();
    const body = JSON.stringify({ message: `bad ${init.headers['authorization'] ?? ''} ${TOKEN}` });
    return {
      status: 401,
      headers: { get: () => null },
      text: async () => {
        await Promise.resolve();
        return body;
      },
    };
  };
  const initial = createProject(defer, 'malt-jira-redaction-');
  const broker = await startBroker(initial, {
    port: 0,
    jiraFetch: fetch,
    githubRunner: () => offlineGitHub,
  });
  let closed: Promise<void> | null = null;
  const close = async (): Promise<void> => {
    closed ??= broker.close();
    await closed;
  };
  defer(close);
  const config = updateConfig(initial, { url: brokerUrl(broker.port) });
  const backups = mkdtempSync(path.join(tmpdir(), 'malt-jira-backup-'));
  defer(() => {
    rmSync(backups, { recursive: true, force: true });
  });
  const written = captureLogs(t);
  const outputs: unknown[] = [];
  const { site, projectKey, projectId, email } = JIRA;
  const input = path.join(backups, 'jira.json');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- This test's own temporary folder.
  writeFileSync(input, JSON.stringify({ site, projectKey, email, tokenVariable: variable }));
  outputs.push(
    await runFactoryCommand('jira-discover', config, { file: input }),
    await rpc(config, 'github_section_save', {
      jiraTracker: { site, projectKey, projectId, email, tokenVariable: variable },
      source: { repository: 'example/app', repositoryId: 'R_1' },
    }),
    await rpc(config, 'github_verify', {}),
  );
  isRejecting = true;
  outputs.push(
    await rpc(config, 'github_verify', {}),
    await rpc(config, 'github_status', {}),
    await rpc(config, 'events', { after: 0, limit: 100 }),
  );
  await assert.rejects(rpc(config, 'jira_discover', { site, projectKey: 'lower', email, tokenVariable: variable }));
  const member = new AgentClient(config, { role: 'developer' });
  await member.connect();
  defer(async () => member.close());
  const sent = requests;
  await assert.rejects(member.call('jira_discover', { site, projectKey, email, tokenVariable: variable }), {
    code: 'NOT_ORCHESTRATOR',
  });
  assert.equal(requests, sent, 'a member agent cannot make the broker send the token anywhere');
  await member.close();
  t.mock.restoreAll();
  await close();
  const backup = path.join(backups, 'backup');
  await backupProject(config, backup);
  const verified = JSON.stringify(outputs[2]);
  assert.match(verified, /"state":"verified"/v, 'the healthy verification ran');
  assert.match(JSON.stringify(outputs[3]), /"state":"external"/v, 'the rejected token needs setup outside MALT');
  assert.ok(written.length > 0, 'the broker logged while it ran');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Files listed under this test's own folders.
  const stored = [...filesBelow(config.directory), ...filesBelow(backup)].map((file) => readFileSync(file));
  for (const [where, text] of [
    ['responses and events', JSON.stringify(outputs)],
    ['logs', written.join('')],
    ['.malt and its backup', Buffer.concat(stored).toString('latin1')],
  ] as const) {
    assert.equal(text.includes(TOKEN), false, `the token is absent from ${where}`);
    assert.equal(text.includes(basic), false, `the Basic credential is absent from ${where}`);
  }
});

await test('a verified Jira tracker is never read as a GitHub Project by GitHub operations or delivery', async (t) => {
  const defer = createCleanup(t);
  const config = createProject(defer);
  const verified = await verifyJiraTracker(
    savedTracker(),
    { JIRA_API_TOKEN: TOKEN },
    { fetch: jira().fetch, now: NOW },
  );
  const record = savedSections(
    null,
    { jiraTracker: JIRA, source: { repository: 'example/app', repositoryId: 'R_1' } },
    NOW,
  );
  const source = { ...record.source, verifiedAt: NOW, verification: { state: 'verified', checkedAt: NOW, errors: [] } };
  const directory = path.join(config.directory, 'github');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- This test's own temporary project.
  mkdirSync(directory, { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- This test's own temporary project.
  writeFileSync(path.join(directory, 'connection.json'), JSON.stringify({ version: 2, tracker: verified, source }));
  const calls: string[][] = [];
  const runner: GitHubRunner = async (args) => {
    calls.push([...args]);
    await Promise.resolve();
    return {};
  };
  const github = mechanicsGitHub(config, runner);
  const status = z
    .object({ connected: z.boolean(), connection: z.null() })
    .parse(await github.execute(OPERATOR, 'github_status', {}));
  assert.equal(status.connected, true, 'both sections are verified');
  await assert.rejects(github.execute(OPERATOR, 'github_set_status', { issue: 1, status: 'Done' }), {
    code: 'GITHUB_NOT_CONNECTED',
    message: /work tracker is a Jira project/v,
  });
  const delivery = new GitHubDelivery(config, github, runner);
  await assert.rejects(delivery.verify('https://github.com/example/app'), {
    code: 'GITHUB_NOT_CONNECTED',
    message: /Jira tracker is not delivered through yet/v,
  });
  assert.deepEqual(calls, [], 'GitHub was never asked about the Jira project as if it were a GitHub Project');
});
