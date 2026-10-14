/**
 * Versioned GitHub connection record: v1 normalization, v2 persistence,
 * damaged sections and repository renames under a stable node ID.
 *
 * @file
 */

import assert from 'node:assert/strict';
import { mkdirSync as makeDirectory, readFileSync as readFile, writeFileSync as writeFile } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { z } from 'zod';

import { CAPABILITY_NAMES, capabilityState } from '../src/connector.ts';
import { DELIVERY_STATUSES, ProjectGitHub } from '../src/github.ts';
import { refreshReadme } from '../src/summary.ts';

import { createCleanup, createProject } from './helpers.ts';

import type { GitHubRunner } from '../src/github.ts';
import type { TestContext } from 'node:test';

process.env['AGENTMESH_LOG_LEVEL'] = 'silent';

/** Verification time of the saved fixtures. */
const VERIFIED_AT = '2026-10-01T00:00:00.000Z';
/** Option IDs are derived from their position. */
const options = DELIVERY_STATUSES.map((name, index) => ({ id: `option-${String(index)}`, name }));
/** The native Status field of the connected Project, with all required options. */
const statusField = { id: 'field-status', name: 'Status', options };
/** The Project 10 identity. */
const project = { id: 'PVT_project10', number: 10, url: 'https://github.com/orgs/Division4Studios/projects/10' };
/** The saved version 1 connection for Division4Studios/malt. */
const v1Record = {
  version: 1,
  repository: 'Division4Studios/malt',
  owner: 'Division4Studios',
  project,
  statusField,
  verifiedAt: VERIFIED_AT,
};
/** Explicit existing-project selection used by connect calls. */
const selection = { projectNumber: 10, statusFieldName: 'Status' };

for (const version of [1, 2]) {
  await test(`README preserves repository and Project links for connection v${String(version)}`, async (t) => {
    const config = createProject(createCleanup(t));
    const directory = path.join(config.directory, 'github');
    mkdir(directory);
    const file = path.join(directory, 'connection.json');
    if (version === 1) {
      write(file, JSON.stringify(v1Record));
    } else {
      const github = new ProjectGitHub(config, connectRunner('Division4Studios/malt', 'R_node'));
      await github.execute('github_connect', { repository: 'Division4Studios/malt', ...selection });
    }
    const before = read(file);
    refreshReadme(config, { agents: [], lead: null, revision: 1, unreadMessages: 0, pendingCheckIns: 0 });
    const readme = read(path.join(config.directory, 'README.md'));
    assert.ok(readme.includes('GitHub repository: Division4Studios/malt'));
    assert.ok(readme.includes(`GitHub Project: ${project.url}`));
    assert.ok(!readme.includes('saved connection needs repair'));
    assert.equal(read(file), before, 'rendering must not rewrite the saved connection');
  });
}

/** One capability descriptor as serialized. */
const capabilitiesSchema = z.record(z.string(), z.enum(['supported', 'unsupported', 'unverified']));
/** A tracker or source section as seen through github_status. */
const sectionSchema = z.object({
  provider: z.string(),
  projectId: z.string().optional(),
  projectNumber: z.number().optional(),
  workflowField: z.unknown().optional(),
  repository: z.string().optional(),
  repositoryId: z.string().nullable().optional(),
  verifiedAt: z.string().nullable(),
  capabilities: capabilitiesSchema,
});
/** View of github_status used by these tests. */
const statusSchema = z.object({
  connected: z.boolean(),
  connection: z.record(z.string(), z.unknown()).nullable(),
  connectionV2: z.object({ version: z.literal(2), tracker: sectionSchema, source: sectionSchema }).nullable(),
});

/**
 * Runner for projects that must not reach the remote.
 *
 * @returns Never; always rejects.
 */
// eslint-disable-next-line @typescript-eslint/require-await -- Deterministic stub preserves the adapter's asynchronous contract.
const offline: GitHubRunner = async () => {
  throw new Error('unexpected remote call');
};

/**
 * Create a directory inside a test project.
 *
 * @param directory - Directory to create.
 */
function mkdir(directory: string): void {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- The path is inside the test's own temporary project.
  makeDirectory(directory, { recursive: true });
}

