/**
 * Revision-fenced operator decisions, bounded investigations and external PR recovery.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { run } from '../src/database.ts';
import { hasParkedPRUpdate } from '../src/factory/blocked-pr.ts';
import { recordCancellation } from '../src/factory/controls.ts';
import { jobIntents } from '../src/factory/scheduler.ts';
import { factoryConfigSchema, taskSchema, jobSchema, factorySchemas } from '../src/factory/schema.ts';
import { FactoryService } from '../src/factory/service.ts';
import {
  decideTriage,
  triageStatus,
  queueBlockerInvestigations,
  completeTriage,
  pendingTriage,
} from '../src/factory/triage.ts';
import { ProjectGitHub } from '../src/github.ts';
import { ProjectLearning } from '../src/learning.ts';
import { parseInput } from '../src/protocol.ts';
import { Store } from '../src/store.ts';

import { createCleanup, createProject } from './helpers.ts';

import type { TestContext } from 'node:test';

/** Validated fixture policy; no provider is launched. */
const config = factoryConfigSchema.parse({
  testCommands: [{ file: process.execPath }],
  endToEndCommands: [{ file: process.execPath }],
});

/**
 * Open an isolated factory without starting its scheduler.
 *
 * @param t - Test cleanup.
 * @returns Project context.
 */
function fixture(t: TestContext): ReturnType<FactoryService['configured']> {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  const store = new Store(mesh);
  defer(() => {
    store.close();
  });
  const factory = new FactoryService(
    mesh,
    store,
    { github: new ProjectGitHub(mesh), learning: new ProjectLearning(mesh) },
    { home: mesh.root },
  );
  defer(async () => factory.close());
  factory.repository.configure(config);
  factory.repository.addTask(
    taskSchema.parse({
      id: randomUUID(),
      featureId: null,
      issue: 1,
      parentIssue: 2,
      key: 'one',
      title: 'Repair existing PR',
      description: 'Bounded fixture.',
      acceptanceCriteria: ['Works'],
      dependencies: [],
      phase: 'blocked',
      developer: 'developer-2',
      branch: 'malt/fixture',
      worktree: null,
      head: 'old',
      base: 'base',
      pr: 3,
      prUrl: 'https://github.com/fixture/app/pull/3',
      merge: null,
      reviews: [],
      feedback: [],
      attempts: 2,
      version: 0,
      error: 'Required checks failed.',
      updatedAt: 1,
    }),
  );
  return factory.configured();
}

await test('decisions replay exactly, fence stale revisions and do not treat acknowledgment as a fix', (t) => {
  const { repository } = fixture(t);
  const task = repository.tasks()[0];
  assert.ok(task !== undefined);
  const input = {
    requestId: randomUUID(),
    taskId: task.id,
    expectedVersion: task.version,
    action: 'acknowledge',
    note: 'Seen',
  };
  const receipt = decideTriage(repository, input);
  assert.equal(repository.task(task.id).phase, 'blocked');
  assert.deepEqual(decideTriage(repository, input), receipt);
  assert.throws(() => decideTriage(repository, { ...input, note: 'Changed' }), /identity/v);
  repository.editTask(task.id, (current) => ({ ...current, error: 'New evidence' }));
  assert.throws(() => decideTriage(repository, { ...input, requestId: randomUUID() }), /changed/v);
});

