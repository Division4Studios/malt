/** @file Read-only GitHub discovery: fixture runs prove no mutation, step-scoped token-free errors and stable identifiers. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { z } from 'zod/v3';

import { discoverGitHub } from '../src/github-discovery.ts';
import { MeshError } from '../src/protocol.ts';

import { OPERATOR, createCleanup, createProject, mechanicsGitHub } from './helpers.ts';

import type { GitHubRunner } from '../src/github.ts';

/** A token-shaped value the fixture leaks into every failure. */
const TOKEN = ['ghp', 'fixture', 'redaction', 'probe'].join('_');
/** Fixed verification time. */
const VERIFIED = '2026-10-17T12:00:00.000Z';

/** Fixture behaviour switches. */
interface Behaviour {
  /** The gh session is not authenticated. */
  readonly isLoggedOut?: boolean;
  /** The session lacks the repo scope for listing. */
  readonly lacksRepoScope?: boolean;
  /** The selected repository is unreadable. */
  readonly hidesRepository?: boolean;
  /** The selected Project was deleted. */
  readonly deletesProject?: boolean;
  /** Reading Project views fails with this GraphQL error. */
  readonly viewsError?: { readonly type?: string; readonly message: string };
  /** The Project and its Status field are beyond the first listed page. */
  readonly isPaged?: boolean;
  /** Fields of the selected repository that differ from the default fixture. */
  readonly repository?: { readonly viewerPermission?: string; readonly isArchived?: boolean };
}

/** GraphQL request body. */
const requestSchema = z.object({ query: z.string(), variables: z.record(z.string(), z.unknown()) });

/** The repository the fixture serves. */
const repository = {
  id: 'R_1',
  nameWithOwner: 'example/app',
  url: 'https://github.com/example/app',
  viewerPermission: 'WRITE',
  hasIssuesEnabled: true,
};
/** The Project the fixture serves. */
const project = {
  id: 'PVT_4',
  number: 4,
  title: 'Delivery',
  url: 'https://github.com/orgs/example/projects/4',
  closed: false,
  viewerCanUpdate: true,
};

/** Error text a careless adapter could leak. */
const LEAKED = `Authorization: bearer ${TOKEN}`;

/**
 * Answer account and repository queries.
 *
 * @param query - GraphQL document.
 * @param variables - Its variables.
 * @param behaviour - Fixture switches.
 * @returns Remote-shaped response, or undefined for other queries.
 * @throws {MeshError} When the fixture session is logged out.
 */
function answerRepository(query: string, variables: Record<string, unknown>, behaviour: Behaviour): unknown {
  if (query.includes('viewer { login }')) {
    if (behaviour.isLoggedOut === true) {
      throw new MeshError('GITHUB_UNAVAILABLE', `gh: token ${TOKEN} is invalid`);
    }
    return { data: { viewer: { login: 'octo' } } };
  }
  if (query.includes('viewer { repositories')) {
    return behaviour.lacksRepoScope === true
      ? { errors: [{ type: 'INSUFFICIENT_SCOPES', message: LEAKED }] }
      : { data: { viewer: { repositories: { nodes: [repository] } } } };
  }
  if (query.includes('repository(owner: $owner')) {
    return {
      data: { repository: behaviour.hidesRepository === true ? null : { ...repository, ...behaviour.repository } },
    };
  }
  if (query.includes('... on Repository { id nameWithOwner')) {
    return { data: { node: variables['id'] === 'R_1' ? { ...repository, nameWithOwner: 'example/renamed' } : null } };
  }
  return undefined;
}

/**
 * Answer Project, field and view queries.
 *
 * @param query - GraphQL document.
 * @param behaviour - Fixture switches.
 * @returns Remote-shaped response; any other query is a readable capability probe.
 */
