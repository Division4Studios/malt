/**
 * GitHub-free delivery: the real local hub and ledger carry a complete factory
 * loop, with protected-base enforcement, exact-head fencing and crash-safe merges.
 * Inference is a fixture; Git, checks and the hub are real.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { loadConfig } from '../src/config.ts';
import { command } from '../src/factory/commands.ts';
import { localControl, prepareDelivery } from '../src/factory/local-controls.ts';
import { LocalDelivery, MERGEABLE_CHECK } from '../src/factory/local-delivery.ts';
import { LocalHub } from '../src/factory/local-hub.ts';
import { LocalTracker, parseLedger } from '../src/factory/local-tracker.ts';
import { factoryConfigSchema } from '../src/factory/schema.ts';
import { FactoryService } from '../src/factory/service.ts';
import { githubKey, issueKey } from '../src/factory/tracker-key.ts';
import { ProjectGitHub } from '../src/github.ts';
import { ProjectLearning } from '../src/learning.ts';
import { Store } from '../src/store.ts';

import type { AgentCompletion, AgentRequest } from '../src/factory/providers.ts';
import type { AgentResult } from '../src/factory/schema.ts';

/** Valid structured output from fixture roles. */
const success: AgentResult = {
  outcome: 'success',
  summary: 'Acceptance and role checks verified.',
  findings: [],
  deliveries: [],
  skillActions: [],
  instructionReceipts: [],
};

/**
 * Wrap a fixture result as a provider completion.
 *
 * @param result - Role result.
 * @returns Completion without paid inference.
 */
function completion(result: AgentResult): AgentCompletion {
  return {
    result,
    usageTokens: 10,
    cooldownUntil: 0,
    subscriptionUsedPercent: null,
    subscriptionResetAt: null,
    process: { exitCode: 0, stdout: '', stderr: '', interrupted: false },
  };
}

/**
 * Create a repository with one committed baseline and no remote at all.
 *
 * @param prefix - Temporary directory prefix.
 * @returns Repository root.
 */
async function repository(prefix: string): Promise<string> {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  const source = path.join(root, 'source');
  await command('git', ['init', '--initial-branch', 'main', source], root);
  await command('git', ['config', 'user.email', 'fixture@example.invalid'], source);
  await command('git', ['config', 'user.name', 'Local Fixture'], source);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixed source inside the disposable repository.
  await writeFile(path.join(source, 'value.mjs'), 'export const value = 1;\n');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixed validation program inside the disposable repository.
  await writeFile(
    path.join(source, 'check.mjs'),
    'import assert from "node:assert/strict"; import {value} from "./value.mjs"; assert.ok(value>=2);\n',
  );
  await command('git', ['add', '.'], source);
  await command('git', ['commit', '-m', 'Fixture baseline'], source);
  return source;
}