await test('waiting does not spin a lead; investigations are single-shot and repair preserves owner', (t) => {
  const { repository } = fixture(t);
  let task = repository.tasks()[0];
  assert.ok(task !== undefined);
  decideTriage(repository, {
    requestId: randomUUID(),
    taskId: task.id,
    expectedVersion: task.version,
    action: 'wait',
    note: 'Which acceptance behavior is intended?',
  });
  queueBlockerInvestigations(repository);
  assert.equal(triageStatus(repository).length, 1, 'Waiting must not immediately schedule a fresh investigation.');
  task = repository.task(task.id);
  const decision = decideTriage(repository, {
    requestId: randomUUID(),
    taskId: task.id,
    expectedVersion: task.version,
    action: 'investigate',
    note: 'Diagnose',
  });
  const intents = jobIntents({
    config,
    tasks: repository.tasks(),
    features: [],
    jobs: [],
    skillRequests: [],
    triage: triageStatus(repository),
    now: Date.now(),
  });
  const intent = intents.find((candidate) => candidate.kind === 'triage');
  assert.ok(intent !== undefined);
  const job = jobSchema.parse({
    ...intent,
    id: randomUUID(),
    token: randomUUID(),
    provider: 'codex',
    state: 'running',
    startedAt: 1,
    finishedAt: null,
    expiresAt: Date.now() + 1000,
    reservation: 1,
    usageTokens: null,
    pid: null,
    summary: null,
    artifact: 'fixture',
  });
  completeTriage(repository, job, {
    outcome: 'blocked',
    summary: 'Need a product decision.',
    findings: ['Should this accept empty input?'],
    deliveries: [],
    skillActions: [],
    instructionReceipts: [],
  });
  assert.equal(triageStatus(repository).find((item) => item.id === decision.id)?.state, 'awaiting_operator');
  queueBlockerInvestigations(repository);
  assert.equal(triageStatus(repository).length, 2);
  decideTriage(repository, {
    requestId: randomUUID(),
    taskId: task.id,
    expectedVersion: task.version,
    action: 'repair',
    note: 'Reject empty input.',
  });
  assert.equal(repository.task(task.id).developer, 'developer-2');
  assert.equal(repository.task(task.id).phase, 'development');
  assert.ok(repository.instructions('developer-2', task.id).some((item) => item.body.includes('Reject empty input')));
});

await test('external merged PRs stop implementation loops and require explicit verification, never fake approvals', async (t) => {
  const context = fixture(t);
  const { repository } = context;
  const task = repository.tasks()[0];
  assert.ok(task !== undefined);
  t.mock.method(context.remote, 'inspect', async () => {
    await delay(0);
    return {
      number: 3,
      url: task.prUrl ?? '',
      headRefOid: 'new',
      baseRefOid: 'base',
      baseRefName: 'main',
      isDraft: false,
      state: 'MERGED',
      mergeStateStatus: 'CLEAN',
      mergeCommit: { oid: 'merged' },
      statusCheckRollup: [],
    };
  });
  assert.equal(await hasParkedPRUpdate(context, task), true);
  const parked = repository.task(task.id);
  assert.equal(parked.merge, 'merged');
  assert.equal(parked.phase, 'blocked');
  await hasParkedPRUpdate(context, parked);
  assert.equal(
    repository.task(task.id).version,
    parked.version,
    'Same remote evidence must not generate an event/retry storm.',
  );
  decideTriage(repository, {
    requestId: randomUUID(),
    taskId: task.id,
    expectedVersion: parked.version,
    action: 'verify',
    note: 'Verify my external merge on actual main.',
  });
  const verifying = repository.task(task.id);
  assert.equal(verifying.phase, 'verifying');
  assert.deepEqual(verifying.reviews, []);
  assert.equal(verifying.verifiedMain, null);
});

await test('existing PR owner repairs precede new development, and stale lead findings cannot change task state', (t) => {
  const { repository } = fixture(t);
  const task = repository.tasks()[0];
  assert.ok(task !== undefined);
  decideTriage(repository, {
    requestId: randomUUID(),
    taskId: task.id,
    expectedVersion: task.version,
    action: 'repair',
    note: 'Repair the PR.',
  });
  const existing = repository.task(task.id);
  const fresh = {
    ...existing,
    id: randomUUID(),
    issue: 4,
    pr: null,
    prUrl: null,
    developer: null,
    phase: 'ready' as const,
  };
  const intents = jobIntents({
    config,
    tasks: [fresh, existing],
    features: [],
    jobs: [],
    skillRequests: [],
    now: Date.now(),
  });
  assert.equal(intents[0]?.taskId, existing.id);
  assert.equal(intents[0].role, 'developer-2');
});

