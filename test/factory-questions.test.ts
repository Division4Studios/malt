/**
 * Agent questions: a managed attempt asks the operator, its result is set
 * aside without counting against the delivery, the step is held until the
 * answer, and the next attempt of that step receives every answer.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { startBroker } from '../src/broker.ts';
import { AgentClient } from '../src/client.ts';
import { consoleView } from '../src/factory/console-view.ts';
import { refundUnpaidAttempt } from '../src/factory/controls.ts';
import { canAsk } from '../src/factory/organization.ts';
import { assignmentPrompt } from '../src/factory/prompts.ts';
import {
  MAX_OPEN_QUESTIONS,
  MAX_STEP_QUESTIONS,
  didAskOperator,
  isAwaitingAnswer,
  questionAskedBy,
  stepAnswers,
} from '../src/factory/questions.ts';
import { factoryConfigSchema, jobSchema, taskSchema } from '../src/factory/schema.ts';
import { FactoryService } from '../src/factory/service.ts';
import { ProjectGitHub } from '../src/github.ts';
import { ProjectLearning } from '../src/learning.ts';
import { Store } from '../src/store.ts';

import { brokerUrl, createCleanup, createProject, registration, updateConfig } from './helpers.ts';

import type { MeshConfig } from '../src/config.ts';
import type { FactoryConfig, FactoryJob, FactoryTask } from '../src/factory/schema.ts';
import type { TestContext } from 'node:test';

/** A supervisor with a configured project and one delivery. */
interface Fixture {
  readonly factory: FactoryService;
  readonly store: Store;
  readonly settings: FactoryConfig;
  readonly task: FactoryTask;
  readonly mesh: MeshConfig;
}

/**
 * A configured supervisor whose project has one ready delivery.
 *
 * @param t - Owns cleanup.
 * @returns Supervisor, store, settings and delivery.
 */
function fixture(t: TestContext): Fixture {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  const store = new Store(mesh);
  const factory = new FactoryService(
    mesh,
    store,
    { github: new ProjectGitHub(mesh), learning: new ProjectLearning(mesh) },
    { home: mesh.root },
  );
  defer(async () => {
    await factory.close();
    store.close();
  });
  const settings = factoryConfigSchema.parse({
    testCommands: [{ file: process.execPath }],
    endToEndCommands: [{ file: process.execPath }],
    resources: { maxActiveJobs: 4 },
  });
  factory.repository.configure(settings);
  factory.repository.prepareSender();
  factory.repository.setActive(true);
  const task = taskSchema.parse({
    id: randomUUID(),
    featureId: null,
    issue: 4,
    parentIssue: 1,
    key: 'ask',
    title: 'Pick a storage format',
    description: 'Needs a human choice.',
    acceptanceCriteria: ['The format is documented.'],
    dependencies: [],
    phase: 'ready',
    developer: null,
    branch: null,
    worktree: null,
    head: null,
    base: null,
    pr: null,
    prUrl: null,
    merge: null,
    reviews: [],
    feedback: [],
    attempts: 0,
    version: 0,
    error: null,
    updatedAt: Date.now(),
  });
  factory.repository.addTask(task);
  return { factory, store, settings, task, mesh };
}

/**
 * Claim a running developer attempt on the fixture delivery.
 *
 * @param f - Fixture.
 * @param step - Workflow step the attempt runs.
 * @returns The claimed attempt.
 */
function claimDeveloper(f: Fixture, step = 'implement'): FactoryJob {
  const job = jobSchema.parse({
    id: randomUUID(),
    role: 'developer-1',
    provider: 'codex',
    kind: 'develop',
    taskId: f.task.id,
    featureId: null,
    step,
    token: randomUUID(),
    state: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    expiresAt: Date.now() + 60_000,
    reservation: 0,
    usageTokens: null,
    pid: null,
    head: null,
    base: null,
    summary: null,
    artifact: f.mesh.directory,
  });
  assert.equal(f.factory.repository.claim(job, f.settings), true);
  return job;
}

/**
 * The scheduling intent for one step of the fixture delivery.
 *
 * @param f - Fixture.
 * @param step - Step the intent would run.
 * @returns Intent fields questions are matched on.
 */
function implementIntent(f: Fixture, step = 'implement'): Parameters<typeof isAwaitingAnswer>[1] {
  return { taskId: f.task.id, featureId: null, step, kind: 'develop' };
}

