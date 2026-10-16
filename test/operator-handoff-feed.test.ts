/**
 * Operator previews join real durable sources without inventing origin or acknowledging inboxes.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { run } from '../src/database.ts';
import { handoffFeed } from '../src/factory/handoff-feed.ts';
import { handoffSchema } from '../src/factory/handoffs.ts';
import { FactoryRepository } from '../src/factory/repository.ts';
import { factoryConfigSchema, jobSchema, taskSchema } from '../src/factory/schema.ts';
import { Store } from '../src/store.ts';

import { createCleanup, createProject } from './helpers.ts';

import type { MeshConfig } from '../src/config.ts';
import type { TestContext } from 'node:test';

/** Inert validation commands; tests never launch a provider. */
const settings = factoryConfigSchema.parse({
  testCommands: [{ file: process.execPath }],
  endToEndCommands: [{ file: process.execPath }],
});

/**
 * Create a real isolated SQLite ledger and peer identities.
 *
 * @param t - Owns cleanup.
 * @returns Scoped store and report/message helpers.
 */
function fixture(t: TestContext): {
  mesh: MeshConfig;
  clock: { now: number };
  store: Store;
  repository: FactoryRepository;
  report: (summary: string, taskId?: string) => string;
  message: (body: string) => ReturnType<Store['send']>;
} {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  const clock = { now: 1000 };
  const store = new Store(mesh, { now: () => clock.now });
  defer(() => {
    store.close();
  });
  const repository = new FactoryRepository(store);
  repository.configure(settings);
  const sender = store.register({
    name: 'factory-qa-1',
    secret: randomUUID(),
    sessionId: randomUUID(),
    role: 'qa-1',
    provider: 'fixture',
    runtime: 'test',
  }).id;
  const recipient = store.register({
    name: 'factory-developer-1',
    secret: randomUUID(),
    sessionId: randomUUID(),
    role: 'developer-1',
    provider: 'fixture',
    runtime: 'test',
  }).id;
  const report = (summary: string, taskId?: string): string => {
    const job = jobSchema.parse({
      id: randomUUID(),
      token: randomUUID(),
      role: 'qa-1',
      provider: 'codex',
      kind: 'review',
      taskId: taskId ?? null,
      featureId: null,
      head: null,
      base: null,
      state: 'running',
      startedAt: clock.now,
      expiresAt: clock.now + 60_000,
      finishedAt: null,
      reservation: 0,
      usageTokens: null,
      pid: null,
      summary: null,
      artifact: 'unused',
      routing: {
        tier: 'standard',
        model: null,
        reason: 'Fixture routing',
        skillNames: [],
        organization: { revision: 'fixture', type: 'general', label: 'QA', instructions: '', reportsTo: 'team-lead' },
      },
    });
    assert.equal(repository.claim(job, settings), true);
    assert.equal(
      repository.finishJob(job, 0, 'succeeded', { result: { outcome: 'changes_requested', summary, findings: [] } }),
      true,
    );
    return job.id;
  };
  const message = (body: string): ReturnType<Store['send']> =>
    store.transaction(() => store.send(sender, recipient, { body }));
  return { mesh, clock, store, repository, report, message };
}

await test('explicit manager provenance and peer conversations are distinct, stable and side-effect free', (t) => {
  const f = fixture(t);
  const peer = f.message('Manager report from imaginary-worker.');
  f.clock.now += 1;
  const jobId = f.report('Acceptance needs a stronger regression.');
  f.repository.instruct('team-lead', null, 'Manager report from another-imaginary-worker.');
  f.store.transaction(() => {
    f.store.event('GENERAL_ACTIVITY', null, { body: 'Not a handoff.' });
  });
  const before = f.store.db.prepare('SELECT total_changes() AS count').get();
  const feed = handoffFeed(f.store, f.mesh);
  assert.equal(feed.length, 2);
  const [report, message] = feed;
  assert.ok(report !== undefined && message !== undefined);
  assert.equal(report.kind, 'manager_report');
  assert.equal(report.sender, 'qa-1');
  assert.equal(report.recipient, 'team-lead');
  assert.equal(report.transport, 'factory_instruction');
  assert.equal(report.transportSender, null, 'Instruction transport never invents a broker sender.');
  assert.equal(report.assignment.jobId, jobId);
  assert.equal(report.outcome, 'changes_requested');
  assert.equal(report.processState, 'succeeded');
  assert.equal(report.verifiedDelivery, false);
  assert.equal(message.id, `message:${String(peer.seq)}`);
  assert.equal(message.kind, 'peer_message');
  assert.equal(message.sender, 'factory-qa-1', 'Prose cannot change a broker sender.');
  assert.equal(message.hasOriginEvidence, false);
  assert.deepEqual(handoffFeed(f.store, f.mesh), feed);
  assert.deepEqual(f.store.db.prepare('SELECT total_changes() AS count').get(), before);
  const inbox = f.store.db.prepare('SELECT acknowledged_at FROM messages WHERE id=?').get(peer.id);
  assert.equal(inbox?.['acknowledged_at'], null);
  const other = fixture(t);
  assert.deepEqual(handoffFeed(other.store, other.mesh), []);
});

