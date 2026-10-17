/**
 * Durable, revision-fenced blocker decisions and bounded lead investigations.
 *
 * @file
 */
import { randomUUID } from 'node:crypto';

import { z } from 'zod/v3';

import { run, selectAll, selectOne } from '../database.ts';
import { MeshError } from '../protocol.ts';

import { OPERATOR_ADOPTED } from './adoption-schema.ts';
import { approvePublicationSize } from './publication-size.ts';
import { factorySchemas } from './schema.ts';

import type { FactoryRepository } from './repository.ts';
import type { AgentResult, FactoryJob, FactoryTask } from './schema.ts';

/** Bounded operator-visible decision history. */
const HISTORY = 100;
/** Validate persisted decision data before exposing it. */
const decisionSchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  version: z.number(),
  action: factorySchemas.factory_triage.shape.action,
  state: z.enum(['acknowledged', 'queued', 'awaiting_operator', 'applied', 'stale', 'failed']),
  note: z.string(),
  summary: z.string(),
  createdAt: z.number(),
});
/** Database JSON boundary. */
const rowSchema = z.object({ data: z.string() });
/** One durable operator decision. */
export type TriageDecision = z.output<typeof decisionSchema>;
/** GitHub and main evidence re-read before an operator adopts a delivered issue. */
export interface DeliveredEvidence {
  /** Fetched main head at adoption. */
  readonly head: string;
  /** Merge commit contained in that head, or null when none is supplied or recorded. */
  readonly merge: string | null;
  /** GitHub close reason; completed unless closed without delivery. */
  readonly reason: string;
  /** False when the issue was closed as not planned or duplicate. */
  readonly isDelivered: boolean;
}

/**
 * Read bounded project-local decisions.
 *
 * @param repository - Project ledger.
 * @returns Recent decisions.
 */
export function triageStatus(repository: FactoryRepository): TriageDecision[] {
  return selectAll(
    repository.store.db,
    rowSchema,
    `SELECT data FROM factory_triage ORDER BY rowid DESC LIMIT ${String(HISTORY)}`,
  ).map((row) => decisionSchema.parse(JSON.parse(row.data)));
}

/**
 * Resolve an exact durable decision without treating a bounded UI history as authority.
 *
 * @param repository - Project ledger.
 * @param id - Claimed decision identity.
 * @returns Exact receipt or absent.
 */
export function decisionById(repository: FactoryRepository, id: string | null): TriageDecision | undefined {
  const row = selectOne(repository.store.db, rowSchema, 'SELECT data FROM factory_triage WHERE id=?', id);
  return row === undefined ? undefined : decisionSchema.parse(JSON.parse(row.data));
}

/**
 * Schedule the oldest pending decisions, independently of newer visible history.
 *
 * @param repository - Selected project ledger.
 * @param focus - Explicit objective focus, if any.
 * @returns Bounded eligible pending queue.
 */
export function pendingTriage(repository: FactoryRepository, focus: string | null): TriageDecision[] {
  return selectAll(
    repository.store.db,
    rowSchema,
    `SELECT factory_triage.data AS data FROM factory_triage JOIN factory_tasks ON factory_tasks.id=factory_triage.task_id WHERE json_extract(factory_triage.data,'$.state')='queued' AND (? IS NULL OR json_extract(factory_tasks.data,'$.featureId')=?) ORDER BY factory_triage.rowid LIMIT ${String(HISTORY)}`,
    focus,
    focus,
  ).map((row) => decisionSchema.parse(JSON.parse(row.data)));
}

/**
 * Apply or replay one exact operator decision.
 *
 * @param repository - Project ledger.
 * @param input - Untrusted control.
 * @param actorId - Attached agent identity; null denotes the operator or supervisor.
 * @param evidence - Re-read GitHub and main evidence, required only for adopt_delivered.
 * @returns Durable receipt.
 * @throws {MeshError} When the request is stale, changed or not actionable.
 */