/**
 * Write a file inside a test project.
 *
 * @param file - Destination path.
 * @param content - Exact content.
 */
function write(file: string, content: string): void {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- The path is inside the test's own temporary project.
  writeFile(file, content);
}

/**
 * Read a file inside a test project.
 *
 * @param file - Source path.
 * @returns File text.
 */
function read(file: string): string {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- The path is inside the test's own temporary project.
  return readFile(file, 'utf8');
}

/**
 * Write raw connection text into a fresh project.
 *
 * @param t - Test context.
 * @param content - Exact file content.
 * @returns File path and a client over it.
 */
function projectWithText(t: TestContext, content: string): { file: string; github: ProjectGitHub } {
  const config = createProject(createCleanup(t));
  const directory = path.join(config.directory, 'github');
  mkdir(directory);
  const file = path.join(directory, 'connection.json');
  write(file, content);
  return { file, github: new ProjectGitHub(config, offline) };
}

/**
 * Write a connection record into a fresh project.
 *
 * @param t - Test context.
 * @param record - JSON-serializable record.
 * @returns File path and a client over it.
 */
function projectWith(t: TestContext, record: unknown): { file: string; github: ProjectGitHub } {
  return projectWithText(t, JSON.stringify(record));
}

/**
 * Build a runner that serves one repository identity and Project 10.
 *
 * @param repository - Current repository name.
 * @param id - Repository node ID, absent for legacy responses.
 * @returns Stub GitHub runner.
 */
function connectRunner(repository: string, id: string | undefined): GitHubRunner {
  const identity = id === undefined ? { nameWithOwner: repository } : { nameWithOwner: repository, id };
  // eslint-disable-next-line @typescript-eslint/require-await -- Deterministic stub preserves the adapter's asynchronous contract.
  return async (args) => {
    if (args[0] === 'repo') {
      return identity;
    }
    if (args[0] === 'project') {
      const responses: Record<string, unknown> = { view: project, 'field-list': { fields: [statusField] } };
      return responses[args[1] ?? ''] ?? {};
    }
    return { data: { node: { viewerCanUpdate: true } } };
  };
}

/**
 * Require the v2 view in a status result.
 *
 * @param view - Status field that is null when nothing is saved.
 * @returns The non-null section pair.
 * @throws {Error} When the workspace is not connected.
 */
function requireView<T>(view: T | null): T {
  if (view === null) {
    throw new Error('expected a connected workspace');
  }
  return view;
}

/**
 * Read the persisted connection file of a project.
 *
 * @param directory - Project .malt directory.
 * @returns Parsed JSON content.
 */
function savedFile(directory: string): unknown {
  return JSON.parse(read(path.join(directory, 'github', 'connection.json')));
}

await test('a v1 record is read without loss and reports unverified capabilities', async (t) => {
  const { github, file } = projectWith(t, v1Record);
  const before = read(file);
  const status = statusSchema.parse(await github.execute('github_status', {}));
  assert.deepEqual(status.connection, v1Record);
  const view = status.connectionV2;
  assert.notEqual(view, null);
  const { tracker, source } = requireView(view);
  assert.equal(tracker.provider, 'github-projects');
  assert.equal(tracker.projectId, project.id);
  assert.deepEqual(tracker.workflowField, statusField);
  assert.equal(source.repository, 'Division4Studios/malt');
  assert.equal(source.repositoryId, null);
  for (const section of [tracker, source]) {
    const parsed = capabilitiesSchema.parse(section.capabilities);
    assert.equal(Object.keys(parsed).length, CAPABILITY_NAMES.length);
    assert.ok(Object.values(parsed).every((state) => state === 'unverified'));
  }
  assert.equal(read(file), before, 'reading must not rewrite the file');
});

await test('an absent capability is unverified, not unsupported', () => {
  assert.equal(capabilityState({}, 'views'), 'unverified');
  assert.equal(capabilityState({ views: 'unsupported' }, 'views'), 'unsupported');
});

