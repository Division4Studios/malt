/**
 * DOM-free tests of the Connections view models (#84, #328, #330). They import
 * the compiled browser modules, so `npm run check` builds web first; a bare
 * `npm test` needs `npm run build:web`.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { connectorRoute } from '../src/web/connector-routes.ts';
import {
  credentialLabel,
  readConnection,
  sectionSave,
  sectionStateLabel,
  sourceProviders,
  trackerProviders,
} from '../web/dist/connection-model.js';
import { discoveryRoute, readDiscovery, sourceSaveInput, trackerSaveInput } from '../web/dist/discovery-model.js';
import {
  jiraDiscoverInput,
  jiraForm,
  jiraFormProblem,
  jiraSaveInput,
  readJiraAccess,
  readJiraDiscovery,
} from '../web/dist/jira-model.js';

/** A fixture value standing in for a credential; it must never reach a model. */
const SECRET = ['fixture', 'credential', 'value'].join('-');

/** A snapshot whose tracker was verified and whose source failed one step. */
const snapshot = {
  local: null,
  github: {
    connected: false,
    credentials: { tracker: 'present', source: 'missing' },
    connectionV2: {
      version: 2,
      tracker: {
        provider: 'github-projects',
        owner: 'example',
        projectId: 'PVT_10',
        projectNumber: 10,
        url: 'https://github.com/users/example/projects/10',
        workflowField: { id: 'F_1', name: 'Status' },
        verification: { state: 'verified', checkedAt: '2026-10-17T00:00:00.000Z', errors: [] },
      },
      source: {
        provider: 'github',
        repository: 'example/app',
        verification: {
          state: 'failed',
          checkedAt: '2026-10-17T00:00:00.000Z',
          errors: [{ step: 'repository', message: 'Grant repository access to the gh session.' }],
        },
      },
    },
  },
};

/** A saved Jira tracker that needs setup outside MALT. */
const jiraSnapshot = {
  local: { base: 'main', remote: 'malt-hub', issues: [{}, {}], pulls: [{}] },
  github: {
    credentials: { tracker: 'missing', source: 'present' },
    connectionV2: {
      version: 2,
      tracker: {
        provider: 'jira',
        owner: 'example',
        projectId: '10000',
        projectNumber: 10_000,
        url: 'https://example.atlassian.net/browse/PROJ',
        credential: { kind: 'env', name: 'JIRA_API_TOKEN' },
        jira: { site: 'https://example.atlassian.net', projectKey: 'PROJ', email: 'robot@example.com' },
        verification: {
          state: 'external',
          checkedAt: '2026-10-18T00:00:00.000Z',
          errors: [{ step: 'credential', message: 'Set the JIRA_API_TOKEN environment variable for this connection.' }],
        },
      },
      source: { provider: 'github', repository: 'example/app', verification: { state: 'saved', checkedAt: null } },
    },
  },
};

/** A discovery result with one open and one closed Project. */
const discovery = {
  verifiedAt: '2026-10-17T00:00:00.000Z',
  login: 'octo',
  repositories: [{ id: 'R_1', nameWithOwner: 'example/app', url: 'https://github.com/example/app' }],
  owner: 'example',
  projects: [
    { id: 'PVT_10', number: 10, title: 'Delivery', url: 'https://github.com/users/example/projects/10', closed: false },
    { id: 'PVT_2', number: 2, title: 'Old', url: 'https://github.com/users/example/projects/2', closed: true },
  ],
  fields: [{ id: 'F_1', name: 'Status', options: [{ id: 'o', name: 'Done' }] }],
  errors: [{ step: 'field', message: 'Grant the project scope.' }],
};

/** A degraded Jira discovery. */
const jiraDiscovery = {
  provider: 'jira',
  state: 'degraded',
  site: 'https://example.atlassian.net',
  caller: { accountId: 'acc-1', displayName: 'MALT robot' },
  project: { id: '10000', key: 'PROJ', name: 'Project', url: 'https://example.atlassian.net/browse/PROJ' },
  issueTypes: [{ id: '1', name: 'Story', subtask: false, statuses: [] }],
  missing: [{ permission: 'LINK_ISSUES', action: 'Grant "Link Issues" to the account.' }],
  problems: [{ scope: 'permissions', message: 'Missing LINK_ISSUES.' }],
};

