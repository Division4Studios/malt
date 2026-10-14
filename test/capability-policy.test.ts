/**
 * Durable capability policy behavior at the store boundary.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { CAPABILITIES, CapabilityPolicyStore } from '../src/capability-policy.ts';
import { Store } from '../src/store.ts';

import { createCleanup, createProject } from './helpers.ts';

/** Authenticated operator supplied by the future transport boundary. */
const human = { kind: 'human', id: 'operator' };

await test('fresh defaults, human-only edits, validation and immutable history survive restart', (t) => {
  const defer = createCleanup(t);
  const config = createProject(defer);
  let store = new Store(config);
  defer(() => {
    store.close();
  });
  const policies = new CapabilityPolicyStore(store, config);
  for (const capability of CAPABILITIES) {
    assert.deepEqual(policies.get(capability), { mode: 'disabled', roles: [] });
  }
  assert.deepEqual(policies.history(), []);
  for (const principal of [
    { kind: 'agent', id: 'operator', role: 'team-lead' },
    { kind: 'supervisor', id: 'operator' },
    {},
    null,
  ]) {
    assert.throws(() => {
      policies.set(principal, 'issue-create', { mode: 'human-only', roles: [] });
    });
  }
  for (const policy of [
    { mode: 'approved-agent-roles', roles: ['unknown'] },
    { mode: 'approved-agent-roles', roles: [] },
    { mode: 'disabled', roles: ['team-lead'] },
    { mode: 'human-only', roles: ['team-lead'] },
  ]) {
    assert.throws(() => {
      policies.set(human, 'issue-create', policy);
    });
  }
  assert.throws(() => policies.get('unknown'));
  assert.throws(() => {
    policies.set(human, 'unknown', { mode: 'disabled', roles: [] });
  });
  assert.deepEqual(policies.history(), []);
  policies.set(human, 'issue-create', { mode: 'approved-agent-roles', roles: ['team-lead'] });
  policies.set(human, 'issue-create', { mode: 'human-only', roles: [] });
  const history = policies.history();
  assert.equal(history.length, 2);
  assert.deepEqual(history[0]?.previous, { mode: 'disabled', roles: [] });
  assert.deepEqual(history[1]?.previous, history[0].next);
  assert.deepEqual(history[1].actor, human);
  assert.equal(history[1].kind, 'human');
  assert.ok(history.every((entry) => Number.isFinite(Date.parse(entry.time))));
  store.close();
  store = new Store(config);
  const reopened = new CapabilityPolicyStore(store, config);
  assert.deepEqual(reopened.get('issue-create'), { mode: 'human-only', roles: [] });
  assert.deepEqual(reopened.history(), history);
  assert.throws(() => {
    store.db.exec('DELETE FROM capability_policy_history');
  }, /immutable/v);
  assert.throws(() => {
    store.db.exec("UPDATE capability_policy_history SET next = '{}'");
  }, /immutable/v);
});

await test('existing connection migration is idempotent, isolated, and never reapplied after human revocation', (t) => {
  const defer = createCleanup(t);
  const config = createProject(defer);
  const other = createProject(defer);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Isolated temporary test project.
  mkdirSync(path.join(config.directory, 'github'), { recursive: true });
  const now = new Date();
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Isolated temporary test fixture.
  writeFileSync(
    path.join(config.directory, 'github', 'connection.json'),
    JSON.stringify({
      version: 1,
      repository: 'example/app',
      owner: 'example',
      project: { id: 'P_10', number: 10, url: 'https://github.com/users/example/projects/10' },
      statusField: { id: 'status', name: 'Status', options: [] },
      verifiedAt: now.toISOString(),
    }),
  );
  const store = new Store(config);
  const otherStore = new Store(other);
  defer(() => {
    store.close();
    otherStore.close();
  });
  const policies = new CapabilityPolicyStore(store, config);
  const isolated = new CapabilityPolicyStore(otherStore, other);
  assert.throws(() => new CapabilityPolicyStore(store, other), /project/iv);
  const migrated = new Set(['issue-create', 'relationships', 'membership', 'transition']);
  for (const capability of CAPABILITIES) {
    assert.deepEqual(
      policies.get(capability),
      migrated.has(capability)
        ? { mode: 'approved-agent-roles', roles: ['team-lead'] }
        : { mode: 'disabled', roles: [] },
    );
    assert.equal(isolated.get(capability).mode, 'disabled');
  }
  const history = policies.history();
  assert.equal(history.length, 4);
  assert.ok(history.every((entry) => entry.kind === 'migration' && entry.actor.kind === 'migration'));
  policies.set(human, 'issue-create', { mode: 'disabled', roles: [] });
  const reopened = new CapabilityPolicyStore(store, config);
  assert.equal(reopened.get('issue-create').mode, 'disabled');
  assert.deepEqual(reopened.history().slice(0, 4), history);
  assert.equal(reopened.history().length, 5);
  assert.deepEqual(isolated.history(), []);
});

await test('malformed migration fails closed and aborted human edits leave no policy or audit change', (t) => {
  const defer = createCleanup(t);
  const config = createProject(defer);
  const store = new Store(config);
  defer(() => {
    store.close();
  });
  const policies = new CapabilityPolicyStore(store, config);
  const file = path.join(config.directory, 'github', 'connection.json');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Isolated temporary test project.
  mkdirSync(path.dirname(file), { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Intentionally malformed test connection.
  writeFileSync(file, '{}');
  assert.throws(() => policies.get('issue-create'));
  assert.throws(() => policies.history());
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Remove only the isolated malformed fixture.
  unlinkSync(file);
  assert.equal(policies.get('issue-create').mode, 'disabled');
  assert.deepEqual(policies.history(), []);
  assert.throws(() => {
    return store.transaction(() => {
      policies.set(human, 'issue-create', { mode: 'approved-agent-roles', roles: ['team-lead'] });
      throw new Error('Abort fixture transaction');
    });
  }, /Abort/v);
  assert.equal(policies.get('issue-create').mode, 'disabled');
  assert.deepEqual(policies.history(), []);
  // An initialized project never inspects a later connection for migration.
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Intentionally malformed late connection fixture.
  writeFileSync(file, '{}');
  const reopened = new CapabilityPolicyStore(store, config);
  assert.equal(reopened.get('issue-create').mode, 'disabled');
});