await test('old queued investigations survive a full newer history and focus filters the durable queue', (t) => {
  const { repository } = fixture(t);
  const task = repository.tasks()[0];
  assert.ok(task !== undefined);
  const queued = decideTriage(repository, {
    requestId: randomUUID(),
    taskId: task.id,
    expectedVersion: task.version,
    action: 'investigate',
    note: 'Old pending diagnosis',
  });
  for (let index = 0; index < 105; index += 1) {
    decideTriage(repository, {
      requestId: randomUUID(),
      taskId: task.id,
      expectedVersion: task.version,
      action: 'acknowledge',
      note: 'Newer receipt',
    });
  }
  assert.equal(
    triageStatus(repository).some((decision) => decision.id === queued.id),
    false,
  );
  assert.equal(pendingTriage(repository, null)[0]?.id, queued.id);
  assert.deepEqual(pendingTriage(repository, randomUUID()), []);
  const intents = jobIntents({
    config,
    tasks: repository.tasks(),
    features: [],
    jobs: [],
    skillRequests: [],
    triage: pendingTriage(repository, null),
    now: Date.now(),
  });
  const intent = intents.find((candidate) => candidate.kind === 'triage');
  assert.ok(intent !== undefined);
  const job = jobSchema.parse({
    ...intent,
    id: randomUUID(),
    token: randomUUID(),
    provider: 'codex',
    state: 'running',
    startedAt: 1,
    finishedAt: null,
    expiresAt: Date.now() + 1000,
    reservation: 0,
    usageTokens: null,
    pid: null,
    summary: null,
    artifact: 'fixture',
  });
  completeTriage(repository, job, {
    outcome: 'blocked',
    summary: 'Need a decision',
    findings: [],
    deliveries: [],
    skillActions: [],
    instructionReceipts: [],
  });
  assert.deepEqual(pendingTriage(repository, null), []);
});

await test('cancelled investigations stay parked and stale decisions cannot claim paid capacity', (t) => {
  const { repository } = fixture(t);
  const task = repository.tasks()[0];
  assert.ok(task !== undefined);
  const decision = decideTriage(repository, {
    requestId: randomUUID(),
    taskId: task.id,
    expectedVersion: task.version,
    action: 'investigate',
  });
  const job = jobSchema.parse({
    id: randomUUID(),
    token: randomUUID(),
    role: 'team-lead',
    kind: 'triage',
    target: decision.id,
    taskId: task.id,
    featureId: null,
    head: null,
    base: null,
    provider: 'codex',
    state: 'running',
    startedAt: 1,
    finishedAt: null,
    expiresAt: Date.now() + 1000,
    reservation: 0,
    usageTokens: null,
    pid: null,
    summary: null,
    artifact: 'fixture',
  });
  assert.equal(repository.claim(job, config), true);
  recordCancellation(repository, job);
  repository.finishJob(job, 0, 'interrupted', {});
  queueBlockerInvestigations(repository);
  assert.deepEqual(pendingTriage(repository, null), []);
  const parked = triageStatus(repository).find((item) => item.id === decision.id);
  assert.equal(parked?.state, 'awaiting_operator');
  assert.equal(parked.version, repository.task(task.id).version);
  const newer = decideTriage(repository, {
    requestId: randomUUID(),
    taskId: task.id,
    expectedVersion: repository.task(task.id).version,
    action: 'investigate',
  });
  decideTriage(repository, {
    requestId: randomUUID(),
    taskId: task.id,
    expectedVersion: repository.task(task.id).version,
    action: 'repair',
  });
  assert.equal(
    repository.claim({ ...job, id: randomUUID(), token: randomUUID(), target: newer.id }, config),
    false,
    'An operator change while quota is loading must fence the stale claim.',
  );
  assert.equal(repository.capacity('codex', config).reservedTokens, 0);
});

await test('publication recovery does not replace its validated local head with an older remote PR snapshot', async (t) => {
  const context = fixture(t);
  const task = context.repository.tasks()[0];
  assert.ok(task !== undefined);
  const publishing = context.repository.editTask(task.id, (current) => {
    return {
      ...current,
      phase: 'publishing',
      head: 'validated-new-head',
      error: 'Transient publication failure',
    };
  });
  t.mock.method(context.remote, 'inspect', async () => {
    await delay(0);
    return {
      number: 3,
      url: task.prUrl ?? '',
      headRefOid: 'old',
      baseRefOid: 'base',
      baseRefName: 'main',
      isDraft: false,
      state: 'OPEN',
      mergeStateStatus: 'CLEAN',
      mergeCommit: null,
      statusCheckRollup: [],
    };
  });
  assert.equal(await hasParkedPRUpdate(context, publishing), false);
  assert.deepEqual(
    context.repository.task(task.id),
    publishing,
    'An unpaid publication retry must retain its validated local checkpoint.',
  );
});