await test('local hub protects its base, fences merges by expected base and recovers interrupted merges', async () => {
  const source = await repository('malt-hub-');
  const mesh = loadConfig(source, { create: true });
  const settings = factoryConfigSchema.parse({
    delivery: 'local',
    remote: 'malt-hub',
    testCommands: [{ file: 'node' }],
    endToEndCommands: [{ file: 'node' }],
  });
  const delivery = new LocalDelivery(mesh, settings);
  assert.equal(await delivery.hub.initialize(source, 'malt-hub'), true);
  assert.equal(await delivery.hub.initialize(source, 'malt-hub'), false, 'Repeated setup reuses the hub.');
  await delivery.verify(await command('git', ['remote', 'get-url', 'malt-hub'], source));
  await assert.rejects(delivery.verify(source), { code: 'WRONG_PROJECT' });
  if (process.platform !== 'win32') {
    const hook = path.join(delivery.hub.directory, 'hooks', 'pre-receive');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixed hook inside the disposable hub.
    chmodSync(hook, 0o600);
    await assert.rejects(
      delivery.verify(await command('git', ['remote', 'get-url', 'malt-hub'], source)),
      { code: 'FACTORY_GATED' },
      'A hook Git would skip is not protection.',
    );
    await delivery.hub.initialize(source, 'malt-hub');
    await delivery.verify(await command('git', ['remote', 'get-url', 'malt-hub'], source));
  }

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixed directory inside the disposable hub.
  mkdirSync(path.join(delivery.hub.directory, 'elsewhere'));
  await command('git', ['config', '--local', 'core.hooksPath', 'elsewhere'], delivery.hub.directory);
  await assert.rejects(
    delivery.verify(await command('git', ['remote', 'get-url', 'malt-hub'], source)),
    { code: 'FACTORY_GATED' },
    'A hook directory Git does not use is not protection.',
  );
  await delivery.hub.initialize(source, 'malt-hub');
  await delivery.verify(await command('git', ['remote', 'get-url', 'malt-hub'], source));

  await command('git', ['commit', '--allow-empty', '-m', 'Direct base push'], source);
  await assert.rejects(
    command('git', ['push', 'malt-hub', 'main'], source),
    'The protected base rejects direct pushes.',
  );
  await command('git', ['reset', '--hard', 'HEAD~1'], source);

  await command('git', ['checkout', '-b', 'feature/a'], source);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixed source inside the disposable repository.
  await writeFile(path.join(source, 'value.mjs'), 'export const value = 2;\n');
  await command('git', ['commit', '-am', 'Raise value'], source);
  await command('git', ['push', 'malt-hub', 'feature/a'], source);
  const base = await delivery.hub.tip();
  const head = await delivery.hub.head('feature/a');
  assert.ok(base !== null && head !== null);
  const preview = await delivery.hub.preview('feature/a');
  assert.deepEqual(preview, { base, head, upToDate: true, mergeable: true });

  await assert.rejects(
    delivery.hub.squash({ pull: 9, branch: 'feature/a', head, base: head, title: 'Stale', body: '' }),
    { code: 'FACTORY_GATED' },
    'An unexpected base must never be overwritten.',
  );
  const merged = await delivery.hub.squash({ pull: 9, branch: 'feature/a', head, base, title: 'Raise', body: 'b' });
  assert.equal(await delivery.hub.tip(), merged);
  assert.equal(
    await delivery.hub.squash({ pull: 9, branch: 'feature/a', head, base, title: 'Raise', body: 'b' }),
    merged,
    'A retried merge after a lost ledger write recognizes its own commit.',
  );
  assert.equal(
    await command('git', ['show', `${merged}:value.mjs`], delivery.hub.directory),
    'export const value = 2;',
  );
  assert.equal(await command('git', ['rev-parse', `${merged}^`], delivery.hub.directory), base);
});

