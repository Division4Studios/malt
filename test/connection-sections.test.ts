/** @file Independent tracker and source saves: unverified until github_verify, the other section kept, project-connect required and fenced per project. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { z } from 'zod/v3';

import { startBroker } from '../src/broker.ts';
import { rpc } from '../src/client.ts';
import { savedSections } from '../src/connection-sections.ts';
import { isConnected, sectionStates } from '../src/connection-verify.ts';
import { parseConnection } from '../src/connector.ts';
import { MeshError } from '../src/protocol.ts';

import { OPERATOR, brokerUrl, createCleanup, createProject, mechanicsGitHub, updateConfig } from './helpers.ts';

import type { GitHubRunner } from '../src/github.ts';

/** Save time. */
const NOW = '2026-10-17T12:00:00.000Z';
/** A tracker selection from discovery. */
const tracker = {
  owner: 'example',
  projectId: 'PVT_4',
  projectNumber: 4,
  url: 'https://github.com/orgs/example/projects/4',
  workflowField: { id: 'F_1', name: 'Status' },
};
/** A source selection from discovery. */
const source = { repository: 'example/app', repositoryId: 'R_1' };
/** Status fields these tests read. */
const statusSchema = z.object({ connected: z.boolean(), verification: z.record(z.string(), z.string()).nullable() });

/**
 * A runner that fails loudly if any GitHub call is made; saving is local.
 *
 * @throws {MeshError} Always.
 */
const offlineRun: GitHubRunner = async () => {
  await Promise.resolve();
  throw new MeshError('GITHUB_UNAVAILABLE', 'Saving must not contact GitHub.');
};

await test('the first save needs both sections; later saves change one and keep the other', () => {
  assert.throws(() => savedSections(null, { tracker }, NOW), { code: 'INVALID_INPUT' });
  assert.throws(() => savedSections(null, {}, NOW), { code: 'INVALID_INPUT' });
  const first = savedSections(null, { tracker, source }, NOW);
  assert.deepEqual(sectionStates(first), { tracker: 'saved', source: 'saved' });
  assert.equal(isConnected(first), false);
  assert.equal(first.tracker.verifiedAt, null);
  assert.deepEqual(first.tracker.credential, { kind: 'github-cli' });
  const verified = {
    ...first,
    source: {
      ...first.source,
      repositoryAliases: ['example/old'],
      verification: { state: 'verified' as const, checkedAt: NOW, errors: [] },
    },
  };
  const moved = savedSections(verified, { tracker: { ...tracker, projectNumber: 5, projectId: 'PVT_5' } }, NOW);
  assert.equal(moved.tracker.projectId, 'PVT_5');
  assert.deepEqual(moved.source, verified.source, 'the source section is untouched');
  const renamed = savedSections(verified, { source: { repository: 'example/renamed', repositoryId: 'R_1' } }, NOW);
  assert.deepEqual(
    renamed.source.repositoryAliases,
    ['example/old', verified.source.repository],
    'the same node keeps its aliases and its previous name',
  );
  const other = savedSections(verified, { source: { repository: 'example/other', repositoryId: 'R_2' } }, NOW);
  assert.deepEqual(other.source.repositoryAliases, []);
});

await test('saving through ProjectGitHub stays local, unverified and fenced to its own project', async (t) => {
  const defer = createCleanup(t);
  const first = createProject(defer);
  const second = createProject(defer);
  const github = mechanicsGitHub(first, offlineRun);
  const saved = statusSchema.parse(await github.execute(OPERATOR, 'github_section_save', { tracker, source }));
  assert.deepEqual(saved, { ...saved, connected: false, verification: { tracker: 'saved', source: 'saved' } });
  const other = statusSchema.parse(await mechanicsGitHub(second, offlineRun).execute(OPERATOR, 'github_status', {}));
  assert.deepEqual(other, { ...other, connected: false, verification: null });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- The second fixture project's own private connection path.
  assert.equal(existsSync(path.join(second.directory, 'github', 'connection.json')), false);
});