await test('each section is prefilled separately from the saved connection with its own state and errors', () => {
  const view = readConnection(snapshot);
  assert.equal(view.trackerProvider, 'github-projects');
  assert.equal(view.tracker.state, 'verified');
  assert.equal(view.tracker.selection, 'example · Project 10 · Status');
  assert.equal(view.tracker.url, 'https://github.com/users/example/projects/10');
  assert.equal(view.source.state, 'failed');
  assert.equal(view.source.selection, 'example/app');
  assert.equal(view.source.credential, 'missing');
  assert.equal(view.sourceProvider, 'github');
  assert.deepEqual(view.source.errors, [{ step: 'repository', message: 'Grant repository access to the gh session.' }]);
  assert.notEqual(sectionStateLabel('saved'), sectionStateLabel('verified'), 'saved-but-unverified reads apart');
  assert.notEqual(credentialLabel('missing'), credentialLabel('present'));
  const empty = readConnection({ github: { connected: false, connectionV2: null }, local: null });
  assert.equal(empty.tracker.state, 'none');
  assert.equal(empty.isUnsaved, true);
  assert.equal(empty.tracker.selection, '', 'no placeholder owner, repository or Project 1');
});

await test('a Jira tracker and the local hub are read as their own providers', () => {
  const view = readConnection(jiraSnapshot);
  assert.equal(view.trackerProvider, 'jira');
  assert.equal(view.tracker.state, 'external');
  assert.equal(view.tracker.selection, 'PROJ on https://example.atlassian.net');
  assert.deepEqual(view.jira, {
    site: 'https://example.atlassian.net',
    projectKey: 'PROJ',
    email: 'robot@example.com',
    tokenVariable: 'JIRA_API_TOKEN',
  });
  assert.equal(view.owner, '', 'a Jira site name is never offered as a GitHub owner');
  assert.equal(view.sourceProvider, 'local');
  assert.deepEqual(view.hub, { base: 'main', remote: 'malt-hub', issues: 2, pulls: 1 });
  assert.equal(view.source.state, 'saved');
  assert.deepEqual(
    trackerProviders().map((provider) => provider.id),
    ['github-projects', 'jira'],
  );
  assert.deepEqual(
    sourceProviders().map((provider) => provider.id),
    ['github', 'local'],
  );
});

await test('choices come from discovery; anything else is not saved', () => {
  const choices = readDiscovery(discovery);
  assert.deepEqual(
    choices.projects.map((project) => project.number),
    [10],
    'closed Projects are not offered',
  );
  assert.deepEqual(choices.owners, ['octo', 'example'], 'owners are the login and the repository owners');
  assert.deepEqual(choices.errors, [{ step: 'field', message: 'Grant the project scope.' }]);
  const tracker = trackerSaveInput(choices, 'PVT_10', 'F_1');
  assert.deepEqual(tracker, {
    operation: 'github_section_save',
    input: {
      tracker: {
        owner: 'example',
        projectId: 'PVT_10',
        projectNumber: 10,
        url: 'https://github.com/users/example/projects/10',
        workflowField: { id: 'F_1', name: 'Status' },
      },
    },
  });
  assert.equal(trackerSaveInput(choices, 'PVT_2', 'F_1'), null);
  assert.equal(trackerSaveInput(choices, 'PVT_10', 'F_typed'), null);
  const source = sourceSaveInput(choices, 'R_1');
  assert.deepEqual(source?.input, { source: { repository: 'example/app', repositoryId: 'R_1' } });
  assert.equal(sourceSaveInput(choices, 'R_guess'), null);
  assert.deepEqual(sectionSave(tracker, source)?.input, { ...tracker.input, ...source.input }, 'a first save has both');
  assert.equal(sectionSave(null, null), null);
  assert.equal(
    discoveryRoute('home', { repository: 'example/app', owner: 'example', projectNumber: 10 }),
    '/api/github-discovery?project=home&repository=example%2Fapp&owner=example&projectNumber=10',
  );
  assert.equal(
    discoveryRoute('home', { repository: '', owner: '', projectNumber: 0 }),
    '/api/github-discovery?project=home',
  );
});