await test('local ledger validates input, deduplicates comments and rejects reused request identities', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'malt-ledger-'));
  let now = 1;
  const tracker = new LocalTracker(directory, () => now);
  const feature = await tracker.createIssue({
    requestId: 'f',
    kind: 'feature',
    title: 'Feature',
    body: 'Scope',
    acceptanceCriteria: ['Done'],
    parent: null,
  });
  const repeat = await tracker.createIssue({
    requestId: 'f',
    kind: 'feature',
    title: 'Feature',
    body: 'Scope',
    acceptanceCriteria: ['Done'],
    parent: null,
  });
  assert.equal(repeat.number, feature.number);
  await assert.rejects(
    tracker.createIssue({
      requestId: 'f',
      kind: 'feature',
      title: 'Other',
      body: '',
      acceptanceCriteria: [],
      parent: null,
    }),
    { code: 'INVALID_INPUT' },
  );
  await assert.rejects(
    tracker.createIssue({
      requestId: 'f',
      kind: 'feature',
      title: 'Feature',
      body: 'Changed scope',
      acceptanceCriteria: ['Done'],
      parent: null,
    }),
    { code: 'INVALID_INPUT' },
    'A retry with changed scope is not the original request.',
  );
  await assert.rejects(
    tracker.createIssue({
      requestId: 'f',
      kind: 'feature',
      title: 'Feature',
      body: 'Scope',
      acceptanceCriteria: ['Done', 'More'],
      parent: null,
    }),
    { code: 'INVALID_INPUT' },
  );
  await tracker.setStatus(feature.number, 'Development');
  assert.equal(
    (
      await tracker.createIssue({
        requestId: 'f',
        kind: 'feature',
        title: 'Feature',
        body: 'Scope',
        acceptanceCriteria: ['Done'],
        parent: null,
      })
    ).number,
    feature.number,
    'A later status change does not make the original request differ.',
  );
  await assert.rejects(
    tracker.createIssue({
      requestId: 'f',
      kind: 'feature',
      title: 'Feature',
      body: 'Scope',
      acceptanceCriteria: ['Done'],
      parent: null,
      status: 'Ready',
    }),
    { code: 'INVALID_INPUT' },
    'A retry requesting another initial status is not the original request.',
  );
  await assert.rejects(
    tracker.createIssue({ requestId: 'x', kind: 'delivery', title: 'D', body: '', acceptanceCriteria: [], parent: 99 }),
    { code: 'INVALID_INPUT' },
  );
  await assert.rejects(
    tracker.createIssue({
      requestId: 'y',
      kind: 'delivery',
      title: 'D',
      body: '',
      acceptanceCriteria: [],
      parent: null,
    }),
    { code: 'INVALID_INPUT' },
    'A delivery requires a feature parent.',
  );
  await assert.rejects(
    tracker.createIssue({
      requestId: 'z',
      kind: 'feature',
      title: 'Nested',
      body: '',
      acceptanceCriteria: [],
      parent: feature.number,
    }),
    { code: 'INVALID_INPUT' },
    'A feature must not have a parent.',
  );
  now = 2;
  assert.equal(await tracker.comment(feature.number, 'effect-1', 'Hello'), true);
  assert.equal(await tracker.comment(feature.number, 'effect-1', 'Hello'), false);
  await assert.rejects(tracker.setStatus(feature.number, 'Shipping'), { code: 'INVALID_INPUT' });
  const concurrent = await Promise.all(
    Array.from({ length: 10 }, async (_, index) => tracker.comment(feature.number, `c-${String(index)}`, 'x')),
  );
  assert.ok(concurrent.every(Boolean));
  assert.equal(tracker.issue(feature.number).comments.length, 11, 'Serialized writes must not lose updates.');
  assert.throws(() => parseLedger({ version: 2 }), { code: 'INTERNAL' });
  assert.throws(() => parseLedger({ ...tracker.read(), issues: [{ number: 'one' }] }), { code: 'INTERNAL' });
});

/**
 * Configure local delivery, request one objective and let the supervisor finish it.
 *
 * @param factory - Isolated factory.
 * @param advance - Fixture clock advance per step.
 */
async function driveLocalDelivery(factory: FactoryService, advance: () => void): Promise<void> {
  await factory.execute('factory_setup', {
    delivery: 'local',
    remote: 'malt-hub',
    maxAttempts: 3,
    testCommands: [{ file: process.execPath, args: ['check.mjs'] }],
    endToEndCommands: [{ file: process.execPath, args: ['check.mjs'] }],
  });
  await factory.execute('factory_request', { objective: 'Deliver a small verified value improvement.' });
  await factory.execute('factory_start', {});
  for (let step = 0; step < 1000 && factory.repository.features()[0]?.phase !== 'done'; step += 1) {
    advance();

    await factory.tick();

    await delay(30);
  }
}