export function decideTriage(
  repository: FactoryRepository,
  input: unknown,
  actorId: string | null = null,
  evidence?: DeliveredEvidence,
): TriageDecision {
  const value = factorySchemas.factory_triage.parse(input);
  assertControl(value, actorId);
  const isAdoption = isAdoptionAction(value);
  return repository.store.transaction(() => {
    const prior = selectOne(
      repository.store.db,
      z.object({ input: z.string(), data: z.string() }),
      'SELECT input,data FROM factory_triage WHERE id=?',
      value.requestId,
    );
    if (prior !== undefined) {
      if (prior.input !== JSON.stringify(value)) {
        throw new MeshError('INVALID_INPUT', 'Decision identity was reused with different content.');
      }
      return decisionSchema.parse(JSON.parse(prior.data));
    }
    if (isAdoption && value.note === '') {
      throw new MeshError('INVALID_INPUT', 'Explain why this external merge delivers the issue before adoption.');
    }
    const task = repository.task(value.taskId);
    if (task.version !== value.expectedVersion || task.scopeReplacement !== undefined || task.phase === 'done') {
      throw new MeshError('FACTORY_GATED', 'The delivery changed. Refresh its evidence before deciding.');
    }
    if (repository.jobs().some((job) => job.taskId === task.id && job.state === 'running')) {
      throw new MeshError(
        'FACTORY_GATED',
        'An assignment owns this delivery. Cancel it safely before changing its disposition.',
      );
    }
    const decision: TriageDecision = {
      id: value.requestId,
      taskId: task.id,
      version: task.version,
      action: value.action,
      state: value.action === 'investigate' ? 'queued' : 'acknowledged',
      note: value.note,
      summary: '',
      createdAt: repository.store.now(),
    };
    if (didApplyOperatorAction(repository, value, evidence)) {
      decision.state = 'applied';
      decision.version = repository.task(task.id).version;
    }
    if (['repair', 'review', 'verify', 'wait'].includes(value.action)) {
      applyDisposition(repository, value);
      decision.state = value.action === 'wait' ? 'awaiting_operator' : 'applied';
      decision.version = repository.task(task.id).version;
    }
    run(
      repository.store.db,
      'INSERT INTO factory_triage VALUES(?,?,?,?,?)',
      value.requestId,
      task.id,
      decision.version,
      JSON.stringify(value),
      JSON.stringify(decision),
    );
    repository.store.event('FACTORY_TRIAGE_DECIDED', null, decision);
    return decision;
  });
}

/** Validated operator mutation. */
type Input = z.output<typeof factorySchemas.factory_triage>;

/**
 * Whether a decision adopts external or delivered work.
 *
 * @param value - Validated decision.
 * @returns Whether it is an operator-only adoption.
 */
function isAdoptionAction(value: Input): boolean {
  return value.action === 'adopt_merge' || value.action === 'adopt_delivered';
}

/**
 * Reject malformed commit fields and agent attempts at operator-only actions.
 *
 * @param value - Validated decision.
 * @param actorId - Attached agent identity; null denotes the operator or supervisor.
 * @throws {MeshError} For an invalid commit field or an agent caller.
 */
function assertControl(value: Input, actorId: string | null): void {
  const isAdoption = isAdoptionAction(value);
  if (value.mergeCommit === undefined ? value.action === 'adopt_merge' : !isAdoption) {
    throw new MeshError('INVALID_INPUT', 'mergeCommit is required for adopt_merge and accepted only by adoptions.');
  }
  if (actorId !== null && value.action === 'approve_size') {
    throw new MeshError('NOT_ORCHESTRATOR', 'Only the human operator may approve a publication size exception.');
  }
  if (actorId !== null && isAdoption) {
    throw new MeshError('NOT_ORCHESTRATOR', 'Only the human operator may adopt external or delivered work.');
  }
}

/**
 * Apply an operator-only action inside the decision transaction.
 *
 * @param repository - Project ledger.
 * @param value - Exact decision.
 * @param evidence - Re-read GitHub and main evidence for adopt_delivered.
 * @returns Whether an operator-only action was applied.
 * @throws {MeshError} When delivered-issue evidence is missing.
 */
function didApplyOperatorAction(repository: FactoryRepository, value: Input, evidence?: DeliveredEvidence): boolean {
  const task = repository.task(value.taskId);
  switch (value.action) {
    case 'approve_size': {
      approvePublicationSize(repository, task, value.note);
      return true;
    }
    case 'adopt_merge': {
      adoptMerge(repository, value);
      return true;
    }
    case 'adopt_delivered': {
      if (evidence === undefined) {
        throw new MeshError('FACTORY_GATED', 'Adopting a delivered issue requires re-reading GitHub and main first.');
      }
      adoptDelivered(repository, value, evidence);
      return true;
    }
    case 'acknowledge':
    case 'investigate':
    case 'repair':
    case 'review':
    case 'verify':
    case 'wait': {
      return false;
    }
  }
}