/**
 * The open question an attempt asked.
 *
 * @param store - Project store.
 * @param job - Asking attempt.
 * @returns Its question id.
 */
function questionId(store: Store, job: FactoryJob): string {
  const question = questionAskedBy(store, job.id);
  assert.ok(question !== undefined);
  return question.id;
}

await test('a managed question holds its step, sets the attempt aside and returns with the answer', async (t) => {
  const f = fixture(t);
  const { factory, store } = f;
  const actor = store.register({ ...registration('factory-developer-1'), runtime: 'factory-managed' });
  const job = claimDeveloper(f);
  assert.equal(factory.repository.task(f.task.id).attempts, 1);
  const ask = {
    key: 'format',
    question: `JSON or SQLite for the export? Secret: ${f.mesh.token}`,
    choices: ['JSON', 'SQLite'],
    allowText: true,
  };
  const asked = await factory.execute('factory_ask', ask, actor.id);
  assert.deepEqual(
    await factory.execute('factory_ask', ask, actor.id),
    asked,
    'a retry with the same key deduplicates',
  );
  await assert.rejects(factory.execute('factory_ask', { ...ask, question: 'Something else?' }, actor.id), {
    code: 'INVALID_INPUT',
  });
  await assert.rejects(factory.execute('factory_ask', { ...ask, key: 'second' }, actor.id), { code: 'FACTORY_GATED' });
  await assert.rejects(
    factory.execute('factory_ask', { ...ask, key: 'none', choices: [], allowText: false }, actor.id),
    {
      code: 'INVALID_INPUT',
    },
  );
  await assert.rejects(factory.execute('factory_ask', ask), { code: 'FACTORY_GATED' }, 'unmanaged callers cannot ask');
  const question = questionAskedBy(store, job.id);
  assert.ok(question !== undefined);
  assert.ok(!question.question.includes(f.mesh.token), 'secrets are redacted before storage');
  assert.equal(isAwaitingAnswer(store, implementIntent(f)), true);
  assert.equal(isAwaitingAnswer(store, implementIntent(f, 'document')), false, 'other steps are not held');

  const attempt: { state: 'succeeded' | 'failed' | 'interrupted'; isAwaitingAnswer?: boolean } = { state: 'failed' };
  assert.equal(didAskOperator(factory.repository, job, attempt), true);
  assert.deepEqual(attempt, { state: 'succeeded', isAwaitingAnswer: true });
  assert.match(
    factory.repository.jobs().find((candidate) => candidate.id === job.id)?.summary ?? '',
    /operator's answer/v,
  );
  const hasSettled = factory.repository.finishJob(job, 0, attempt.state);
  refundUnpaidAttempt(factory.repository, job, { hasSettled, isUnpaidGate: true, state: attempt.state });
  assert.equal(factory.repository.task(f.task.id).attempts, 0, 'asking does not spend a delivery attempt');

  const item = consoleView(factory.repository).inbox.open.find((candidate) => candidate.kind === 'question');
  assert.ok(item !== undefined);
  assert.equal(item.lane, 'reply');
  assert.equal(item.questionId, question.id);
  assert.deepEqual(item.choices, ['JSON', 'SQLite']);

  const requestId = randomUUID();
  await assert.rejects(factory.execute('factory_answer', { questionId: question.id, requestId }), {
    code: 'INVALID_INPUT',
  });
  await assert.rejects(factory.execute('factory_answer', { questionId: question.id, requestId, choice: 'YAML' }), {
    code: 'INVALID_INPUT',
  });
  const answer = { questionId: question.id, requestId, choice: 'SQLite', text: 'Keep one file per project.' };
  assert.deepEqual(await factory.execute('factory_answer', answer), { result: 'answered' });
  assert.deepEqual(await factory.execute('factory_answer', answer), { result: 'repeated' });
  await assert.rejects(factory.execute('factory_answer', { ...answer, requestId: randomUUID() }), {
    code: 'FACTORY_GATED',
  });
  assert.equal(isAwaitingAnswer(store, implementIntent(f)), false, 'the step may run again');

  const next = claimDeveloper(f);
  const answers = stepAnswers(store, next);
  assert.equal(answers.length, 1);
  const [first] = answers;
  assert.ok(first !== undefined);
  assert.equal(first.choice, 'SQLite');
  assert.equal(first.answer, 'Keep one file per project.');
  assert.equal(didAskOperator(factory.repository, next, { state: 'succeeded' }), false);
  const prompt = assignmentPrompt({
    job: next,
    task: factory.repository.task(f.task.id),
    feature: null,
    skill: null,
    standards: [],
    evidence: { answers },
  });
  assert.match(prompt, /mesh_factory_ask/v);
  assert.match(prompt, /Keep one file per project/v);
  const { inbox } = consoleView(factory.repository);
  assert.ok(inbox.open.every((candidate) => candidate.kind !== 'question'));
  assert.match(inbox.answered[0]?.note ?? '', /SQLite — Keep one file per project/v);
});