await test('legacy and malformed metadata expose only factual associations, never guessed authorship', (t) => {
  const f = fixture(t);
  const jobId = f.report('Retained report.');
  const row = f.store.db.prepare('SELECT data FROM factory_handoffs WHERE job_id=?').get(jobId);
  const source = row?.['data'];
  assert.ok(typeof source === 'string');
  const valid = handoffSchema.parse(JSON.parse(source));
  for (const data of [
    '{}',
    'not json',
    'x'.repeat(64_001),
    JSON.stringify({ from: 'invented' }),
    JSON.stringify({ ...valid, jobId: randomUUID() }),
    JSON.stringify({ ...valid, to: 'product-owner' }),
    JSON.stringify({ ...valid, context: { ...valid.context, taskId: randomUUID() } }),
    JSON.stringify({ ...valid, context: { ...valid.context, issue: -1 } }),
    source.replace('"issue":null', '"issue":1e999'),
  ]) {
    run(f.store.db, 'UPDATE factory_handoffs SET data=? WHERE job_id=?', data, jobId);
    const [entry] = handoffFeed(f.store, f.mesh);
    assert.ok(entry !== undefined);
    assert.equal(entry.sender, null);
    assert.equal(entry.hasOriginEvidence, false);
    assert.equal(entry.recipient, 'team-lead');
    assert.equal(entry.assignment.jobId, jobId);
    assert.equal(entry.assignment.title, null);
    assert.equal(entry.outcome, null);
  }
});

await test('task-backed reports use the durable source job rather than the team-wide instruction task', (t) => {
  const f = fixture(t);
  const taskId = randomUUID();
  f.repository.addTask(
    taskSchema.parse({
      id: taskId,
      featureId: null,
      issue: 19,
      parentIssue: 17,
      key: 'task-backed-feed',
      title: 'Real delivery purpose',
      description: 'Fixture delivery.',
      acceptanceCriteria: ['Observable behavior.'],
      dependencies: [],
      phase: 'review',
      developer: 'developer-1',
      branch: null,
      worktree: null,
      head: null,
      base: null,
      pr: null,
      prUrl: null,
      merge: null,
      reviews: [],
      feedback: [],
      attempts: 1,
      version: 0,
      error: null,
      updatedAt: f.clock.now,
    }),
  );
  const jobId = f.report('Task review found a missing assertion.', taskId);
  const [entry] = handoffFeed(f.store, f.mesh);
  assert.ok(entry !== undefined);
  assert.equal(entry.hasOriginEvidence, true);
  assert.equal(entry.sender, 'qa-1');
  assert.equal(entry.assignment.taskId, taskId);
  assert.equal(entry.assignment.issue, 19);
  assert.equal(entry.assignment.title, 'Real delivery purpose');
  assert.equal(entry.summary, 'Task review found a missing assertion.');
  assert.equal(entry.outcome, 'changes_requested');
  const instruction = f.store.db
    .prepare(
      'SELECT task_id FROM factory_instructions WHERE id=(SELECT instruction_id FROM factory_handoffs WHERE job_id=?)',
    )
    .get(jobId);
  assert.equal(instruction?.['task_id'], null, 'Manager reporting remains team-wide.');
});

await test('the combined window is bounded, deterministically ordered and known secrets are redacted', (t) => {
  const f = fixture(t);
  for (let index = 0; index < 45; index += 1) {
    f.clock.now += 1;
    f.message(`Peer ${String(index)} ${f.mesh.token}`);
    f.report(`Report ${String(index)} ${f.mesh.token}`);
  }
  const feed = handoffFeed(f.store, f.mesh);
  assert.equal(feed.length, 40);
  assert.deepEqual(handoffFeed(f.store, f.mesh), feed);
  const identities = new Set(feed.map((entry) => entry.id));
  assert.equal(identities.size, 40);
  assert.ok(feed.every((entry, index) => index === 0 || entry.recordedAt <= (feed[index - 1]?.recordedAt ?? 0)));
  assert.ok(!JSON.stringify(feed).includes(f.mesh.token));
  assert.ok(JSON.stringify(feed).includes('[REDACTED]'));
});

await test('projection bounds Unicode text and every newly exposed name or context field', (t) => {
  const f = fixture(t);
  f.message(`${'a'.repeat(3999)}🌾${f.mesh.token}`);
  const jobId = f.report('Original summary.');
  const record = f.store.db.prepare('SELECT data FROM factory_handoffs WHERE job_id=?').get(jobId);
  const body = record?.['data'];
  assert.ok(typeof body === 'string');
  const metadata = handoffSchema.parse(JSON.parse(body));
  run(f.store.db, "UPDATE factory_jobs SET data=json_set(data,'$.taskId',?) WHERE id=?", f.mesh.token, jobId);
  run(
    f.store.db,
    'UPDATE factory_instructions SET task_id=? WHERE id=(SELECT instruction_id FROM factory_handoffs WHERE job_id=?)',
    f.mesh.token,
    jobId,
  );
  run(
    f.store.db,
    'UPDATE factory_handoffs SET data=? WHERE job_id=?',
    JSON.stringify({
      ...metadata,
      from: f.mesh.token,
      context: {
        taskId: f.mesh.token,
        issue: 7,
        title: { text: f.mesh.token, truncated: false },
        featureId: f.mesh.token,
        objective: null,
      },
      summary: { text: `${'b'.repeat(4000)}${f.mesh.token}`, truncated: true },
    }),
    jobId,
  );
  const feed = handoffFeed(f.store, f.mesh);
  assert.ok(!JSON.stringify(feed).includes(f.mesh.token));
  assert.ok(feed.every((entry) => entry.body.length <= 4000 && (entry.summary?.length ?? 0) <= 4000));
  assert.ok(feed.every((entry) => entry.truncated));
  const report = feed.find((entry) => entry.kind === 'manager_report');
  assert.equal(report?.hasOriginEvidence, true, 'The redaction fixture retains a matching durable association.');
  const peer = feed.find((entry) => entry.kind === 'peer_message');
  assert.ok(peer !== undefined);
  assert.equal(peer.body.length, 3999);
  assert.equal(peer.body.isWellFormed(), true);
});