function answerProject(query: string, behaviour: Behaviour): unknown {
  const status = { id: 'F_1', name: 'Status', options: [{ id: 'o1', name: 'Backlog' }] };
  const isListed = behaviour.deletesProject !== true && behaviour.isPaged !== true;
  if (query.includes('projectV2(number')) {
    return { data: { repositoryOwner: { projectV2: behaviour.deletesProject === true ? null : project } } };
  }
  if (query.includes('repositoryOwner(')) {
    return { data: { repositoryOwner: { projectsV2: { nodes: isListed ? [project] : [] } } } };
  }
  if (query.includes('fields(first')) {
    return { data: { node: { fields: { nodes: behaviour.isPaged === true ? [{}] : [status, {}] } } } };
  }
  if (query.includes('... on ProjectV2SingleSelectField') && !query.includes('fields(')) {
    return { data: { node: status } };
  }
  if (query.includes('views(first')) {
    return behaviour.viewsError === undefined
      ? { data: { node: { views: { totalCount: 2 } } } }
      : { errors: [{ ...behaviour.viewsError, extra: LEAKED }] };
  }
  return { data: { node: { totalCount: 0 } } };
}

/**
 * Answer one read-only query.
 *
 * @param query - GraphQL document.
 * @param variables - Its variables.
 * @param behaviour - Fixture switches.
 * @returns Remote-shaped response.
 */
function answer(query: string, variables: Record<string, unknown>, behaviour: Behaviour): unknown {
  return answerRepository(query, variables, behaviour) ?? answerProject(query, behaviour);
}

/**
 * A fixture runner that records every call and refuses anything but a GraphQL query.
 *
 * @param behaviour - Fixture switches.
 * @returns Runner and the recorded requests.
 */
function fixture(behaviour: Behaviour = {}): { run: GitHubRunner; queries: string[] } {
  const queries: string[] = [];
  const run: GitHubRunner = async (args, input) => {
    assert.deepEqual(args, ['api', 'graphql', '--input', '-'], 'discovery only issues GraphQL reads');
    const request = requestSchema.parse(input);
    queries.push(request.query);
    return await delay(0, answer(request.query, request.variables, behaviour));
  };
  return { run, queries };
}

/**
 * Assert that a run issued only queries and leaked no token.
 *
 * @param queries - Recorded documents.
 * @param result - Discovery result.
 */
function assertReadOnlyAndClean(queries: readonly string[], result: unknown): void {
  assert.ok(queries.length > 0);
  for (const query of queries) {
    assert.match(query, /^query/v);
    assert.doesNotMatch(query, /\bmutation\b/v);
  }
  const text = JSON.stringify(result);
  assert.equal(text.includes(TOKEN), false);
  assert.equal(text.toLowerCase().includes('authorization'), false);
}

await test('discovery returns the login, repositories, Projects, fields and probed capabilities with stable IDs', async () => {
  const { run, queries } = fixture();
  const result = await discoverGitHub(run, { repository: 'example/app', projectNumber: 4 }, () => VERIFIED);
  assertReadOnlyAndClean(queries, result);
  assert.equal(result.verifiedAt, VERIFIED);
  assert.equal(result.login, 'octo');
  assert.deepEqual(result.repositories, [repository]);
  assert.deepEqual(result.repository, repository);
  assert.equal(result.owner, 'example');
  assert.deepEqual(result.project, project);
  assert.deepEqual(result.fields, [{ id: 'F_1', name: 'Status', options: [{ id: 'o1', name: 'Backlog' }] }]);
  assert.deepEqual(result.capabilities, {
    issue_create: 'supported',
    sub_issues: 'supported',
    dependencies: 'supported',
    labels: 'supported',
    milestones: 'supported',
    views: 'supported',
    pull_requests: 'supported',
  });
  assert.deepEqual(result.errors, []);
});

await test('a failed login stops at the auth step without echoing the token', async () => {
  const { run, queries } = fixture({ isLoggedOut: true });
  const result = await discoverGitHub(run, { repository: 'example/app' }, () => VERIFIED);
  assertReadOnlyAndClean(queries, result);
  assert.deepEqual(
    result.errors.map((error) => error.step),
    ['auth'],
  );
  assert.equal(result.login, null);
  assert.equal(queries.length, 1);
});