await test('a Jira tracker is saved only from what discovery found, never from the typed form', () => {
  const typed = { ...jiraForm(null), site: 'https://example.atlassian.net/', projectKey: 'PROJ', email: 'a@b.co' };
  assert.equal(jiraFormProblem(jiraForm(null)) !== null, true, 'an empty form is not sent');
  assert.match(jiraFormProblem({ ...typed, site: 'https://jira.example.com' }) ?? '', /Jira Cloud site/v);
  assert.match(jiraFormProblem({ ...typed, projectKey: 'proj' }) ?? '', /capitals/v);
  assert.match(jiraFormProblem({ ...typed, tokenVariable: 'token' }) ?? '', /environment variable/v);
  assert.equal(jiraFormProblem(typed), null);
  assert.deepEqual(jiraDiscoverInput(typed), {
    operation: 'jira_discover',
    input: {
      site: 'https://example.atlassian.net',
      projectKey: 'PROJ',
      email: 'a@b.co',
      tokenVariable: 'JIRA_API_TOKEN',
    },
  });
  const findings = readJiraDiscovery(jiraDiscovery);
  assert.equal(findings.state, 'degraded');
  assert.equal(findings.account, 'MALT robot');
  assert.deepEqual(findings.missing, [{ permission: 'LINK_ISSUES', action: 'Grant "Link Issues" to the account.' }]);
  assert.deepEqual(jiraSaveInput({ ...typed, projectKey: 'TYPO' }, findings)?.input, {
    jiraTracker: {
      site: 'https://example.atlassian.net',
      projectKey: 'PROJ',
      projectId: '10000',
      email: 'a@b.co',
      tokenVariable: 'JIRA_API_TOKEN',
    },
  });
  assert.equal(jiraSaveInput(typed, null), null, 'nothing is saved before discovery');
  const notFound = readJiraDiscovery({ state: 'external_setup_required', site: 'https://example.atlassian.net' });
  assert.equal(jiraSaveInput(typed, notFound), null, 'a project Jira did not confirm is not saved');
  assert.equal(readJiraDiscovery({ state: 'connected' }).state, 'external_setup_required', 'unknown states need setup');
});

await test('the Jira admin summary is read from the capability policy view (#330)', () => {
  const access = readJiraAccess({
    capabilities: [],
    jira: {
      mode: 'read-only',
      roles: [],
      reads: ['The site and its deployment type.'],
      writes: [{ capability: 'comment', change: 'Comment progress.', mode: 'disabled', roles: [] }],
    },
  });
  assert.deepEqual(access, {
    mode: 'read-only',
    roles: [],
    reads: ['The site and its deployment type.'],
    writes: [{ capability: 'comment', change: 'Comment progress.', mode: 'disabled' }],
  });
  assert.equal(readJiraAccess({ capabilities: [] }), null);
});

await test('no credential value reaches the models, even if a snapshot or result carried one', () => {
  const tainted = {
    ...snapshot,
    github: { ...snapshot.github, credentials: { tracker: 'present', source: 'present', token: SECRET } },
  };
  assert.ok(!JSON.stringify(readConnection(tainted)).includes(SECRET));
  assert.ok(!JSON.stringify(readDiscovery({ ...discovery, token: SECRET })).includes(SECRET));
  assert.ok(!JSON.stringify(readJiraDiscovery({ ...jiraDiscovery, token: SECRET })).includes(SECRET));
});

/**
 * The next route table, which answers every other path.
 *
 * @returns A marker.
 */
async function fallback(): Promise<unknown> {
  await Promise.resolve();
  return 'fallback';
}

await test('the discovery route forwards a bounded read-only query and rejects repeated fields', async () => {
  const seen: unknown[] = [];
  const gateway = {
    discovery: async (project: string, input: Record<string, unknown>): Promise<unknown> => {
      await Promise.resolve();
      seen.push([project, input]);
      return { ok: true };
    },
  };
  const url = new URL('http://localhost/api/github-discovery?project=home&owner=example&projectNumber=10');
  assert.deepEqual(await connectorRoute(url, gateway, fallback), { ok: true });
  assert.deepEqual(seen, [['home', { owner: 'example', projectNumber: 10 }]]);
  const repeated = new URL('http://localhost/api/github-discovery?project=home&owner=a&owner=b');
  await assert.rejects(connectorRoute(repeated, gateway, fallback), { code: 'INVALID_INPUT' });
  const unrelated = new URL('http://localhost/api/github-discovery?project=home&token=x');
  await assert.rejects(connectorRoute(unrelated, gateway, fallback));
  assert.equal(await connectorRoute(new URL('http://localhost/api/other'), gateway, fallback), 'fallback');
});
