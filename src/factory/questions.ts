/**
 * Questions from managed agents to the operator. An agent that cannot go on
 * without a human decision asks one bounded question through
 * `mesh_factory_ask` and ends its turn. The supervisor sets that attempt's
 * result aside without counting it against the delivery, holds the step
 * while the question is open, and runs the step again once the operator has
 * answered, with every answer for that step in the new assignment's context.
 *
 * Questions are bound to the step (delivery or objective, plus step id), so
 * a later attempt of the same step sees earlier answers, and a different
 * step is never held by them. Asking is idempotent per attempt and key;
 * answering is idempotent per request id and happens at most once.
 *
 * @file
 */
import { randomUUID } from 'node:crypto';

import { z } from 'zod/v3';

import { run, selectAll } from '../database.ts';
import { MeshError } from '../protocol.ts';
import { SecretRedactor } from '../secrets.ts';

import { credentialValues } from './authentication.ts';
import { canAsk } from './organization.ts';
import { answerSchema, askSchema, questionSchema } from './question-schema.ts';
import { managedSourceJob } from './source-reader.ts';

import type { Store } from '../store.ts';
import type { FactoryContext } from './context.ts';
import type { Question } from './question-schema.ts';
import type { FactoryRepository } from './repository.ts';
import type { FactoryJob } from './schema.ts';

/** Open questions one delivery or objective may hold at once. */
export const MAX_OPEN_QUESTIONS = 3;
/** Questions kept per step; a step that needs more should be re-planned. */
export const MAX_STEP_QUESTIONS = 20;
/** Answered questions listed in the status snapshot. */
const ANSWERED_SHOWN = 20;
/** Assignment kinds that work on a delivery or an objective, and so may ask. */
const ASKING_KINDS: ReadonlySet<string> = new Set([
  'plan',
  'refine',
  'plan_review',
  'develop',
  'review',
  'adjudicate',
  'document',
  'regress',
  'final',
  'verify',
]);
/** Stored row payload. */
const rowSchema = z.object({ data: z.string() });

/** What a step is: its delivery or objective and the step it runs. */
interface StepScope {
  /** Delivery, if any. */
  readonly taskId: string | null;
  /** Objective, if any. */
  readonly featureId: string | null;
  /** Workflow step id, or the kind for attempts saved before workflows. */
  readonly step?: string | null;
  /** Assignment kind. */
  readonly kind: string;
}

/**
 * The stable key of the step a job or intent runs.
 *
 * @param scope - Job or scheduling intent.
 * @returns Key shared by every attempt of that step.
 */
function scopeKey(scope: StepScope): string {
  return `${scope.taskId ?? ''}|${scope.taskId === null ? (scope.featureId ?? '') : ''}|${scope.step ?? scope.kind}`;
}

/**
 * The delivery or objective a question counts against, so its open questions stay bounded.
 *
 * @param scope - Job or question.
 * @returns Its delivery id, or a key naming its objective.
 */
function ownerKey(scope: Pick<StepScope, 'taskId' | 'featureId'>): string {
  return scope.taskId ?? `objective:${scope.featureId ?? ''}`;
}

/**
 * Ensure the additive question table exists.
 *
 * @param store - Selected project's SQLite owner.
 */