await test('a missing repo scope and an unreadable repository are separate repository-step failures', async () => {
  const scoped = fixture({ lacksRepoScope: true });
  const listing = await discoverGitHub(scoped.run, {}, () => VERIFIED);
  assertReadOnlyAndClean(scoped.queries, listing);
  assert.deepEqual(
    listing.errors.map((error) => error.step),
    ['repository'],
  );
  assert.equal(listing.owner, 'octo', 'without a repository, the viewer owns the listed Projects');
  const hidden = fixture({ hidesRepository: true });
  const selection = await discoverGitHub(hidden.run, { repository: 'example/app' }, () => VERIFIED);
  assertReadOnlyAndClean(hidden.queries, selection);
  assert.equal(selection.repository, null);
  assert.match(selection.errors.at(0)?.message ?? '', /not found or this account cannot read it/v);
  assert.equal(selection.capabilities.issue_create, 'unverified');
});

await test('a deleted Project fails the project step and leaves its fields and views unverified', async () => {
  const { run, queries } = fixture({ deletesProject: true });
  const result = await discoverGitHub(run, { repository: 'example/app', projectNumber: 4 }, () => VERIFIED);
  assertReadOnlyAndClean(queries, result);
  assert.deepEqual(
    result.errors.map((error) => error.step),
    ['project'],
  );
  assert.deepEqual(result.fields, []);
  assert.equal(result.capabilities.views, 'unverified');
});

await test('a renamed repository resolves by its node ID', async () => {
  const { run, queries } = fixture();
  const result = await discoverGitHub(run, { repositoryId: 'R_1', projectNumber: 4 }, () => VERIFIED);
  assertReadOnlyAndClean(queries, result);
  assert.ok(result.repository !== null);
  assert.equal(result.repository.nameWithOwner, 'example/renamed');
  assert.equal(result.repository.id, 'R_1');
});

await test('views that cannot be read are unverified, and a schema without views is unsupported', async () => {
  const forbidden = fixture({ viewsError: { type: 'FORBIDDEN', message: 'Resource not accessible' } });
  const denied = await discoverGitHub(forbidden.run, { repository: 'example/app', projectNumber: 4 }, () => VERIFIED);
  assertReadOnlyAndClean(forbidden.queries, denied);
  assert.equal(denied.capabilities.views, 'unverified');
  const missing = fixture({ viewsError: { message: "Field 'views' doesn't exist on type 'ProjectV2'" } });
  const absent = await discoverGitHub(missing.run, { repository: 'example/app', projectNumber: 4 }, () => VERIFIED);
  assert.equal(absent.capabilities.views, 'unsupported');
});

await test('github_discover runs through the project integration and saves nothing', async (t) => {
  const config = createProject(createCleanup(t));
  const { run, queries } = fixture();
  const github = mechanicsGitHub(config, run);
  const result = z
    .object({ login: z.string(), errors: z.array(z.unknown()) })
    .parse(await github.execute(OPERATOR, 'github_discover', { repository: 'example/app', projectNumber: 4 }));
  assert.equal(result.login, 'octo');
  assert.deepEqual(result.errors, []);
  assertReadOnlyAndClean(queries, result);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- The fixture project's own private connection path.
  assert.equal(existsSync(path.join(config.directory, 'github', 'connection.json')), false);
  await assert.rejects(github.execute(OPERATOR, 'github_discover', { repository: 'not a repository' }), {
    code: 'INVALID_INPUT',
  });
});

await test('a Project and saved Status field beyond the first page are still found', async () => {
  const { run, queries } = fixture({ isPaged: true });
  const result = await discoverGitHub(run, { repository: 'example/app', projectNumber: 4, fieldIds: ['F_1'] });
  assert.equal(result.project?.id, 'PVT_4', 'read by number when the listed page lacks it');
  assert.deepEqual(
    result.fields.map((field) => field.id),
    ['F_1'],
    'the saved field is read by ID',
  );
  assert.deepEqual(result.errors, []);
  assertReadOnlyAndClean(queries, result);
});

await test('read access may open issues; an archived repository supports no change', async () => {
  const reader = await discoverGitHub(fixture({ repository: { viewerPermission: 'READ' } }).run, {
    repository: 'example/app',
  });
  assert.equal(reader.capabilities.issue_create, 'supported');
  assert.equal(reader.capabilities.labels, 'unsupported');
  const archived = await discoverGitHub(fixture({ repository: { isArchived: true } }).run, {
    repository: 'example/app',
  });
  assert.equal(archived.capabilities.issue_create, 'unsupported');
  assert.equal(archived.capabilities.labels, 'unsupported');
  assert.equal(archived.capabilities.pull_requests, 'unsupported');
});