await test('factory delivers end to end through the local hub without any hosted service', async () => {
  const source = await repository('malt-local-loop-');
  const mesh = loadConfig(source, { create: true });
  let now = Date.now();
  const store = new Store(mesh, { now: () => now });
  const stages: string[] = [];
  let writes = 0;
  let isReturned = false;
  const agent = async (request: AgentRequest): Promise<AgentCompletion> => {
    stages.push(request.job.kind);
    if (request.job.kind === 'plan' || request.job.kind === 'refine') {
      return completion({
        ...success,
        deliveries: [
          {
            key: 'value',
            title: 'Deliver verified value',
            description: 'One independently verifiable value change.',
            acceptanceCriteria: ['The public value is at least two.'],
            dependencies: [],
            capabilityTier: 'small',
            skills: [],
          },
        ],
      });
    }
    if (request.job.kind === 'develop') {
      writes += 1;
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixture inference edits only its owned worktree.
      await writeFile(path.join(request.cwd, 'value.mjs'), `export const value = ${String(writes + 1)};\n`);
    }
    if (!isReturned && request.job.role === 'qa-1') {
      isReturned = true;
      return completion({
        ...success,
        outcome: 'changes_requested',
        summary: 'Boundary case needs another change.',
        findings: ['Return this finding to the original developer.'],
      });
    }
    return completion(success);
  };
  const factory = new FactoryService(
    mesh,
    store,
    { github: new ProjectGitHub(mesh), learning: new ProjectLearning(mesh) },
    {
      home: source,
      agent,
      resources: () => ({ freeMemoryMb: 10_000, totalMemoryMb: 20_000, cpuPercent: 1 }),
    },
  );
  let phases: string | undefined;
  try {
    await driveLocalDelivery(factory, () => {
      now += 31_000;
    });
    phases = JSON.stringify(factory.repository.tasks().map((task) => task.phase));
  } finally {
    await factory.close();
    store.close();
  }
  assert.equal(phases, '["done"]');
  assert.ok(isReturned);
  assert.equal(writes, 2, 'The QA defect returned to the original developer exactly once.');
  for (const stage of ['plan', 'refine', 'develop', 'review', 'final', 'verify']) {
    assert.ok(stages.includes(stage), `Missing ${stage} stage.`);
  }
  const local = path.join(mesh.directory, 'local');
  const tracker = new LocalTracker(local);
  const ledger = tracker.read();
  const pull = ledger.pulls[0];
  assert.ok(pull !== undefined);
  assert.equal(pull.state, 'MERGED');
  assert.ok(
    ledger.issues.every((issue) => issue.state === 'closed'),
    JSON.stringify(ledger.issues),
  );
  const hub = new LocalHub(local, 'main');
  assert.equal(await hub.tip(), pull.mergeCommit);
  assert.equal(await command('git', ['show', 'main:value.mjs'], hub.directory), 'export const value = 3;');
  const settings = factoryConfigSchema.parse({ testCommands: [{ file: 'x' }], endToEndCommands: [{ file: 'x' }] });
  const delivery = new LocalDelivery(mesh, settings);
  const snapshot = await delivery.inspect(pull.number);
  assert.equal(snapshot.state, 'MERGED');
  assert.equal(snapshot.mergeCommit?.oid, pull.mergeCommit);
  assert.ok((snapshot.statusCheckRollup ?? []).every((check) => check.name !== MERGEABLE_CHECK));
  const enabled = { ...settings, delivery: 'local' as const, remote: 'malt-hub' };
  const described = JSON.stringify(await localControl(mesh, enabled, { action: 'pull', number: pull.number }));
  assert.match(described, /export const value = 3/v, 'Merged pull requests keep a reviewable diff.');
  const synced = JSON.stringify(await localControl(mesh, enabled, { action: 'sync' }));
  assert.ok(synced.includes(`"after":"${pull.mergeCommit ?? ''}","updated":true`), synced);
  assert.equal(await command('git', ['rev-parse', 'main'], source), pull.mergeCommit);
  assert.equal(await command('git', ['show', 'HEAD:value.mjs'], source), 'export const value = 3;');
});