await test('saving a section requires the project-connect capability', async (t) => {
  const defer = createCleanup(t);
  const initial = createProject(defer, 'malt-sections-');
  const broker = await startBroker(initial, { port: 0, githubRunner: () => offlineRun });
  defer(async () => broker.close());
  const config = updateConfig(initial, { url: brokerUrl(broker.port) });
  await rpc(config, 'capability_policy_set', {
    capability: 'project-connect',
    policy: { mode: 'disabled', roles: [] },
  });
  await assert.rejects(rpc(config, 'github_section_save', { tracker, source }), { code: 'CAPABILITY_DENIED' });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- The fixture project's own private connection path.
  assert.equal(existsSync(path.join(config.directory, 'github', 'connection.json')), false);
  await rpc(config, 'capability_policy_set', {
    capability: 'project-connect',
    policy: { mode: 'human-only', roles: [] },
  });
  const saved = statusSchema.parse(await rpc(config, 'github_section_save', { tracker, source }));
  assert.equal(saved.connected, false);
});

/** A Jira project chosen from discovery, with the variable that holds its API token. */
const jiraTracker = {
  site: 'https://example.atlassian.net',
  projectKey: 'PROJ',
  projectId: '10000',
  email: 'robot@example.com',
  tokenVariable: 'JIRA_API_TOKEN',
};

await test('a Jira tracker saves beside a GitHub source, unverified, with only an environment handle', () => {
  const first = savedSections(null, { jiraTracker, source }, NOW);
  assert.equal(first.tracker.provider, 'jira');
  assert.deepEqual(first.tracker.jira, {
    site: 'https://example.atlassian.net',
    projectKey: 'PROJ',
    email: 'robot@example.com',
  });
  assert.deepEqual(first.tracker.credential, { kind: 'env', name: 'JIRA_API_TOKEN' });
  assert.equal(first.tracker.owner, 'example');
  assert.equal(first.tracker.projectNumber, undefined, 'a Jira project has no GitHub Project number');
  assert.equal(first.tracker.projectId, '10000');
  assert.equal(first.tracker.url, 'https://example.atlassian.net/browse/PROJ');
  assert.deepEqual(sectionStates(first), { tracker: 'saved', source: 'saved' });
  assert.equal(isConnected(first), false);
  assert.equal(JSON.stringify(first).includes('token'), false, 'only the variable name is saved, never a value');
  const back = parseConnection(structuredClone(first));
  assert.equal(back.v2.tracker.provider, 'jira');
  const switched = savedSections(first, { tracker }, NOW);
  assert.equal(switched.tracker.provider, 'github-projects');
  assert.equal(switched.tracker.jira, undefined);
});

await test('only a GitHub tracker carries a Project number; older Jira sections still load without one being read', () => {
  const jira = savedSections(null, { jiraTracker, source }, NOW);
  assert.equal(parseConnection(structuredClone(jira)).legacy, null, 'a Jira tracker has no GitHub Project view');
  const older = { ...jira, tracker: { ...jira.tracker, projectNumber: 10_000 } };
  const loaded = parseConnection(structuredClone(older));
  assert.equal(loaded.v2.tracker.provider, 'jira');
  assert.equal(loaded.legacy, null, 'the number an older save kept is never read as a Project');
  const github = savedSections(null, { tracker, source }, NOW);
  assert.equal(parseConnection(structuredClone(github)).legacy?.project.number, github.tracker.projectNumber);
  const { projectNumber, ...unnumbered } = github.tracker;
  assert.ok(projectNumber !== undefined);
  assert.throws(() => parseConnection({ ...github, tracker: unnumbered }), { code: 'INVALID_INPUT' });
});

await test('a Jira tracker needs a Cloud site and cannot be saved together with a GitHub tracker', () => {
  assert.throws(
    () => savedSections(null, { jiraTracker: { ...jiraTracker, site: 'https://jira.example.com' }, source }, NOW),
    {
      code: 'INVALID_INPUT',
    },
  );
  assert.throws(() => savedSections(null, { tracker, jiraTracker, source }, NOW), { code: 'INVALID_INPUT' });
});
