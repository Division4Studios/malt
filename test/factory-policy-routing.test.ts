/** @file Policy resolution and unpaid readiness contracts before dispatch is enabled. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { isPolicyContextVerified, policyPreflight, recordProviderReadiness } from '../src/factory/policy-routing.ts';
import { FactoryRepository } from '../src/factory/repository.ts';
import { routeAssignment } from '../src/factory/routing.ts';
import { Store } from '../src/store.ts';

import { policyIntent as intent, policySettings as settings } from './fixtures/model-policy.ts';
import { createCleanup, createProject } from './helpers.ts';

import type { Provider } from '../src/factory/schema.ts';

await test('every managed stage resolves supported frozen selection after capability and effort floors', () => {
  for (const [role, kind] of [
    ['product-owner', 'plan'],
    ['team-lead', 'refine'],
    ['developer-1', 'develop'],
    ['developer-2', 'develop'],
    ['qa-1', 'review'],
    ['qa-2', 'review'],
    ['final-tester', 'final'],
    ['final-tester', 'verify'],
    ['learning-steward', 'learn'],
    ['team-lead', 'skill'],
    ['team-lead', 'triage'],
  ] as const) {
    const routing = routeAssignment({
      intent: { ...intent, role, kind },
      provider: 'claude',
      settings,
      task: null,
      versions: { claude: 'fixture-1' },
    });
    assert.equal(routing.model, 'fixture-claude');
    assert.equal(routing.selection?.policyRevision, 1);
    assert.equal(routing.selection.observedVersion, 'fixture-1');
    assert.equal(routing.effort, routing.tier === 'advanced' ? 'high' : 'medium');
  }
  for (const versions of [{ claude: 'new-unreviewed-version' }, { claude: 'fixture' }, undefined]) {
    assert.throws(() => {
      routeAssignment({ intent, provider: 'claude', settings, task: null, versions });
    }, /matching verified CLI version/v);
  }
});

await test('a failed subscription preflight cannot prevent a different native provider from being verified', async () => {
  const calls: Provider[] = [];
  const ready = await policyPreflight(settings, 'fixture-only', async (isolated) => {
    const provider = isolated.providers.codex.enabled ? 'codex' : 'claude';
    calls.push(provider);
    assert.notEqual(isolated.providers.codex.enabled, isolated.providers.claude.enabled);
    await Promise.resolve();
    if (provider === 'codex') {
      throw new Error('Fixture unavailable CLI.');
    }
    return [{ provider: 'claude', version: 'fixture-1', authentication: 'claude.ai' }];
  });
  assert.deepEqual(calls, ['codex', 'claude']);
  assert.deepEqual(ready, [{ provider: 'claude', version: 'fixture-1', authentication: 'claude.ai' }]);
});

await test('readiness replacement removes failed providers and async context changes cannot publish stale evidence', async (t) => {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  const store = new Store(mesh);
  defer(() => {
    store.close();
  });
  const repository = new FactoryRepository(store);
  repository.configure(settings);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Create only the private factory directory of this disposable project.
  mkdirSync(path.join(mesh.directory, 'factory'), { recursive: true });
  const versions: Partial<Record<Provider, string>> = { codex: 'old', claude: 'old' };
  recordProviderReadiness({ mesh, repository, providerVersions: versions }, [
    { provider: 'claude', version: 'fixture-1', authentication: 'claude.ai' },
  ]);
  assert.deepEqual(versions, { claude: 'fixture-1' });
  let isCurrent = true;
  let probes = 0;
  const context = {
    mesh,
    repository,
    settings,
    providerVersions: versions,
    remote: {
      verify: async () => {
        await Promise.resolve();
      },
    },
    workspaces: {
      origin: async () => {
        await Promise.resolve();
        return 'https://github.com/fixture/app.git';
      },
    },
  };
  assert.equal(
    await isPolicyContextVerified(
      context,
      () => false,
      async () => {
        probes += 1;
        await Promise.resolve();
        return [];
      },
    ),
    false,
  );
  assert.equal(probes, 0);
  assert.equal(
    await isPolicyContextVerified(
      context,
      () => isCurrent,
      async () => {
        probes += 1;
        await Promise.resolve();
        isCurrent = false;
        return [];
      },
    ),
    false,
  );
  assert.equal(probes, 1);
  assert.deepEqual(versions, { claude: 'fixture-1' }, 'Invalidated setup cannot replace current readiness.');
});