function ensureTable(store: Store): void {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS factory_questions (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, scope TEXT NOT NULL, owner TEXT NOT NULL, open INTEGER NOT NULL, asked_at INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS factory_questions_by_scope ON factory_questions (scope, asked_at);
    CREATE INDEX IF NOT EXISTS factory_questions_by_job ON factory_questions (job_id);
  `);
}

/**
 * Read questions matching a filter, oldest first.
 *
 * @param store - Selected project's SQLite owner.
 * @param where - SQL condition on the question table.
 * @param values - Bound values.
 * @returns Validated questions.
 */
function select(store: Store, where: string, ...values: (string | number)[]): Question[] {
  ensureTable(store);
  return selectAll(
    store.db,
    rowSchema,
    `SELECT data FROM factory_questions WHERE ${where} ORDER BY asked_at, rowid`,
    ...values,
  ).map((row) => questionSchema.parse(JSON.parse(row.data)));
}

/**
 * Write a question.
 *
 * @param store - Selected project's SQLite owner.
 * @param question - Validated question.
 */
function put(store: Store, question: Question): void {
  ensureTable(store);
  run(
    store.db,
    'INSERT INTO factory_questions VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET open=excluded.open, data=excluded.data',
    question.id,
    question.jobId,
    scopeKey({ ...question, step: question.stepId }),
    ownerKey(question),
    question.answer === null ? 1 : 0,
    question.askedAt,
    JSON.stringify(questionSchema.parse(question)),
  );
}

/**
 * Check that the asking session still owns a live claim on a delivery or objective step.
 *
 * @param context - Project services.
 * @param job - Claim found for the session.
 * @throws {MeshError} For a stale claim or an assignment that cannot ask.
 */
function assertCanAsk(context: FactoryContext, job: FactoryJob): void {
  const current = context.repository.jobs().find((candidate) => candidate.id === job.id);
  if (
    current?.state !== 'running' ||
    current.token !== job.token ||
    current.expiresAt <= context.repository.store.now()
  ) {
    throw new MeshError('FACTORY_GATED', 'This session no longer owns a live assignment.');
  }
  if (!ASKING_KINDS.has(job.kind) || (job.taskId === null && job.featureId === null)) {
    throw new MeshError('FACTORY_GATED', 'Only assignments on a delivery or an objective may ask the operator.');
  }
  if (!canAsk(job.routing?.organization?.permissions)) {
    throw new MeshError('TOOL_DENIED', 'This role type may not ask the operator questions.');
  }
}

/**
 * Record a managed agent's question about its current step.
 *
 * @param context - Project ledger and credential boundary.
 * @param input - Untrusted question.
 * @param actorId - Authenticated managed session.
 * @returns The question id and what the agent should do next.
 * @throws {MeshError} For an invalid question, a stale claim, a changed retry, a second question or too many open questions.
 */
export function askQuestion(
  context: FactoryContext,
  input: unknown,
  actorId: string | null,
): { questionId: string; state: 'open' | 'answered'; next: string } {
  const value = askSchema.parse(input);
  if (!value.allowText && value.choices.length === 0) {
    throw new MeshError('INVALID_INPUT', 'Offer at least one choice or allow a written answer.');
  }
  const distinct = new Set(value.choices);
  if (distinct.size !== value.choices.length) {
    throw new MeshError('INVALID_INPUT', 'Choices must be distinct.');
  }
  const job = managedSourceJob(context, actorId);
  const redactor = new SecretRedactor([context.mesh.token, ...credentialValues(process.env)]);
  const question = redactor.redact(value.question);
  // Redacted once, so an identical retry compares against exactly what was stored.
  const choices = value.choices.map((choice) => redactor.redact(choice));
  const next =
    'End this assignment now with outcome "blocked" and the question as your summary. This step runs again with the answer.';
  const { store } = context.repository;
  const asked = store.transaction(() => {
    assertCanAsk(context, job);
    const own = select(store, 'job_id=?', job.id);
    const previous = own.find((candidate) => candidate.key === value.key);
    if (previous !== undefined) {
      if (previous.question !== question || JSON.stringify(previous.choices) !== JSON.stringify(choices)) {
        throw new MeshError('INVALID_INPUT', 'That question key already identifies a different question.');
      }
      return previous;
    }
    if (own.length > 0) {
      throw new MeshError('FACTORY_GATED', 'This assignment already asked a question. End it and wait for the answer.');
    }
    if (select(store, 'owner=? AND open=1', ownerKey(job)).length >= MAX_OPEN_QUESTIONS) {
      throw new MeshError(
        'FACTORY_GATED',
        `This work already has ${String(MAX_OPEN_QUESTIONS)} open questions. End the assignment and wait.`,
      );
    }
    if (select(store, 'scope=?', scopeKey(job)).length >= MAX_STEP_QUESTIONS) {
      throw new MeshError('FACTORY_GATED', 'This step has asked too many questions; return blocked instead.');
    }
    const created: Question = {
      id: randomUUID(),
      key: value.key,
      jobId: job.id,
      role: job.role,
      kind: job.kind,
      taskId: job.taskId,
      featureId: job.featureId,
      stepId: job.step ?? null,
      question,
      choices,
      allowText: value.allowText,
      askedAt: store.now(),
      answer: null,
    };
    put(store, created);
    store.event('FACTORY_QUESTION_ASKED', null, { questionId: created.id, jobId: job.id, role: job.role });
    context.repository.notify(`${job.role} asks: ${question}`);
    return created;
  });
  return { questionId: asked.id, state: asked.answer === null ? 'open' : 'answered', next };
}

/**
 * Record the operator's answer exactly once.
 *
 * @param repository - Selected project ledger.
 * @param input - Untrusted answer.
 * @returns `answered`, or `repeated` for a retried request.
 * @throws {MeshError} For an empty answer, an unknown or already answered question, or a choice it did not offer.
 */
export function answerQuestion(repository: FactoryRepository, input: unknown): { result: 'answered' | 'repeated' } {
  const value = answerSchema.parse(input);
  if (value.choice === null && value.text.length === 0) {
    throw new MeshError('INVALID_INPUT', 'Choose an option or write an answer.');
  }
  const { store } = repository;
  return store.transaction(() => {
    const [question] = select(store, 'id=?', value.questionId);
    if (question === undefined) {
      throw new MeshError('NOT_FOUND', 'No question with that ID in this project.');
    }
    if (question.answer !== null) {
      if (question.answer.requestId === value.requestId) {
        return { result: 'repeated' as const };
      }
      throw new MeshError('FACTORY_GATED', 'That question was already answered. Refresh to see the answer.');
    }
    if (value.choice !== null && !question.choices.includes(value.choice)) {
      throw new MeshError('INVALID_INPUT', 'Choose one of the offered options.');
    }
    if (value.text.length > 0 && !question.allowText) {
      throw new MeshError('INVALID_INPUT', 'This question accepts only one of its choices.');
    }
    put(store, {
      ...question,
      answer: { requestId: value.requestId, choice: value.choice, text: value.text, at: store.now() },
    });
    store.event('FACTORY_QUESTION_ANSWERED', null, { questionId: question.id });
    return { result: 'answered' as const };
  });
}

/**
 * The question an attempt asked, if it asked one.
 *
 * @param store - Selected project's SQLite owner.
 * @param jobId - Attempt identifier.
 * @returns Its question, open or answered.
 */
export function questionAskedBy(store: Store, jobId: string): Question | undefined {
  return select(store, 'job_id=?', jobId)[0];
}

/**
 * Set an attempt's result aside when it asked the operator a question: the
 * step is held until the answer and then runs again, and the attempt does not
 * count against the delivery.
 *
 * @param repository - Selected project ledger.
 * @param job - Settling assignment.
 * @param attempt - Its accumulated outcome, marked when it waits for an answer.
 * @returns True when the attempt asked a question.
 */
export function didAskOperator(
  repository: FactoryRepository,
  job: FactoryJob,
  attempt: { state: 'succeeded' | 'failed' | 'interrupted'; isAwaitingAnswer?: boolean },
): boolean {
  const question = questionAskedBy(repository.store, job.id);
  if (question === undefined) {
    return false;
  }
  const outcome = attempt;
  outcome.isAwaitingAnswer = true;
  outcome.state = 'succeeded';
  const current = repository.jobs().find((candidate) => candidate.id === job.id);
  if (current?.state === 'running' && current.token === job.token) {
    repository.saveJob({ ...current, summary: `Waiting for the operator's answer: ${question.question}` });
  }
  return true;
}

