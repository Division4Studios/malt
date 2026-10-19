/** @file Per-section connection verification: each state, renames by node ID, no field creation, and connected only when both sections verify. */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { z } from 'zod/v3';

import { isConnected, sectionStates, verifyConnection } from '../src/connection-verify.ts';
import { connectionV2Schema, unverifiedCapabilities } from '../src/connector.ts';
import { DELIVERY_STATUSES } from '../src/github.ts';

import { OPERATOR, createCleanup, createProject, mechanicsGitHub } from './helpers.ts';

import type { ConnectionV2 } from '../src/connector.ts';
import type { GitHubRunner } from '../src/github.ts';

/** Fixed verification time. */
const NOW = '2026-10-17T12:00:00.000Z';
/** Options the saved Status field carries. */
const OPTIONS = DELIVERY_STATUSES.map((name, index) => ({ id: `o${String(index)}`, name }));

/** Remote state the fixture serves. */
interface Remote {
  /** Repository name GitHub reports now. */
  readonly repositoryName?: string;
  /** Repository node ID GitHub reports now. */
  readonly repositoryId?: string;
  /** Project ID at number 4, or null when deleted. */
  readonly projectId?: string | null;
  /** Whether the account can update the Project. */
  readonly canUpdate?: boolean;
  /** Status field options now; null when the field was removed. */
  readonly options?: readonly { readonly id: string; readonly name: string }[] | null;
}

/** GraphQL request body. */
const requestSchema = z.object({ query: z.string() });

/**
 * A runner serving read-only discovery from a remote description.
 *
 * @param remote - Remote state.
 * @returns Runner and every non-query call it saw.
 */
function fixture(remote: Remote = {}): { run: GitHubRunner; writes: unknown[] } {
  const writes: unknown[] = [];
  const repository = {
    id: remote.repositoryId ?? 'R_1',
    nameWithOwner: remote.repositoryName ?? 'example/app',
    url: 'https://github.com/example/app',
    viewerPermission: 'WRITE',
    hasIssuesEnabled: true,
  };
  const projectId = remote.projectId === undefined ? 'PVT_4' : remote.projectId;
  const project = { id: projectId, number: 4, title: 'Delivery', url: 'https://github.com/orgs/example/projects/4' };
  const projects = projectId === null ? [] : [{ ...project, closed: false, viewerCanUpdate: remote.canUpdate ?? true }];
  const field = remote.options === null ? {} : { id: 'F_1', name: 'MALT Status', options: remote.options ?? OPTIONS };
  const run: GitHubRunner = async (args, input) => {
    const { query } = requestSchema.parse(input);
    if (args[1] !== 'graphql' || !query.startsWith('query')) {
      writes.push(args);
    }
    let data: unknown = { node: { totalCount: 0 } };
    if (query.includes('viewer { login }')) {
      data = { viewer: { login: 'octo' } };
    } else if (query.includes('viewer { repositories')) {
      data = { viewer: { repositories: { nodes: [repository] } } };
    } else if (query.includes('repository(owner:') || query.includes('... on Repository { id')) {
      data = { repository, node: repository };
    } else if (query.includes('repositoryOwner(')) {
      data = { repositoryOwner: { projectsV2: { nodes: projects } } };
    } else if (query.includes('fields(first')) {
      data = { node: { fields: { nodes: [field] } } };
    }
    return await delay(0, { data });
  };
  return { run, writes };
}

/**
 * A saved connection for the fixture's repository and Project.
 *
 * @param provider - Tracker provider.
 * @returns Validated record.
 */
function saved(provider: 'github-projects' | 'jira' = 'github-projects'): ConnectionV2 {
  const capabilities = unverifiedCapabilities();
  return connectionV2Schema.parse({
    version: 2,
    tracker: {
      provider,
      owner: 'example',
      projectId: 'PVT_4',
      projectNumber: 4,
      url: 'https://github.com/orgs/example/projects/4',
      workflowField: { id: 'F_1', name: 'MALT Status', options: OPTIONS },
      capabilities,
      savedAt: NOW,
      verification: { state: 'saved', checkedAt: null },
    },
    source: {
      provider: 'github',
      repository: 'example/app',
      repositoryId: 'R_1',
      capabilities,
      savedAt: NOW,
      verification: { state: 'saved', checkedAt: null },
    },
  });
}