await test('a role type without inbox.ask cannot ask, and its prompt omits the question rule', async (t) => {
  const f = fixture(t);
  const { factory, store } = f;
  const actor = store.register({ ...registration('factory-developer-1'), runtime: 'factory-managed' });
  const job = claimDeveloper(f);
  const organization = { revision: 'r', type: 'builder', label: 'Builder', instructions: '', reportsTo: null };
  factory.repository.saveJob({
    ...job,
    routing: {
      tier: 'standard',
      model: null,
      reason: 'Test.',
      skillNames: [],
      organization: { ...organization, permissions: [] },
    },
  });
  const ask = { key: 'q', question: 'May I?', choices: ['Yes'], allowText: false };
  await assert.rejects(factory.execute('factory_ask', ask, actor.id), { code: 'TOOL_DENIED' });
  assert.equal(canAsk([]), false);
  assert.equal(canAsk(['inbox.ask']), true);
  assert.equal(canAsk(undefined), true, 'attempts frozen before roles keep the question tool');
});

await test('open questions per delivery and questions per step are bounded', async (t) => {
  const f = fixture(t);
  const { factory, store } = f;
  const actor = store.register({ ...registration('factory-developer-1'), runtime: 'factory-managed' });
  const ask = { key: 'q', question: 'Which option?', choices: ['A', 'B'] };
  const asking: FactoryJob[] = [];
  for (let index = 0; index < MAX_OPEN_QUESTIONS; index += 1) {
    const job = claimDeveloper(f, `step-${String(index)}`);
    await factory.execute('factory_ask', ask, actor.id);
    factory.repository.finishJob(job, 0, 'succeeded');
    asking.push(job);
  }
  const extra = claimDeveloper(f, 'step-extra');
  await assert.rejects(factory.execute('factory_ask', ask, actor.id), { code: 'FACTORY_GATED' });
  factory.repository.finishJob(extra, 0, 'succeeded');
  for (const job of asking) {
    await factory.execute('factory_answer', {
      questionId: questionId(store, job),
      requestId: randomUUID(),
      choice: 'A',
    });
  }
  // step-0 already holds one answered question; fill it to the per-step bound.
  for (let index = 1; index < MAX_STEP_QUESTIONS; index += 1) {
    const job = claimDeveloper(f, 'step-0');
    await factory.execute('factory_ask', ask, actor.id);
    await factory.execute('factory_answer', {
      questionId: questionId(store, job),
      requestId: randomUUID(),
      choice: 'B',
    });
    factory.repository.finishJob(job, 0, 'succeeded');
  }
  const limit = claimDeveloper(f, 'step-0');
  assert.equal(stepAnswers(store, limit).length, MAX_STEP_QUESTIONS);
  await assert.rejects(factory.execute('factory_ask', ask, actor.id), { code: 'FACTORY_GATED' });
});

await test('only the operator answers questions or changes gates through the broker', async (t) => {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  const broker = await startBroker(mesh, { port: 0 });
  defer(async () => broker.close());
  const connected = updateConfig(mesh, { url: brokerUrl(broker.port) });
  const lead = new AgentClient(connected, { name: 'attached-lead', role: 'lead' });
  await lead.connect();
  defer(async () => lead.close());
  await assert.rejects(
    lead.call('factory_answer', { questionId: randomUUID(), requestId: randomUUID(), choice: 'A' }),
    { code: 'NOT_ORCHESTRATOR' },
  );
  await assert.rejects(lead.call('factory_gates', { featureId: randomUUID(), plan: true }), {
    code: 'NOT_ORCHESTRATOR',
  });
  await assert.rejects(lead.call('factory_ask', { key: 'q', question: 'May I?' }), { code: 'FACTORY_GATED' });
});
