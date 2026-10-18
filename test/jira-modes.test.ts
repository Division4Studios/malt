/** @file Jira modes map onto capability policies, read back exactly, and summarise what MALT reads and changes. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CapabilityPolicyStore } from '../src/capability-policy.ts';
import {
  JIRA_CAPABILITIES,
  currentJiraMode,
  jiraAccessSummary,
  jiraModePolicies,
  setJiraMode,
} from '../src/jira/modes.ts';
import { Store } from '../src/store.ts';

import { createCleanup, createProject } from './helpers.ts';

import type { TestContext } from 'node:test';

/** The project operator. */
const OPERATOR = { kind: 'human', id: 'project-operator' } as const;

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

await test('every Jira mutation capability is covered', () => {
  assert.deepEqual(
    [...JIRA_CAPABILITIES].toSorted((left, right) => left.localeCompare(right)),
    ['comment', 'issue-create', 'label-use', 'relationships', 'transition'],
  );
});

await test('modes enable nothing, comments only, or every Jira mutation', () => {
  const readOnly = jiraModePolicies('read-only', ['team-lead']);
  assert.ok(readOnly.values().every((policy) => policy.mode === 'disabled'));
  const comments = jiraModePolicies('comment-only', []);
  assert.deepEqual(
    comments.get('comment'),
    { mode: 'human-only', roles: [] },
    'no roles means the human operator only',
  );
  assert.equal(comments.get('transition')?.mode, 'disabled');
  const full = jiraModePolicies('full', ['team-lead', 'product-owner', 'team-lead']);
  for (const policy of full.values()) {
    assert.deepEqual(policy, { mode: 'approved-agent-roles', roles: ['product-owner', 'team-lead'] });
  }
});

await test('a mode set by the operator reads back, and individual edits read as custom', (t) => {
  const store = policies(t);
  assert.deepEqual(currentJiraMode(store), { mode: 'read-only', roles: [] }, 'everything starts disabled');
  setJiraMode(store, OPERATOR, 'full', ['team-lead']);
  assert.deepEqual(currentJiraMode(store), { mode: 'full', roles: ['team-lead'] });
  setJiraMode(store, OPERATOR, 'comment-only', ['team-lead']);
  assert.deepEqual(currentJiraMode(store), { mode: 'comment-only', roles: ['team-lead'] });
  store.set(OPERATOR, 'transition', { mode: 'human-only', roles: [] });
  assert.equal(currentJiraMode(store).mode, 'custom');
});

await test('only a human may set a mode', (t) => {
  const store = policies(t);
  assert.throws(() => {
    setJiraMode(store, { kind: 'supervisor', role: 'team-lead' }, 'full', ['team-lead']);
  });
  assert.equal(store.get('issue-create').mode, 'disabled');
});

await test('the admin summary lists every read and each write with its current policy', (t) => {
  const store = policies(t);
  setJiraMode(store, OPERATOR, 'comment-only', ['product-owner']);
  const summary = jiraAccessSummary(store);
  assert.ok(summary.reads.some((read) => read.includes('permissions')));
  assert.ok(summary.reads.every((read) => !read.toLowerCase().includes('token')));
  const comment = summary.writes.find((write) => write.capability === 'comment');
  assert.deepEqual(comment?.roles, ['product-owner']);
  assert.equal(comment.mode, 'approved-agent-roles');
  assert.match(comment.change, /pull request links/v);
  assert.equal(summary.writes.find((write) => write.capability === 'issue-create')?.mode, 'disabled');
  assert.equal(summary.writes.length, JIRA_CAPABILITIES.length);
});
