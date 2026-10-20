/**
 * A saved Jira tracker as the factory sees it: the delivery remote chosen
 * for it, the transport built from its environment handle, the intake filter
 * and stage mapping checked against Jira before they are saved, the last
 * intake read in `github_status`, and the fence on switching trackers while
 * deliveries are live. All Jira traffic goes to a fixture site.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { z } from 'zod/v3';

import { savedSections } from '../src/connection-sections.ts';
import { JiraDelivery } from '../src/factory/jira-delivery.ts';
import { deliveryFor } from '../src/factory/local-controls.ts';
import { GitHubDelivery } from '../src/factory/remote.ts';
import { factoryConfigSchema, taskSchema } from '../src/factory/schema.ts';
import { FactoryService } from '../src/factory/service.ts';
import { ProjectGitHub } from '../src/github.ts';
import { writeIntakeRecord } from '../src/jira/workflow.ts';
import { ProjectLearning } from '../src/learning.ts';
import { Store } from '../src/store.ts';

import { OPERATOR, createCleanup, createProject } from './helpers.ts';
import { SITE_TOKEN, STATUS, jiraSite } from './jira-site.ts';

import type { JiraSite } from './jira-site.ts';
import type { MeshConfig } from '../src/config.ts';
import type { GitHubRunner } from '../src/github.ts';
import type { TestContext } from 'node:test';

/** Save time. */
const NOW = '2026-10-20T12:00:00.000Z';
/** A Jira project chosen from discovery. */
const JIRA = {
  site: 'https://example.atlassian.net',
  projectKey: 'PROJ',
  projectId: '10000',
  email: 'robot@example.com',
  tokenVariable: 'JIRA_API_TOKEN',
};
/** A verified section state. */
const VERIFIED = { verifiedAt: NOW, verification: { state: 'verified', checkedAt: NOW, errors: [] } };
/** An environment holding the fixture token. */
const TOKEN_SET: NodeJS.ProcessEnv = { JIRA_API_TOKEN: SITE_TOKEN };
/** Factory settings for GitHub source control. */
const GITHUB_SETTINGS = factoryConfigSchema.parse({
  testCommands: [{ file: process.execPath }],
  endToEndCommands: [{ file: process.execPath }],
});

/** A workspace with a saved connection and a fixture Jira site. */
interface Fixture {
  readonly config: MeshConfig;
  readonly github: ProjectGitHub;
  readonly site: JiraSite;
  /** GitHub CLI calls. */
  readonly calls: string[][];
  /** Registers cleanup that runs before the project folder is removed. */
  readonly defer: (cleanup: () => unknown) => void;
}

/**
 * Save a connection file whose tracker is Jira, verified unless told otherwise.
 *
 * @param config - Workspace.
 * @param isVerified - Whether the tracker is verified.
 */
