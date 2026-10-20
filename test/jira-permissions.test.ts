/** @file Jira capabilities derived from held permissions, and how discovery results are classified. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { projectResult, setupRequired, unsupported } from '../src/jira/discovery-result.ts';
import { JIRA_PERMISSIONS, JIRA_PERMISSION_NAMES, jiraCapabilities } from '../src/jira/permissions.ts';

import type { JiraIssueType, JiraPermission } from '../src/jira/permissions.ts';

/** A story type and a sub-task type. */
const TYPES: JiraIssueType[] = [
  { id: '1', name: 'Story', subtask: false, statuses: [{ id: '10', name: 'To Do' }] },
  { id: '2', name: 'Sub-task', subtask: true, statuses: [{ id: '10', name: 'To Do' }] },
];
/** Fields discovery knows once the project is found. */
const BASE = {
  site: 'https://example.atlassian.net',
  deployment: 'cloud',
  caller: { accountId: 'acc-1', displayName: 'MALT robot' },
  project: { id: '10000', key: 'PROJ', name: 'Project', url: 'https://example.atlassian.net/browse/PROJ' },
} as const;
/** Verification time. */
const NOW = new Date('2026-10-17T12:00:00.000Z');

/**
 * Every checked permission held, with the given ones withheld.
 *
 * @param withheld - Permissions the caller lacks.
 * @returns Held permissions.
 */
function holding(...withheld: JiraPermission[]): Partial<Record<JiraPermission, boolean>> {
  return Object.fromEntries(JIRA_PERMISSION_NAMES.map((name) => [name, !withheld.includes(name)]));
}

await test('capabilities follow the permissions, never assumptions', () => {
  assert.deepEqual(jiraCapabilities(holding(), TYPES), {
    issue_create: 'supported',
    sub_issues: 'supported',
    dependencies: 'supported',
    labels: 'supported',
    milestones: 'unverified',
    views: 'unsupported',
    pull_requests: 'unsupported',
  });
  const none = jiraCapabilities({}, TYPES);
  assert.equal(none.issue_create, 'unsupported');
  assert.equal(none.dependencies, 'unsupported');
  assert.equal(none.labels, 'unsupported');
  assert.equal(
    jiraCapabilities(
      holding(),
      TYPES.filter((type) => !type.subtask),
    ).sub_issues,
    'unsupported',
    'sub-issues need a sub-task type',
  );
  assert.equal(jiraCapabilities(holding('CREATE_ISSUES'), TYPES).sub_issues, 'unsupported');
});

await test('every checked permission names the Jira admin action that grants it', () => {
  for (const name of JIRA_PERMISSION_NAMES) {
    assert.match(JIRA_PERMISSIONS[name], /^Grant /v);
  }
});

await test('a project with every permission is verified at the given time', () => {
  const result = projectResult(BASE, { issueTypes: TYPES, fields: [], held: holding(), problems: [] }, NOW);
  assert.equal(result.state, 'verified');
  assert.equal(result.verifiedAt, NOW.toISOString());
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.problems, []);
});

await test('missing permissions degrade the result and are listed with their admin actions', () => {
  const result = projectResult(
    BASE,
    { issueTypes: TYPES, fields: [], held: holding('CREATE_ISSUES', 'LINK_ISSUES'), problems: [] },
    NOW,
  );
  assert.equal(result.state, 'degraded');
  assert.equal(result.verifiedAt, null);
  assert.deepEqual(
    result.missing.map(({ permission }) => permission),
    ['CREATE_ISSUES', 'LINK_ISSUES'],
  );
  assert.equal(result.missing[0]?.action, JIRA_PERMISSIONS.CREATE_ISSUES);
  assert.deepEqual(
    result.problems.map(({ scope }) => scope),
    ['permissions', 'permissions'],
  );
  assert.equal(result.capabilities.issue_create, 'unsupported');
  const failedRead = projectResult(
    BASE,
    { issueTypes: [], fields: [], held: holding(), problems: [{ scope: 'issue_types', message: 'unreadable' }] },
    NOW,
  );
  assert.equal(failedRead.state, 'degraded', 'a failed read is never verified');
});

await test('a permission Jira did not confirm is missing, so a partial answer is never verified', () => {
  const result = projectResult(
    BASE,
    { issueTypes: TYPES, fields: [], held: { BROWSE_PROJECTS: true }, problems: [] },
    NOW,
  );
  assert.equal(result.state, 'degraded');
  assert.equal(result.verifiedAt, null);
  assert.equal(result.missing.length, JIRA_PERMISSION_NAMES.length - 1);
});

await test('without Browse Projects nothing is readable, so setup is required and capabilities stay unverified', () => {
  const result = projectResult(
    BASE,
    { issueTypes: TYPES, fields: [], held: holding('BROWSE_PROJECTS'), problems: [] },
    NOW,
  );
  assert.equal(result.state, 'external_setup_required');
  assert.equal(result.capabilities.issue_create, 'unverified');
  assert.equal(result.verifiedAt, null);
});

await test('setup problems and self-hosted sites never report capabilities', () => {
  const missing = setupRequired({ site: null, deployment: null }, [{ scope: 'site', message: 'Set a site.' }]);
  assert.equal(missing.state, 'external_setup_required');
  assert.equal(missing.capabilities.issue_create, 'unverified');
  assert.equal(missing.verifiedAt, null);
  const selfHosted = unsupported({ site: 'https://jira.example.com', deployment: 'data-center' });
  assert.equal(selfHosted.state, 'unsupported');
  assert.match(selfHosted.problems[0]?.message ?? '', /Data Center and Server are not supported/v);
});