await test('connect writes v2 and keeps the legacy fields', async (t) => {
  const config = createProject(createCleanup(t));
  const github = new ProjectGitHub(config, connectRunner('Division4Studios/malt', 'R_node'));
  const result = z
    .object({ version: z.literal(1), repository: z.string(), statusField: z.object({ name: z.string() }) })
    .parse(await github.execute('github_connect', { repository: 'Division4Studios/malt', ...selection }));
  assert.equal(result.repository, 'Division4Studios/malt');
  assert.equal(result.statusField.name, 'Status');
  const saved = z
    .object({ version: z.literal(2), source: z.object({ repositoryId: z.string().nullable() }) })
    .parse(savedFile(config.directory));
  assert.equal(saved.source.repositoryId, 'R_node');
  const status = statusSchema.parse(await github.execute('github_status', {}));
  assert.notEqual(status.connectionV2?.source.verifiedAt, null);
});

await test('a missing repository node ID still loads, as unverified', async (t) => {
  const config = createProject(createCleanup(t));
  const github = new ProjectGitHub(config, connectRunner('Division4Studios/malt', undefined));
  await github.execute('github_connect', { repository: 'Division4Studios/malt', ...selection });
  const status = statusSchema.parse(await github.execute('github_status', {}));
  const { source, tracker } = requireView(status.connectionV2);
  assert.equal(source.repositoryId, null);
  assert.equal(source.verifiedAt, null);
  assert.equal(tracker.projectNumber, 10);
});

await test('tracker and source sections are validated independently', async (t) => {
  const tracker = {
    provider: 'github-projects',
    owner: 'Division4Studios',
    projectId: project.id,
    projectNumber: 10,
    url: project.url,
    workflowField: statusField,
    capabilities: {},
    savedAt: VERIFIED_AT,
    verifiedAt: VERIFIED_AT,
  };
  const source = {
    provider: 'github',
    repository: 'Division4Studios/malt',
    capabilities: { views: 'unsupported' },
    savedAt: VERIFIED_AT,
  };
  const ok = projectWith(t, { version: 2, tracker, source });
  const status = statusSchema.parse(await ok.github.execute('github_status', {}));
  assert.equal(status.connectionV2?.source.repositoryId, null);
  const badSource = projectWith(t, { version: 2, tracker, source: { ...source, provider: 'gitlab' } });
  await assert.rejects(badSource.github.execute('github_status', {}), /source section is damaged/v);
  const badTracker = projectWith(t, { version: 2, tracker: { ...tracker, projectId: '' }, source });
  await assert.rejects(badTracker.github.execute('github_status', {}), /tracker section is damaged/v);
});

await test('damaged or unknown-version files are rejected, not treated as disconnected', async (t) => {
  await assert.rejects(projectWith(t, { version: 3 }).github.execute('github_status', {}), { code: 'INVALID_INPUT' });
  await assert.rejects(projectWithText(t, '{not json').github.execute('github_status', {}));
});

await test('a repository renamed under the same node ID is not a connection switch', async (t) => {
  const config = createProject(createCleanup(t));
  const original = new ProjectGitHub(config, connectRunner('Division4Studios/malt', 'R_node'));
  await original.execute('github_connect', { repository: 'Division4Studios/malt', ...selection });
  // A pending issue journal makes any connection change a hard error.
  const operations = path.join(config.directory, 'github', 'operations');
  mkdir(operations);
  const request = '00000000-0000-4000-8000-000000000001';
  const input = {
    requestId: request,
    title: 'Pending',
    description: 'Body',
    acceptanceCriteria: ['Done'],
    kind: 'delivery',
  };
  write(path.join(operations, `${request}.json`), JSON.stringify({ fingerprint: 'f', input, phase: 'creating' }));
  const renamed = new ProjectGitHub(config, connectRunner('Division4Studios/malt-renamed', 'R_node'));
  const result = z
    .object({ repository: z.string() })
    .parse(await renamed.execute('github_connect', { repository: 'Division4Studios/malt-renamed', ...selection }));
  assert.equal(result.repository, 'Division4Studios/malt-renamed');
  const other = new ProjectGitHub(config, connectRunner('Division4Studios/other', 'R_other'));
  await assert.rejects(other.execute('github_connect', { repository: 'Division4Studios/other', ...selection }), {
    code: 'GITHUB_OPERATION_PENDING',
  });
});