function saveJiraConnection(config: MeshConfig, isVerified = true): void {
  const record = savedSections(
    null,
    { jiraTracker: JIRA, source: { repository: 'example/app', repositoryId: 'R_1' } },
    NOW,
  );
  const tracker = isVerified ? { ...record.tracker, ...VERIFIED } : record.tracker;
  const directory = path.join(config.directory, 'github');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- This test's own temporary project.
  mkdirSync(directory, { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- This test's own temporary project.
  writeFileSync(
    path.join(directory, 'connection.json'),
    JSON.stringify({ version: 2, tracker, source: { ...record.source, ...VERIFIED } }),
  );
}

/**
 * The saved connection file.
 *
 * @param config - Workspace.
 * @returns Parsed JSON.
 */
function savedFile(config: MeshConfig): string {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- This test's own temporary project.
  return readFileSync(path.join(config.directory, 'github', 'connection.json'), 'utf8');
}

/**
 * Build a workspace whose GitHub runner records calls and whose Jira is a fixture.
 *
 * @param t - Owns cleanup.
 * @param environment - The supervisor's environment.
 * @returns Fixture.
 */
function build(t: TestContext, environment: NodeJS.ProcessEnv = TOKEN_SET): Fixture {
  const defer = createCleanup(t);
  const config = createProject(defer);
  const site = jiraSite();
  const calls: string[][] = [];
  const runner: GitHubRunner = async (args) => {
    calls.push([...args]);
    await Promise.resolve();
    return {};
  };
  const github = new ProjectGitHub(
    config,
    runner,
    {
      authorize: () => {
        /* Capability decisions are covered by the factory tests. */
      },
      grantConnectionDefaults: () => {
        /* Not exercised. */
      },
    },
    { ghAuthenticated: null, environment, jiraFetch: site.fetch },
  );
  return { config, github, site, calls, defer };
}

await test('a saved Jira tracker selects the Jira remote over GitHub or the local hub', (t) => {
  const fixture = build(t);
  assert.ok(deliveryFor(fixture.config, GITHUB_SETTINGS, fixture.github) instanceof GitHubDelivery);
  saveJiraConnection(fixture.config);
  assert.ok(deliveryFor(fixture.config, GITHUB_SETTINGS, fixture.github) instanceof JiraDelivery);
  const local = factoryConfigSchema.parse({ ...GITHUB_SETTINGS, delivery: 'local' });
  assert.ok(deliveryFor(fixture.config, local, fixture.github) instanceof JiraDelivery);
});

await test('the Jira transport comes from the saved tracker and its environment handle only', (t) => {
  const fixture = build(t);
  saveJiraConnection(fixture.config, false);
  assert.throws(() => fixture.github.jiraTracker(), { code: 'GITHUB_NOT_CONNECTED', message: /not verified/v });
  saveJiraConnection(fixture.config);
  const access = fixture.github.jiraTracker();
  assert.equal(access.transport.site.origin, JIRA.site);
  assert.equal(access.transport.credential.email, JIRA.email);
  assert.equal(access.tracker.projectKey, 'PROJ');
  const unset = build(t, {});
  saveJiraConnection(unset.config);
  assert.throws(() => unset.github.jiraTracker(), { code: 'CREDENTIALS_MISSING', message: /JIRA_API_TOKEN/v });
});

await test('GitHub source control works under a Jira tracker without reading a GitHub Project', async (t) => {
  const fixture = build(t);
  saveJiraConnection(fixture.config);
  const delivery = new GitHubDelivery(fixture.config, fixture.github, async (args) => {
    fixture.calls.push([...args]);
    await Promise.resolve();
    return {};
  });
  await delivery.verifySource('git@github.com:example/app.git');
  await delivery.disarm(7);
  assert.deepEqual(fixture.calls, [['pr', 'merge', '7', '--repo', 'example/app', '--disable-auto']]);
});

await test('the intake filter is run against Jira before it is saved, with a preview of what it would file', async (t) => {
  const fixture = build(t);
  saveJiraConnection(fixture.config);
  const before = savedFile(fixture.config);
  await assert.rejects(fixture.github.execute(OPERATOR, 'jira_workflow_save', { jql: 'project = NOPE' }), {
    code: 'INVALID_INPUT',
    message: /Error in the JQL Query: project = NOPE/v,
  });
  assert.equal(savedFile(fixture.config), before, 'a filter Jira rejects is never saved');
  const wanted = fixture.site.add({ summary: 'Export reports' });
  const done = fixture.site.add({ status: STATUS.done });
  fixture.site.intake = { jql: 'project = PROJ', ids: [wanted.id, done.id] };
  const tracker = z.object({ jira: z.unknown(), verification: z.unknown() });
  const result = z
    .object({ connectionV2: z.object({ tracker }), intakePreview: z.unknown() })
    .parse(await fixture.github.execute(OPERATOR, 'jira_workflow_save', { jql: ' project = PROJ ' }));
  assert.deepEqual(result.intakePreview, {
    queue: [wanted.key],
    skipped: [{ key: done.key, reason: 'done' }],
    isTruncated: false,
  });
  assert.deepEqual(result.connectionV2.tracker.jira, {
    site: JIRA.site,
    projectKey: 'PROJ',
    email: JIRA.email,
    workflow: { intake: { jql: 'project = PROJ' } },
  });
  assert.deepEqual(result.connectionV2.tracker.verification, VERIFIED.verification, 'verification is kept');
  assert.deepEqual(fixture.site.writes(), [], 'checking a filter changes nothing in Jira');
  assert.equal(savedFile(fixture.config).includes(SITE_TOKEN), false);
});

await test('stage mappings must name statuses of the project; a re-save of the same project keeps them', async (t) => {
  const fixture = build(t);
  saveJiraConnection(fixture.config);
  await assert.rejects(
    fixture.github.execute(OPERATOR, 'jira_workflow_save', {
      stages: { Development: { statusId: '999', statusName: 'Gone' } },
    }),
    { code: 'INVALID_INPUT', message: /"Development" is mapped to "Gone", which no workflow in this project has/v },
  );
  await assert.rejects(
    fixture.github.execute(OPERATOR, 'jira_workflow_save', {
      stages: { Coding: { statusId: STATUS.progress, statusName: 'In Progress' } },
    }),
    { code: 'INVALID_INPUT', message: /Map only MALT delivery stages/v },
  );
  const stages = { Development: { statusId: STATUS.progress, statusName: 'In Progress' } };
  await fixture.github.execute(OPERATOR, 'jira_workflow_save', { stages });
  await fixture.github.execute(OPERATOR, 'github_section_save', { jiraTracker: JIRA });
  assert.match(savedFile(fixture.config), /"In Progress"/v, 'saving the same project again keeps the mapping');
  await fixture.github.execute(OPERATOR, 'github_section_save', { jiraTracker: { ...JIRA, projectKey: 'OTHER' } });
  assert.doesNotMatch(savedFile(fixture.config), /"In Progress"/v, 'another project starts without one');
});

await test('github_status reports the last intake read of a Jira tracker', async (t) => {
  const fixture = build(t);
  saveJiraConnection(fixture.config);
  const status = z.object({ jiraIntake: z.unknown() });
  assert.equal(status.parse(await fixture.github.execute(OPERATOR, 'github_status', {})).jiraIntake, null);
  const record = {
    checkedAt: NOW,
    offered: ['PROJ-1'],
    skipped: [{ key: 'PROJ-2', reason: 'done' as const }],
    isTruncated: false,
    retryAfterSeconds: null,
    error: null,
  };
  writeIntakeRecord(fixture.config.directory, record);
  assert.deepEqual(status.parse(await fixture.github.execute(OPERATOR, 'github_status', {})).jiraIntake, record);
});

await test('the tracker cannot switch to Jira while a GitHub delivery is live', async (t) => {
  const fixture = build(t);
  const store = new Store(fixture.config);
  const factory = new FactoryService(
    fixture.config,
    store,
    { github: fixture.github, learning: new ProjectLearning(fixture.config) },
    { home: fixture.config.root },
  );
  fixture.defer(async () => {
    await factory.close();
    store.close();
  });
  await fixture.github.execute(OPERATOR, 'github_section_save', {
    tracker: {
      owner: 'example',
      projectId: 'PVT_1',
      projectNumber: 3,
      url: 'https://github.com/orgs/example/projects/3',
      workflowField: { id: 'F_1', name: 'MALT Status' },
    },
    source: { repository: 'example/app', repositoryId: 'R_1' },
  });
  const task = taskSchema.parse({
    id: randomUUID(),
    featureId: null,
    issue: 10_001,
    parentIssue: 1,
    key: 'issue-10001',
    title: 'Live GitHub delivery',
    description: 'Still in development.',
    acceptanceCriteria: ['It ships.'],
    dependencies: [],
    phase: 'development',
    developer: null,
    branch: null,
    worktree: null,
    head: null,
    base: null,
    pr: null,
    prUrl: null,
    merge: null,
    reviews: [],
    feedback: [],
    attempts: 0,
    version: 0,
    error: null,
    updatedAt: 0,
  });
  factory.repository.addTask(task);
  await assert.rejects(fixture.github.execute(OPERATOR, 'github_section_save', { jiraTracker: JIRA }), {
    code: 'FACTORY_GATED',
    message: /cannot change from github-projects:example to jira:https:\/\/example\.atlassian\.net:PROJ/v,
  });
  assert.match(savedFile(fixture.config), /"github-projects"/v, 'the GitHub tracker is kept');
  factory.repository.editTask(task.id, (current) => ({ ...current, phase: 'done' }));
  for (const effect of factory.repository.effects()) {
    factory.repository.settleEffect(effect, null);
  }
  await fixture.github.execute(OPERATOR, 'github_section_save', { jiraTracker: JIRA });
  assert.match(savedFile(fixture.config), /"jira"/v, 'with nothing live, the switch is allowed');
});