/** A full lowercase commit identity named by the operator. */
const adopted = 'a'.repeat(40);

await test('operator adoption records an external merge for verification without implying QA approval', (t) => {
  const { repository } = fixture(t);
  const task = repository.tasks()[0];
  assert.ok(task !== undefined);
  const prepared = repository.editTask(task.id, (previous) => {
    return {
      ...previous,
      reviews: [{ role: 'qa-1', head: 'old', base: 'base', outcome: 'success', summary: 'Old', jobId: randomUUID() }],
      finalReview: { head: 'old', base: 'base', jobId: randomUUID(), summary: 'Old final' },
      verifiedMain: { head: 'base', jobId: randomUUID(), summary: 'Old proof' },
    };
  });
  const input = {
    requestId: randomUUID(),
    taskId: task.id,
    expectedVersion: prepared.version,
    action: 'adopt_merge',
    mergeCommit: adopted,
    note: 'Delivered by PRs #128 and #134.',
  };
  const receipt = decideTriage(repository, input);
  assert.equal(receipt.state, 'applied');
  assert.equal(receipt.action, 'adopt_merge');
  const current = repository.task(task.id);
  assert.equal(receipt.version, current.version);
  assert.equal(current.phase, 'verifying');
  assert.equal(current.merge, adopted);
  assert.deepEqual(current.reviews, []);
  assert.equal(current.finalReview, null);
  assert.equal(current.verifiedMain, null);
  assert.equal(current.attempts, 0);
  assert.equal(current.error, null);
  assert.deepEqual([current.head, current.base, current.pr], [task.head, task.base, task.pr]);
  const feedback = current.feedback.at(-1) ?? '';
  assert.ok(feedback.includes(`adopt_merge: adopted external merge ${adopted}`));
  assert.ok(feedback.includes('Delivered by PRs #128 and #134.'));
  assert.ok(feedback.includes('No factory QA approvals are implied'));
  assert.deepEqual(decideTriage(repository, input), receipt);
  assert.equal(repository.task(task.id).version, current.version, 'An exact replay must not reapply.');
  assert.throws(() => decideTriage(repository, { ...input, mergeCommit: 'b'.repeat(40) }), /identity/v);
});

await test('adoption rejects malformed commit input, other actions with a commit and managed agents', (t) => {
  const { repository } = fixture(t);
  const task = repository.tasks()[0];
  assert.ok(task !== undefined);
  const base = { taskId: task.id, expectedVersion: task.version, note: 'Adopt' };
  const invalid: unknown[] = [
    { ...base, requestId: randomUUID(), action: 'adopt_merge' },
    { ...base, requestId: randomUUID(), action: 'adopt_merge', mergeCommit: adopted, note: '' },
    { ...base, requestId: randomUUID(), action: 'adopt_merge', mergeCommit: adopted, note: ' '.repeat(3) },
    { ...base, requestId: randomUUID(), action: 'verify', mergeCommit: adopted },
    { ...base, requestId: randomUUID(), action: 'acknowledge', mergeCommit: adopted },
  ];
  for (const input of invalid) {
    assert.throws(() => decideTriage(repository, input), { code: 'INVALID_INPUT' });
  }
  for (const mergeCommit of ['A'.repeat(40), 'a'.repeat(39), 'a'.repeat(41), `${'a'.repeat(39)}g`, '']) {
    const input = { ...base, requestId: randomUUID(), action: 'adopt_merge', mergeCommit };
    assert.throws(() => parseInput('factory_triage', input), { code: 'INVALID_INPUT' });
    assert.throws(() => decideTriage(repository, input), /40-character/v);
  }
  assert.throws(
    () => {
      return decideTriage(
        repository,
        { ...base, requestId: randomUUID(), action: 'adopt_merge', mergeCommit: adopted },
        'agent',
      );
    },
    { code: 'NOT_ORCHESTRATOR' },
  );
  assert.deepEqual(triageStatus(repository), []);
  assert.deepEqual(repository.task(task.id), task, 'Rejected adoption must persist nothing.');
});

