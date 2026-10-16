/** @file Policy eligibility, fallback and real supervisor claims without paid inference. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { AdmissionPool, brokerAdmission } from '../src/factory/admission.ts';
import { admittedAssignment } from '../src/factory/dispatch-admission.ts';
import { queueObjective } from '../src/factory/objectives.ts';
import { policyBlocker } from '../src/factory/policy-blockers.ts';
import { retryBlocked } from '../src/factory/recovery.ts';
import { FactoryRepository } from '../src/factory/repository.ts';
import { factoryConfigSchema } from '../src/factory/schema.ts';
import { FactoryService } from '../src/factory/service.ts';
import { WorkspaceManager } from '../src/factory/workspaces.ts';
import { ProjectGitHub } from '../src/github.ts';
import { ProjectLearning } from '../src/learning.ts';
import { Store } from '../src/store.ts';

import { policyIntent as intent, policySettings as settings } from './fixtures/model-policy.ts';
import { createCleanup, createProject } from './helpers.ts';

import type { FactoryContext } from '../src/factory/context.ts';
import type { AgentCompletion, AgentRequest } from '../src/factory/providers.ts';
import type { TestContext } from 'node:test';

/** Controlled counters with ample local capacity. */
const sample = { freeMemoryMb: 10_000, totalMemoryMb: 20_000, cpuPercent: 1 };

/**
 * Reject any unplanned remote or inference boundary.
 *
 * @returns Always rejects, without network access.
 */
async function unused(): Promise<never> {
  await Promise.resolve();
  throw new Error('Unused fixture boundary.');
}

/**
 * Create isolated durable settings and explicit fixture-only CLI readiness.
 *
 * @param t - Resource owner.
 * @param config - Validated project settings.
 * @returns Real SQLite with injectable local boundaries.
 */
function contextFor(t: TestContext, config = settings): FactoryContext {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  const store = new Store(mesh);
  defer(() => {
    store.close();
  });
  const repository = new FactoryRepository(store);
  repository.configure(config);
  return {
    mesh,
    home: mesh.root,
    repository,
    settings: config,
    providerVersions: 'fixture',
    workspaces: new WorkspaceManager(mesh, config),
    learning: new ProjectLearning(mesh),
    agent: unused,
    processes: unused,
    remote: {
      verify: async () => delay(0),
      readyIssues: async () => delay(0, []),
      effect: async () => delay(0),
      issueState: async () => delay(0, { state: 'open', stateReason: null }),
      parentComplete: async () => delay(0, false),
      provision: unused,
      inspect: unused,
      merge: unused,
      pullRequest: unused,
    },
  };
}

await test('ineligible low-utilization provider cannot block an adequate fallback or bypass cooldown/caps', (t) => {
  const context = contextFor(t);
  const pool = new AdmissionPool();
  const capacity = context.repository.capacity('claude', settings);
  context.repository.saveCapacity({
    ...capacity,
    subscriptionUsedPercent: 80,
    subscriptionResetAt: Date.now() + 60_000,
    telemetrySource: 'fixture',
  });
  const admitted = admittedAssignment(context, sample, pool, intent);
  assert.equal(admitted?.provider, 'claude');
  assert.equal(admitted.routing.model, 'fixture-claude');
  assert.deepEqual(context.repository.jobs(), []);
  assert.equal(context.repository.capacity('claude', settings).reservedTokens, 0);
  assert.equal(admittedAssignment(context, { ...sample, cpuPercent: 99 }, pool, intent), null);
  context.repository.saveCapacity({ ...capacity, cooldownUntil: Date.now() + 60_000 });
  assert.equal(admittedAssignment(context, sample, pool, intent), null);
  assert.equal(policyBlocker(context.repository), null, 'A cooldown is not a model-policy failure.');
});