await test('local controls create Ready deliveries for import and reject disabled or incomplete use', async () => {
  const source = await repository('malt-local-controls-');
  const mesh = loadConfig(source, { create: true });
  const base = { testCommands: [{ file: 'node' }], endToEndCommands: [{ file: 'node' }] };
  const github = factoryConfigSchema.parse(base);
  await assert.rejects(localControl(mesh, github, { action: 'summary' }), { code: 'FACTORY_GATED' });
  const settings = factoryConfigSchema.parse({ ...base, delivery: 'local', remote: 'malt-hub' });
  await prepareDelivery(mesh, settings, false);
  const delivery = new LocalDelivery(mesh, settings);
  const feature = { action: 'create_issue', requestId: 'checkout', kind: 'feature', title: 'Checkout' };
  const parent = await localControl(mesh, settings, {
    ...feature,
    description: 'Saved addresses.',
    acceptanceCriteria: ['Returning customers reuse an address.'],
  });
  assert.ok(typeof parent === 'object' && parent !== null && 'number' in parent);
  await assert.rejects(
    localControl(mesh, settings, {
      action: 'create_issue',
      requestId: 'orphan',
      kind: 'delivery',
      title: 'x',
      description: 'x',
      acceptanceCriteria: ['x'],
    }),
    { code: 'INVALID_INPUT' },
  );
  await assert.rejects(
    localControl(mesh, settings, {
      ...feature,
      requestId: 'nested',
      description: 'x',
      acceptanceCriteria: [],
      parent: parent.number,
    }),
    { code: 'INVALID_INPUT' },
    'A feature must not have a parent.',
  );
  const unknownStatus = {
    action: 'create_issue',
    requestId: 'shipping',
    kind: 'delivery',
    title: 'x',
    description: 'x',
    acceptanceCriteria: ['x'],
    parent: parent.number,
    status: 'Shipping',
  };
  await assert.rejects(localControl(mesh, settings, unknownStatus), { code: 'INVALID_INPUT' });
  assert.equal(
    delivery.tracker.read().requests['shipping'],
    undefined,
    'A rejected status must not persist an issue or consume its request ID.',
  );
  await localControl(mesh, settings, {
    action: 'create_issue',
    requestId: 'select-address',
    kind: 'delivery',
    title: 'Select a saved address',
    description: 'Add the picker.',
    acceptanceCriteria: ['The picker lists saved addresses.'],
    parent: parent.number,
    status: 'Ready',
  });
  const ready = await delivery.readyIssues();
  assert.equal(ready.length, 1);
  const [imported] = ready;
  assert.ok(imported !== undefined);
  assert.equal(imported.title, 'Select a saved address');
  assert.deepEqual(imported.acceptanceCriteria, ['The picker lists saved addresses.']);
  await assert.rejects(localControl(mesh, settings, { action: 'issue' }), { code: 'INVALID_INPUT' });
  await assert.rejects(localControl(mesh, settings, { action: 'pull', number: 99 }), { code: 'NOT_FOUND' });
  assert.deepEqual(await delivery.issueState(issueKey(imported)), { state: 'open', stateReason: null });
  const effect = { id: 'close-select', issue: imported.issue, value: '', attempts: 0, retryAt: 0, error: null };
  await delivery.effect({ ...effect, kind: 'close_not_planned' });
  assert.deepEqual(await delivery.issueState(issueKey(imported)), { state: 'closed', stateReason: 'not_planned' });
  await assert.rejects(delivery.issueState({ provider: 'github', key: '0' }), { code: 'INVALID_INPUT' });
  await assert.rejects(delivery.issueState({ provider: 'jira', key: 'PROJ-1' }), { code: 'INVALID_INPUT' });
  await assert.rejects(delivery.issueState(githubKey(404)), { code: 'NOT_FOUND' });
  const synced = await localControl(mesh, settings, { action: 'sync' });
  assert.ok(typeof synced === 'object' && synced !== null && 'updated' in synced && synced.updated === false);
});

await test('local ledger accepts only an identical retried merge settlement', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'malt-ledger-'));
  const tracker = new LocalTracker(directory, () => 1);
  const pull = await tracker.openPull({ issue: 1, title: 'T', body: '', head: 'feature/a', base: 'main' });
  const merged = { state: 'MERGED', mergeCommit: 'a'.repeat(40), mergedHead: 'b'.repeat(40) } as const;
  await tracker.settlePull(pull.number, merged);
  assert.equal((await tracker.settlePull(pull.number, merged)).state, 'MERGED', 'An identical retry is idempotent.');
  await assert.rejects(tracker.settlePull(pull.number, { ...merged, mergeCommit: 'c'.repeat(40) }), {
    code: 'FACTORY_GATED',
  });
  await assert.rejects(tracker.settlePull(pull.number, { ...merged, mergedHead: 'c'.repeat(40) }), {
    code: 'FACTORY_GATED',
  });
  await assert.rejects(tracker.settlePull(pull.number, { state: 'CLOSED' }), { code: 'FACTORY_GATED' });
});