await test('an exact legacy empty-note adoption replays without authorizing another new empty decision', (t) => {
  const { repository } = fixture(t);
  const task = repository.tasks()[0];
  assert.ok(task !== undefined);
  const input = factorySchemas.factory_triage.parse({
    requestId: randomUUID(),
    taskId: task.id,
    expectedVersion: task.version,
    action: 'adopt_merge',
    mergeCommit: adopted,
    note: 'Initial fixture receipt.',
  });
  const receipt = decideTriage(repository, input);
  const legacyInput = { ...input, note: '' };
  const legacyReceipt = { ...receipt, note: '' };
  run(
    repository.store.db,
    'UPDATE factory_triage SET input=?,data=? WHERE id=?',
    JSON.stringify(legacyInput),
    JSON.stringify(legacyReceipt),
    input.requestId,
  );
  const { version } = repository.task(task.id);
  assert.deepEqual(decideTriage(repository, legacyInput), legacyReceipt);
  assert.equal(repository.task(task.id).version, version);
  assert.throws(() => decideTriage(repository, { ...legacyInput, note: 'Changed intent.' }), /identity/v);
  assert.throws(() => decideTriage(repository, { ...legacyInput, requestId: randomUUID() }), /Explain/v);
});

await test('adoption is gated for recorded merges, completed or superseded scopes, live claims and stale revisions', (t) => {
  const { repository } = fixture(t);
  const task = repository.tasks()[0];
  assert.ok(task !== undefined);
  const adopt = (expectedVersion: number): unknown => {
    return {
      requestId: randomUUID(),
      taskId: task.id,
      expectedVersion,
      action: 'adopt_merge',
      mergeCommit: adopted,
      note: 'Delivered externally; preserve the stage gate under test.',
    };
  };
  const merged = repository.editTask(task.id, (current) => ({ ...current, merge: 'c'.repeat(40) }));
  assert.throws(() => decideTriage(repository, adopt(merged.version)), { code: 'FACTORY_GATED', message: /verify/v });
  const open = repository.editTask(task.id, (current) => ({ ...current, merge: null }));
  assert.throws(() => decideTriage(repository, adopt(open.version - 1)), { code: 'FACTORY_GATED' });
  const done = repository.editTask(task.id, (current) => ({ ...current, phase: 'done' }));
  assert.throws(() => decideTriage(repository, adopt(done.version)), { code: 'FACTORY_GATED' });
  const superseded = repository.editTask(task.id, (current) => {
    return {
      ...current,
      phase: 'blocked',
      scopeReplacement: randomUUID(),
    };
  });
  assert.throws(() => decideTriage(repository, adopt(superseded.version)), { code: 'FACTORY_GATED' });
  const parked = repository.editTask(task.id, (current) => ({ ...current, scopeReplacement: undefined }));
  const investigation = decideTriage(repository, {
    requestId: randomUUID(),
    taskId: task.id,
    expectedVersion: parked.version,
    action: 'investigate',
  });
  const job = jobSchema.parse({
    id: randomUUID(),
    token: randomUUID(),
    role: 'team-lead',
    kind: 'triage',
    target: investigation.id,
    taskId: task.id,
    featureId: null,
    head: null,
    base: null,
    provider: 'codex',
    state: 'running',
    startedAt: 1,
    finishedAt: null,
    expiresAt: Date.now() + 1000,
    reservation: 0,
    usageTokens: null,
    pid: null,
    summary: null,
    artifact: 'fixture',
  });
  assert.equal(repository.claim(job, config), true);
  assert.throws(() => decideTriage(repository, adopt(parked.version)), {
    code: 'FACTORY_GATED',
    message: /assignment/v,
  });
  assert.equal(repository.task(task.id).merge, null);
  assert.ok(triageStatus(repository).every((decision) => decision.action !== 'adopt_merge'));
});