/**
 * Whether a step waits for an answer and so must not start again yet.
 *
 * @param store - Selected project's SQLite owner.
 * @param intent - Step about to be scheduled.
 * @returns True while one of its questions is open.
 */
export function isAwaitingAnswer(store: Store, intent: StepScope): boolean {
  return (
    (intent.taskId !== null || intent.featureId !== null) &&
    select(store, 'scope=? AND open=1', scopeKey(intent)).length > 0
  );
}

/**
 * Answers the operator gave this step, oldest first, for the next assignment's context.
 *
 * @param store - Selected project's SQLite owner.
 * @param job - Assignment about to run.
 * @returns Question and answer pairs.
 */
export function stepAnswers(
  store: Store,
  job: StepScope,
): { question: string; choices: string[]; choice: string | null; answer: string; answeredAt: number }[] {
  if (job.taskId === null && job.featureId === null) {
    return [];
  }
  return select(store, 'scope=? AND open=0', scopeKey(job)).map((question) => {
    return {
      question: question.question,
      choices: question.choices,
      choice: question.answer?.choice ?? null,
      answer: question.answer?.text ?? '',
      answeredAt: question.answer?.at ?? 0,
    };
  });
}

/**
 * Open questions and recent answers for the status snapshot.
 *
 * @param store - Selected project's SQLite owner.
 * @returns Open questions, oldest first, and answered ones, newest first.
 */
export function questionsStatus(store: Store): { open: Question[]; answered: Question[] } {
  return {
    open: select(store, 'open=1'),
    answered: select(store, 'open=0').toReversed().slice(0, ANSWERED_SHOWN),
  };
}