/**
 * Preserve source ownership and never invent approvals.
 *
 * @param repository - Project ledger.
 * @param input - Exact decision.
 * @throws {MeshError} When the selected stage has no required source evidence.
 */
function applyDisposition(repository: FactoryRepository, input: Input): void {
  const task = repository.task(input.taskId);
  if (input.action === 'verify' && task.merge === null) {
    throw new MeshError('FACTORY_GATED', 'No confirmed merge is available to verify.');
  }
  if (input.action === 'review' && (task.pr === null || task.head === null || task.merge !== null)) {
    throw new MeshError('FACTORY_GATED', 'Fresh review requires an open published delivery.');
  }
  if (input.action === 'repair' && task.merge !== null) {
    throw new MeshError('FACTORY_GATED', 'Merged work requires verification or a traceable new repair.');
  }
  const phase = {
    repair: 'development',
    review: 'review',
    verify: 'verifying',
    wait: 'blocked',
    acknowledge: null,
    investigate: null,
    approve_size: null,
    adopt_merge: null,
    adopt_delivered: null,
  } as const;
  const nextPhase = phase[input.action];
  if (nextPhase === null) {
    return;
  }
  const note = input.note === '' ? (task.error ?? 'Explicit triage decision.') : input.note;
  repository.editTask(task.id, (current) => {
    return {
      ...current,
      phase: nextPhase,
      attempts: 0,
      reviews: [],
      finalReview: null,
      error: input.action === 'wait' ? note : null,
      feedback: [...current.feedback, `Operator ${input.action}: ${note}`],
    };
  });
  if (input.action === 'repair' && task.developer !== null) {
    repository.instruct(task.developer, task.id, `Resolve this delivery blocker: ${note}`);
  }
}

/**
 * Record an operator-identified external merge for mandatory merged-main verification.
 * Containment in main and end-to-end checks remain the final tester's gate; no approval is inferred.
 *
 * @param repository - Project ledger.
 * @param input - Exact operator decision.
 * @throws {MeshError} When the delivery already records a merge.
 */
function adoptMerge(repository: FactoryRepository, input: Input): void {
  const task = repository.task(input.taskId);
  if (task.merge !== null) {
    throw new MeshError('FACTORY_GATED', 'This delivery already records a merge. Use verify for its merged main.');
  }
  const commit = input.mergeCommit ?? '';
  const { note } = input;
  repository.editTask(task.id, (current) => {
    return {
      ...current,
      phase: 'verifying',
      merge: commit,
      attempts: 0,
      reviews: [],
      finalReview: null,
      verifiedMain: null,
      error: null,
      feedback: [
        ...current.feedback,
        `Operator adopt_merge: adopted external merge ${commit} for merged-main verification. ${note} No factory QA approvals are implied.`,
      ],
    };
  });
}

/**
 * Record unpaid operator proof for a closed issue and hand it to closing.
 * The merge, when any, was already proven contained in the recorded main head; no approval is inferred.
 *
 * @param repository - Project ledger inside the decision transaction.
 * @param input - Exact operator decision.
 * @param evidence - Re-read issue and main evidence.
 * @returns Closing task.
 */
function adoptDelivered(repository: FactoryRepository, input: Input, evidence: DeliveredEvidence): FactoryTask {
  const task = repository.task(input.taskId);
  const issue = `issue #${String(task.issue)}`;
  const merge =
    evidence.merge === null
      ? ' with no recorded merge'
      : `; merge ${evidence.merge} is contained in main ${evidence.head}`;
  const summary = evidence.isDelivered
    ? `Operator adopted ${issue} closed as ${evidence.reason}${merge}. ${input.note} No factory job ran.`
    : `Closed without delivery: ${issue} was closed as ${evidence.reason}. ${input.note} Nothing was merged or verified.`;
  return repository.editTask(task.id, (current) => {
    return {
      ...current,
      phase: 'closing',
      merge: evidence.merge,
      attempts: 0,
      error: null,
      verifiedMain: {
        head: evidence.head,
        jobId: OPERATOR_ADOPTED,
        summary,
        ...(!evidence.isDelivered && { undelivered: true as const }),
      },
      feedback: [...current.feedback, `Operator adopt_delivered: ${summary}`],
    };
  });
}

