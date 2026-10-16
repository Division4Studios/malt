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
import { parseConnection } from '../src/connector.ts';
import { MeshError } from '../src/protocol.ts';
import { Store } from '../src/store.ts';

import { createCleanup, createProject } from './helpers.ts';

import type { CapabilityPrincipal } from '../src/capability-policy.ts';

/** Authenticated operator supplied by the transport boundary. */
const human: CapabilityPrincipal = { kind: 'human', id: 'operator' };
/** Every project lets a human create or connect its first Project without a prior edit. */
const HUMAN_SETUP = new Set(['project-create', 'project-connect']);

/**
 * Expected fresh-project policy.
 *
 * @param capability - Capability name.
 * @returns Human-only for initial setup, disabled otherwise.
 */
function freshPolicy(capability: string): { mode: string; roles: string[] } {
  return { mode: HUMAN_SETUP.has(capability) ? 'human-only' : 'disabled', roles: [] };
}

await test('fresh defaults, human-only edits, validation and immutable history survive restart', (t) => {
  const defer = createCleanup(t);
  const config = createProject(defer);
  let store = new Store(config);
  defer(() => {
    store.close();
  });
  const policies = new CapabilityPolicyStore(store, config);
  for (const capability of CAPABILITIES) {
    assert.deepEqual(policies.get(capability), freshPolicy(capability));
  }
  const seeded = policies.history();
  assert.deepEqual(
    seeded.map((entry) => [entry.capability, entry.actor.id, entry.next.mode]),
    [
      ['project-create', 'default-human-setup', 'human-only'],
      ['project-connect', 'default-human-setup', 'human-only'],
    ],
  );
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
  assert.deepEqual(policies.history(), seeded);
  policies.set(human, 'issue-create', { mode: 'approved-agent-roles', roles: ['team-lead'] });
  policies.set(human, 'issue-create', { mode: 'human-only', roles: [] });
  const history = policies.history().filter((entry) => entry.kind === 'human');
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
  assert.deepEqual(reopened.history(), [...seeded, ...history]);
  assert.throws(() => {
    store.db.exec('DELETE FROM capability_policy_history');
  }, /immutable/v);
  assert.throws(() => {
    store.db.exec("UPDATE capability_policy_history SET next = '{}'");
  }, /immutable/v);
});

for (const version of [1, 2]) {
  await test(`v${String(version)} connection migration is idempotent, isolated, and never reapplied after human revocation`, (t) => {
    const defer = createCleanup(t);
    const config = createProject(defer);
    const other = createProject(defer);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Isolated temporary test project.
    mkdirSync(path.join(config.directory, 'github'), { recursive: true });
    const now = new Date();
    const legacyConnection = {
      version: 1,
      repository: 'example/app',
      owner: 'example',
      project: { id: 'P_10', number: 10, url: 'https://github.com/users/example/projects/10' },
      statusField: { id: 'status', name: 'Status', options: [] },
      verifiedAt: now.toISOString(),
    };
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Isolated temporary test fixture.
    writeFileSync(
      path.join(config.directory, 'github', 'connection.json'),
      JSON.stringify(version === 1 ? legacyConnection : parseConnection(legacyConnection).v2),
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
    // Re-verifying the saved Project is a connect, so the lead keeps it too.
    const migrated = new Set(['project-connect', 'issue-create', 'relationships', 'membership', 'transition']);
    for (const capability of CAPABILITIES) {
      let expected = freshPolicy(capability);
      if (migrated.has(capability)) {
        expected = { mode: 'approved-agent-roles', roles: ['team-lead'] };
      }
      assert.deepEqual(policies.get(capability), expected);
      assert.deepEqual(isolated.get(capability), freshPolicy(capability));
    }
    const history = policies.history();
    assert.equal(history.length, 6);
    assert.ok(history.every((entry) => entry.kind === 'migration' && entry.actor.kind === 'migration'));
    assert.deepEqual(
      history.filter((entry) => entry.actor.id === 'default-human-setup').map((entry) => entry.capability),
      ['project-create'],
    );
    policies.set(human, 'issue-create', { mode: 'disabled', roles: [] });
    const reopened = new CapabilityPolicyStore(store, config);
    assert.equal(reopened.get('issue-create').mode, 'disabled');
    assert.deepEqual(reopened.history().slice(0, 6), history);
    assert.equal(reopened.history().length, 7);
    assert.equal(isolated.history().length, HUMAN_SETUP.size);
  });
}

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
  const seeded = policies.history();
  assert.equal(seeded.length, HUMAN_SETUP.size);
  assert.throws(() => {
    return store.transaction(() => {
      policies.set(human, 'issue-create', { mode: 'approved-agent-roles', roles: ['team-lead'] });
      throw new Error('Abort fixture transaction');
    });
  }, /Abort/v);
  assert.equal(policies.get('issue-create').mode, 'disabled');
  assert.deepEqual(policies.history(), seeded);
  // An initialized project never inspects a later connection for migration.
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Intentionally malformed late connection fixture.
  writeFileSync(file, '{}');
  const reopened = new CapabilityPolicyStore(store, config);
  assert.equal(reopened.get('issue-create').mode, 'disabled');
});

await test('each mode decides human, agent and supervisor principals independently', (t) => {
  const defer = createCleanup(t);
  const config = createProject(defer);
  const store = new Store(config);
  defer(() => {
    store.close();
  });
  const policy = new CapabilityPolicyStore(store, config);
  const lead: CapabilityPrincipal = { kind: 'agent', id: 'ag_lead', role: 'team-lead' };
  const developer: CapabilityPrincipal = { kind: 'agent', id: 'ag_dev', role: 'developer-1' };
  const supervisor: CapabilityPrincipal = { kind: 'supervisor', role: 'team-lead' };
  const cases: [string, string[], CapabilityPrincipal[], CapabilityPrincipal[]][] = [
    ['disabled', [], [], [human, lead, developer, supervisor]],
    ['human-only', [], [human], [lead, developer, supervisor]],
    ['approved-agent-roles', ['team-lead'], [human, lead, supervisor], [developer]],
  ];
  for (const [mode, roles, allowed, denied] of cases) {
    policy.set(human, 'transition', { mode, roles });
    for (const principal of allowed) {
      policy.authorize(principal, ['transition']);
    }
    for (const principal of denied) {
      assert.throws(
        () => {
          policy.authorize(principal, ['transition']);
        },
        (error: unknown) => {
          return (
            error instanceof MeshError &&
            error.code === 'CAPABILITY_DENIED' &&
            error.message.includes(`transition is ${mode}`)
          );
        },
      );
    }
  }
  // Every capability an operation needs must pass, not just the first.
  policy.set(human, 'membership', { mode: 'disabled', roles: [] });
  assert.throws(
    () => {
      policy.authorize(human, ['transition', 'membership']);
    },
    { code: 'CAPABILITY_DENIED', message: /membership is disabled/v },
  );
  policy.authorize({ kind: 'agent', id: 'ag_any', role: 'qa-1' }, []);
  for (const forged of [{ kind: 'agent', id: 'x', role: 'root' }, { kind: 'supervisor' }, { kind: 'human' }, null]) {
    assert.throws(() => {
      policy.authorize(forged, ['transition']);
    });
  }
});