await test('saved sections are not connected until both verify', async () => {
  const record = saved();
  assert.deepEqual(sectionStates(record), { tracker: 'saved', source: 'saved' });
  assert.equal(isConnected(record), false);
  const { run, writes } = fixture();
  const verified = await verifyConnection(run, record, DELIVERY_STATUSES, () => NOW);
  assert.deepEqual(sectionStates(verified), { tracker: 'verified', source: 'verified' });
  assert.equal(isConnected(verified), true);
  assert.equal(verified.source.verifiedAt, NOW);
  assert.deepEqual(writes, [], 'verification only reads');
});

await test('a renamed repository verifies by node ID and keeps its old name as an alias', async () => {
  const { run } = fixture({ repositoryName: 'example/renamed' });
  const verified = await verifyConnection(run, saved(), DELIVERY_STATUSES, () => NOW);
  assert.equal(verified.source.verification?.state, 'verified');
  assert.equal(verified.source.repository, 'example/renamed');
  assert.deepEqual(verified.source.repositoryAliases, ['example/app']);
});

await test('a different repository, a deleted Project or a removed field fail without creating anything', async () => {
  const swapped = await verifyConnection(fixture({ repositoryId: 'R_2' }).run, saved(), DELIVERY_STATUSES, () => NOW);
  assert.equal(swapped.source.verification?.state, 'failed');
  const deleted = await verifyConnection(fixture({ projectId: null }).run, saved(), DELIVERY_STATUSES, () => NOW);
  assert.equal(deleted.tracker.verification?.state, 'failed');
  assert.equal(deleted.tracker.verification.errors[0]?.step, 'project');
  const removed = fixture({ options: null });
  const unfielded = await verifyConnection(removed.run, saved(), DELIVERY_STATUSES, () => NOW);
  assert.equal(unfielded.tracker.verification?.state, 'failed');
  assert.match(unfielded.tracker.verification.errors[0]?.message ?? '', /never creates fields/v);
  assert.deepEqual(removed.writes, []);
  for (const record of [swapped, deleted, unfielded]) {
    assert.equal(isConnected(record), false);
  }
});

await test('a reachable but unusable tracker is degraded and not connected', async () => {
  const partial = await verifyConnection(
    fixture({ options: OPTIONS.slice(0, 2) }).run,
    saved(),
    DELIVERY_STATUSES,
    () => NOW,
  );
  assert.equal(partial.tracker.verification?.state, 'degraded');
  assert.equal(partial.tracker.workflowField.id, 'F_1', 'the selected field is kept');
  assert.equal(isConnected(partial), false);
  const readOnly = await verifyConnection(fixture({ canUpdate: false }).run, saved(), DELIVERY_STATUSES, () => NOW);
  assert.equal(readOnly.tracker.verification?.state, 'degraded');
});

await test('a Jira tracker needs external setup and is never connected', async () => {
  const verified = await verifyConnection(fixture().run, saved('jira'), DELIVERY_STATUSES, () => NOW);
  assert.equal(verified.tracker.verification?.state, 'external');
  assert.match(verified.tracker.verification.errors[0]?.message ?? '', /External setup required/v);
  assert.equal(verified.source.verification?.state, 'verified');
  assert.equal(isConnected(verified), false);
});

await test('github_verify records each section and status reports connected only when both verify', async (t) => {
  const config = createProject(createCleanup(t));
  const directory = path.join(config.directory, 'github');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- The fixture project's own private integration directory.
  mkdirSync(directory, { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- The fixture project's own private connection record.
  writeFileSync(path.join(directory, 'connection.json'), JSON.stringify(saved()));
  const status = z.object({ connected: z.boolean(), verification: z.record(z.string(), z.string()) });
  const pending = mechanicsGitHub(config, fixture().run);
  assert.equal(status.parse(await pending.execute(OPERATOR, 'github_status', {})).connected, false);
  const after = status.parse(await pending.execute(OPERATOR, 'github_verify', {}));
  assert.deepEqual(after, { ...after, connected: true, verification: { tracker: 'verified', source: 'verified' } });
  const degraded = mechanicsGitHub(config, fixture({ canUpdate: false }).run);
  assert.equal(status.parse(await degraded.execute(OPERATOR, 'github_verify', {})).connected, false);
});