await test('inadequate choices park durably once without claims, paid retries or stale-policy admission', (t) => {
  const config = factoryConfigSchema.parse({
    ...settings,
    providers: { ...settings.providers, claude: { ...settings.providers.claude, enabled: false } },
  });
  const context = contextFor(t, config);
  const queued = queueObjective(context.repository, { objective: 'Keep this scope until policy is repaired.' });
  const request = { ...intent, featureId: queued.featureId };
  const pool = new AdmissionPool();
  assert.equal(admittedAssignment(context, sample, pool, request), null);
  const blocked = context.repository.features()[0];
  assert.ok(blocked !== undefined);
  assert.equal(blocked.phase, 'blocked');
  assert.match(policyBlocker(context.repository) ?? '', /codex: no allowed standard/v);
  const events = context.repository.store.db
    .prepare("SELECT count(*) AS count FROM events WHERE type='FACTORY_MODEL_POLICY_BLOCKED'")
    .get()?.['count'];
  assert.equal(admittedAssignment(context, sample, pool, request), null);
  assert.equal(
    context.repository.store.db
      .prepare("SELECT count(*) AS count FROM events WHERE type='FACTORY_MODEL_POLICY_BLOCKED'")
      .get()?.['count'],
    events,
  );
  const reopened = new Store(context.mesh);
  assert.equal(policyBlocker(new FactoryRepository(reopened)), policyBlocker(context.repository));
  reopened.close();
  assert.deepEqual(context.repository.jobs(), []);
  assert.equal(context.repository.capacity('codex', config).reservedTokens, 0);
  const changed = factoryConfigSchema.parse({ ...settings, modelPolicy: { ...settings.modelPolicy, revision: 2 } });
  context.repository.configure(changed);
  retryBlocked(context.repository, { featureId: queued.featureId });
  assert.equal(
    admittedAssignment(context, sample, pool, request),
    null,
    'Cached old policy cannot claim after a revision change.',
  );
  assert.equal(policyBlocker(context.repository), null);
  assert.equal(
    admittedAssignment({ ...context, settings: changed }, sample, pool, request)?.routing.selection?.policyRevision,
    2,
  );
});

await test('actual supervisor persists frozen policy before inference and revalidates a fresh session after pause', async (t) => {
  const defer = createCleanup(t);
  const context = contextFor(t);
  const git = context.workspaces;
  await git.git(['init', '--initial-branch=main']);
  await git.git(['config', 'user.name', 'Policy fixture']);
  await git.git(['config', 'user.email', 'policy@example.invalid']);
  await git.git(['add', '.']);
  await git.git(['commit', '-m', 'Disposable baseline']);
  const origin = path.join(context.mesh.directory, 'origin.git');
  await git.git(['init', '--bare', origin]);
  await git.git(['remote', 'add', 'origin', origin]);
  await git.git(['push', '-u', 'origin', 'main']);
  const requests: AgentRequest[] = [];
  const agent = async (request: AgentRequest): Promise<AgentCompletion> => {
    requests.push(request);
    await new Promise<void>((resolve) => {
      request.signal.addEventListener(
        'abort',
        () => {
          resolve();
        },
        { once: true },
      );
      if (request.signal.aborted) {
        resolve();
      }
    });
    throw new Error('Fixture inference stopped on operator pause.');
  };
  const factory = new FactoryService(
    context.mesh,
    context.repository.store,
    { github: new ProjectGitHub(context.mesh), learning: context.learning },
    {
      home: context.home,
      agent,
      remote: context.remote,
      resources: () => sample,
    },
  );
  defer(async () => factory.close());
  const { featureId } = queueObjective(factory.repository, {
    objective: 'Exercise frozen native selection, not a paid model.',
  });
  factory.repository.setActive(true);
  for (let pass = 0; pass < 100 && requests.length === 0; pass += 1) {
    await factory.tick();
    await delay(20);
  }
  const firstRequest = requests[0];
  assert.ok(firstRequest !== undefined);
  const frozen = factory.repository.jobs()[0]?.routing;
  assert.equal(frozen?.selection?.policyRevision, 1);
  assert.equal(frozen.model, 'fixture-claude');
  assert.equal(frozen.effort, 'medium');
  await assert.rejects(
    factory.execute('factory_model_policy', { expectedRevision: 1, policy: { ...settings.modelPolicy, revision: 2 } }),
    /Pause/v,
  );
  await factory.close(true);
  assert.equal(brokerAdmission.size, 0);
  const next = { ...settings.modelPolicy, revision: 2 };
  await factory.execute('factory_model_policy', { expectedRevision: 1, policy: next });
  assert.deepEqual(factory.repository.jobs()[0]?.routing, frozen, 'Historical assignment is not hot-patched.');
  assert.equal(factory.repository.features().find((feature) => feature.id === featureId)?.phase, 'queued');
  const resumed = new FactoryService(
    context.mesh,
    context.repository.store,
    { github: new ProjectGitHub(context.mesh), learning: context.learning },
    {
      home: context.home,
      agent,
      remote: context.remote,
      resources: () => sample,
    },
  );
  defer(async () => resumed.close());
  resumed.repository.setActive(true);
  for (let pass = 0; pass < 100 && requests.length < 2; pass += 1) {
    await resumed.tick();
    await delay(20);
  }
  assert.equal(requests[1]?.job.routing?.selection?.policyRevision, 2);
  await resumed.close(true);
  assert.equal(brokerAdmission.size, 0);
});