/**
 * Queue at most one automatic investigation per blocked revision.
 *
 * @param repository - Project ledger.
 */
export function queueBlockerInvestigations(repository: FactoryRepository): void {
  for (const task of repository.tasks()) {
    // A capability block already names its human action; diagnosing it would spend a paid turn.
    if (
      task.phase !== 'blocked' ||
      task.scopeReplacement !== undefined ||
      task.merge !== null ||
      task.capabilityBlock !== undefined
    ) {
      continue;
    }
    const prior = selectOne(
      repository.store.db,
      rowSchema,
      'SELECT data FROM factory_triage WHERE task_id=? AND version=? LIMIT 1',
      task.id,
      task.version,
    );
    if (prior === undefined && repository.jobs().every((job) => job.taskId !== task.id || job.state !== 'running')) {
      decideTriage(repository, {
        requestId: randomUUID(),
        taskId: task.id,
        expectedVersion: task.version,
        action: 'investigate',
        note: 'Supervisor requested bounded blocker diagnosis. Recommend the next safe action or a precise operator question; do not implement or repeatedly retry.',
      });
    }
  }
}

/**
 * Current claim must still address the same blocked revision.
 *
 * @param repository - Project ledger.
 * @param job - Bounded lead assignment.
 * @returns Whether its decision remains current.
 */
export function isCurrentTriage(repository: FactoryRepository, job: FactoryJob): boolean {
  const decision = decisionById(repository, job.target);
  return decision?.state === 'queued' && repository.task(decision.taskId).version === decision.version;
}

/**
 * Save recommendations, never implementation or fabricated acceptance.
 *
 * @param repository - Project ledger.
 * @param job - Lead assignment.
 * @param result - Structured diagnosis, or null on failure.
 */
export function completeTriage(repository: FactoryRepository, job: FactoryJob, result: AgentResult | null): void {
  const decision = decisionById(repository, job.target);
  if (decision?.state !== 'queued') {
    return;
  }
  let state: TriageDecision['state'] = 'stale';
  if (isCurrentTriage(repository, job)) {
    state = result === null ? 'failed' : 'awaiting_operator';
  }
  const updated = {
    ...decision,
    state,
    summary:
      result === null
        ? 'Lead investigation failed; inspect its job evidence before retrying.'
        : [result.summary, ...result.findings].join('\n\n'),
  };
  repository.store.transaction(() => {
    run(repository.store.db, 'UPDATE factory_triage SET data=? WHERE id=?', JSON.stringify(updated), decision.id);
    repository.store.event('FACTORY_TRIAGE_REPORTED', null, updated);
  });
}

/**
 * Retain the human stop against the newly blocked revision instead of scheduling another diagnosis.
 *
 * @param repository - Project ledger inside the cancellation transaction.
 * @param job - Cancelled investigation.
 */
export function cancelTriage(repository: FactoryRepository, job: FactoryJob): void {
  const decision = decisionById(repository, job.target);
  if (decision?.state !== 'queued') {
    return;
  }
  const updated: TriageDecision = {
    ...decision,
    version: repository.task(decision.taskId).version,
    state: 'awaiting_operator',
    summary: 'Operator cancelled this investigation; explicit retry required.',
  };
  run(
    repository.store.db,
    'UPDATE factory_triage SET version=?,data=? WHERE id=?',
    updated.version,
    JSON.stringify(updated),
    decision.id,
  );
  repository.store.event('FACTORY_TRIAGE_CANCELLED', null, updated);
}

/**
 * Settle an unsuccessful bounded investigation without repeating it.
 *
 * @param repository - Project ledger.
 * @param job - Original assignment.
 * @param state - Observed settlement.
 */
export function settleTriage(repository: FactoryRepository, job: FactoryJob, state: string): void {
  if (state !== 'succeeded' && job.kind === 'triage') {
    completeTriage(repository, job, null);
  }
}
