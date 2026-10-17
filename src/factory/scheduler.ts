/**
 * Pure factory scheduling rules: dependency-ready deliveries, original-owner rework, two independent exact-head reviews and normalized provider fairness. Empty role slots stay parked without invoking a model.
 *
 * @file
 */

import { MeshError } from '../protocol.ts';

import {
  featureWorkflow,
  isReviewComplete,
  isStepRunning,
  planningStep,
  seatFor,
  spineStep,
  startableSteps,
  taskWorkflow,
} from './pipeline.ts';
import { attemptBudget } from './repair-schema.ts';
import { isBackingOff } from './retry-policy.ts';
import { isRevalidationDue, revalidationIntents } from './revalidation.ts';
import { PROVIDERS, isTokenCapExceeded } from './schema.ts';
import { CODE_JOB_KINDS } from './seats.ts';

import type {
  AgentResult,
  Capacity,
  FactoryConfig,
  FactoryJob,
  FactoryRole,
  FactoryTask,
  Feature,
  Provider,
  SkillRequest,
} from './schema.ts';
import type { TriageDecision } from './triage.ts';
import type { Workflow, WorkflowStep } from './workflows.ts';
/** Named percent max bound. */
const PERCENT_MAX = 100;

/**
 * Require integration proof for the exact independently reviewed source.
 *
 * @param task - Current durable delivery revision.
 * @returns Whether its final approval covers both commits.
 */
export function hasFinalApproval(task: FactoryTask): boolean {
  const proof = task.finalReview;
  return proof !== null && proof.head === task.head && proof.base === task.base;
}

/** Native issue identity associated with an atomic plan key. */
export interface DeliveryPlanIssue {
  /** Stable delivery key. */
  readonly key: string;
  /** Created delivery issue number. */
  readonly issue: number;
  /** Full-feature issue number. */
  readonly parentIssue: number;
}
/** Existing scoped Ready issue discovered on the target Project. */
export interface ReadyIssue {
  /** Delivery issue number. */
  readonly issue: number;
  /** Feature parent number. */
  readonly parentIssue: number;
  /** Focused delivery title. */
  readonly title: string;
  /** Boundaries and observable behavior. */
  readonly description: string;
  /** Verifiable completion criteria. */
  readonly acceptanceCriteria: readonly string[];
}
/** The assignment kind each review-stage step runs as; other model steps are reviews. */
const REVIEW_STAGE_KINDS: Readonly<Partial<Record<WorkflowStep['kind'], FactoryJob['kind']>>> = {
  adjudicate: 'adjudicate',
  document: 'document',
  regress: 'regress',
};

/** Proposed bounded assignment before its durable reservation is committed. */
export interface JobIntent {
  /** Independent role slot. */
  readonly role: FactoryRole;
  /** Delivery stage. */
  readonly kind: FactoryJob['kind'];
  /** Associated task, absent for planning and research. */
  readonly taskId: string | null;
  /** Associated product request, absent for standalone deliveries. */
  readonly featureId: string | null;
  /** Review/merge identity, when relevant. */
  readonly head: string | null;
  /** Exact base used for approval evidence. */
  readonly base: string | null;
  /** Skill request identity when the lead independently reviews research. */
  readonly target?: string | null;
  /** Workflow step performed, absent for learning, skill review and triage. */
  readonly step?: string | null;
  /** Provider family the step prefers, for cross-family review. */
  readonly preferredProvider?: Provider | null;
}

/**
 * Reject cycles, duplicate scopes and unknown dependency keys before tickets exist.
 *
 * @param result - Lead-reviewed plan.
 * @throws {MeshError} When the plan cannot be dispatched safely.
 */
export function validatePlan(result: AgentResult): void {
  if (result.outcome !== 'success' || result.deliveries.length === 0) {
    throw new MeshError('INVALID_INPUT', 'Product refinement must produce at least one feasible atomic delivery.');
  }
  const deliveries = new Map(result.deliveries.map((delivery) => [delivery.key, delivery]));
  if (deliveries.size !== result.deliveries.length) {
    throw new MeshError('INVALID_INPUT', 'Atomic delivery keys must be unique.');
  }
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (key: string): void => {
    if (visiting.has(key)) {
      throw new MeshError('INVALID_INPUT', 'Atomic delivery dependencies contain a cycle.');
    }
    if (visited.has(key)) {
      return;
    }
    const delivery = deliveries.get(key);
    if (delivery === undefined) {
      throw new MeshError('INVALID_INPUT', 'A delivery depends on an unknown scope.');
    }
    const profiles = delivery.assignmentProfiles ?? [];
    const roles = new Set(profiles.map((profile) => profile.role));
    if (roles.size !== profiles.length) {
      throw new MeshError('INVALID_INPUT', 'New delivery plans require unique role recommendations.');
    }
    visiting.add(key);
    for (const dependency of delivery.dependencies) {
      visit(dependency);
    }
    visiting.delete(key);
    visited.add(key);
  };
  for (const key of deliveries.keys()) {
    visit(key);
  }
}

/** Provider admission inputs shared by dispatch and read-only evidence. */
export interface ProviderInput {
  /** Effective broker-wide policy. */
  readonly config: FactoryConfig;
  /** Broker-shared capacity snapshots. */
  readonly capacities: readonly Capacity[];
  /** Live broker-wide attempts. */
  readonly jobs: readonly Pick<FactoryJob, 'id' | 'provider' | 'state'>[];
  /** Current supervisor clock. */
  readonly now: number;
}
/** Why one provider cannot admit another assignment. */
export type ProviderBlocker = 'disabled' | 'cooldown' | 'subscription' | 'concurrency' | 'budget';

/**
 * Evaluate one provider with the exact conditions dispatch applies.
 *
 * @param provider - Provider family.
 * @param input - Capacity snapshots, settings and live attempts.
 * @returns Blocker, or utilization ordering evidence when admissible.
 */
function providerState(
  provider: Provider,
  input: ProviderInput,
): { blocker: ProviderBlocker } | { blocker: null; utilization: number; active: number } {
  const limits = input.config.providers[provider];
  const capacity = input.capacities.find((candidate) => candidate.provider === provider);
  if (capacity === undefined || !limits.enabled) {
    return { blocker: 'disabled' };
  }
  if (capacity.cooldownUntil > input.now) {
    return { blocker: 'cooldown' };
  }
  if (capacity.subscriptionUsedPercent === PERCENT_MAX) {
    return { blocker: 'subscription' };
  }
  const active = input.jobs.filter((job) => job.state === 'running' && job.provider === provider).length;
  if (active >= limits.concurrency) {
    return { blocker: 'concurrency' };
  }
  if (
    isTokenCapExceeded(limits.budgetTokens, capacity.usedTokens + capacity.reservedTokens + limits.reservationTokens)
  ) {
    return { blocker: 'budget' };
  }
  const utilization = Math.max(
    limits.budgetTokens === null ? 0 : (capacity.usedTokens + capacity.reservedTokens) / limits.budgetTokens,
    (capacity.subscriptionUsedPercent ?? 0) / PERCENT_MAX,
  );
  return { blocker: null, utilization, active };
}

/**
 * Explain each provider's admission state without selecting or claiming.
 *
 * @param input - Capacity snapshots, settings and live attempts.
 * @returns Per-provider blocker, null when it could admit another assignment.
 */
export function providerBlockers(input: ProviderInput): Record<Provider, ProviderBlocker | null> {
  return {
    codex: providerState('codex', input).blocker,
    claude: providerState('claude', input).blocker,
  };
}

/**
 * Select a provider by normalized utilization while respecting cooldown and caps.
 * A step's preferred provider waits while it is only temporarily busy, which keeps
 * cross-family reviews cross-family; a disabled preference falls back normally.
 *
 * @param input - Capacity snapshots, settings and live attempts.
 * @param preferred - Provider family the step prefers, if any.
 * @returns Provider choice, absent when the step should wait for capacity.
 */
export function chooseProvider(input: ProviderInput, preferred: Provider | null = null): Provider | null {
  const preference = preferred === null ? null : providerState(preferred, input).blocker;
  if (preferred !== null && preference !== 'disabled') {
    return preference === null ? preferred : null;
  }
  const choices = PROVIDERS.map((provider) => {
    const state = providerState(provider, input);
    return state.blocker === null ? { provider, utilization: state.utilization, active: state.active } : null;
  })
    .filter((choice) => choice !== null)
    .toSorted((left, right) => {
      const utilization = left.utilization - right.utilization;
      if (utilization !== 0) {
        return utilization;
      }
      const active = left.active - right.active;
      return active === 0 ? left.provider.localeCompare(right.provider) : active;
    });
  return choices[0]?.provider ?? null;
}

/**
 * Confirm that every step before the final check approved the exact source/base pair.
 *
 * @param task - Delivery being considered for merge.
 * @param workflow - Its workflow; defaults to the copy frozen on the delivery.
 * @returns Whether its reviews and approvals satisfy the local mandatory gate.
 */
export function hasApprovals(task: FactoryTask, workflow: Workflow = taskWorkflow(task)): boolean {
  return isReviewComplete(task, workflow);
}

/**
 * Build eligible bounded jobs, prioritizing verification and review handoffs.
 *
 * @param input - Current durable project state and time.
 * @returns Ordered candidate role assignments; claims are still transactional.
 */
export function jobIntents(input: SchedulingState): JobIntent[] {
  const live = input.jobs.filter((job) => job.state === 'running');
  const intents: JobIntent[] = [];
  const append: AppendIntent = (role, kind, task, step) => {
    if (
      role === null ||
      task.scopeReplacement !== undefined ||
      live.some((job) => job.role === role || (CODE_JOB_KINDS.has(kind) && job.taskId === task.id)) ||
      (kind !== 'develop' && isStepRunning(step, task.id, live))
    ) {
      return;
    }
    const scope = { kind, taskId: task.id, featureId: task.featureId, head: task.head, step: step.id };
    if (isBackingOff(input.jobs, scope, { now: input.now, reconcileMs: input.config.reconcileMs })) {
      return;
    }
    intents.push({
      role,
      kind,
      taskId: task.id,
      featureId: task.featureId,
      head: task.head,
      base: task.base,
      step: step.id,
      preferredProvider: step.provider,
    });
  };
  scheduleGroup1(input, live, intents, append);
  scheduleGroup2(input, live, intents, append);
  appendTriage(input, live, intents);
  intents.push(...revalidationIntents(input, live));
  const developmentStart = intents.length;
  scheduleGroup3(input, live, intents, append);
  const candidates = intents.splice(developmentStart);
  const published = new Set(
    input.tasks.filter((task) => task.pr !== null && task.merge === null).map((task) => task.id),
  );
  const repairs = interleaveDevelopment(
    input,
    candidates.filter((intent) => published.has(intent.taskId ?? '')),
  );
  const development = interleaveDevelopment(
    input,
    candidates.filter((intent) => !published.has(intent.taskId ?? '')),
  );
  intents.push(...repairs);
  // At most one development job, running or offered, precedes planning, leaving room at the default cap of two.
  const leading = live.some((job) => job.kind === 'develop') ? 0 : 1;
  intents.push(...development.slice(0, leading));
  scheduleGroup4(input, live, intents, append);
  intents.push(...development.slice(leading));

  scheduleGroup5(input, live, intents, append);
  const learning = input.jobs.findLast((job) => job.kind === 'learn');
  const learningAt = learning?.startedAt ?? 0;
  const hasNewFeedback = (input.feedbackAt ?? 0) > learningAt;
  const isMeaningful =
    hasNewFeedback ||
    input.tasks.some((task) => (task.phase === 'done' || task.feedback.length > 0) && task.updatedAt > learningAt);
  if (
    isMeaningful &&
    live.every((job) => job.role !== 'learning-steward') &&
    (hasNewFeedback || learning === undefined || learningAt + input.config.learningMs < input.now)
  ) {
    intents.push({ role: 'learning-steward', kind: 'learn', taskId: null, featureId: null, head: null, base: null });
  }
  const held = new Set(input.tasks.filter((task) => task.hold !== null).map((task) => task.id));
  const isSpendBlocked = input.isSpendBlocked ?? ((): boolean => false);
  const admitted = intents.filter(
    (intent) => (intent.taskId === null || !held.has(intent.taskId)) && !isSpendBlocked(intent),
  );
  const queue = input.objectiveQueue;
  return queue === undefined
    ? admitted
    : admitted.filter((intent) => {
        return queue.existingOnly === true
          ? intent.taskId !== null
          : queue.focusedFeatureId === null || intent.featureId === queue.focusedFeatureId;
      });
}

/** Current durable scheduling state. */
interface SchedulingState {
  /** Whether a spend cap stops new attempts on the intent's scope; absent means no caps. */
  isSpendBlocked?: (intent: { readonly taskId: string | null; readonly featureId: string | null }) => boolean;
  /** Bounded, durable lead investigation requests. */
  triage?: readonly TriageDecision[];
  /** Config state. */
  config: FactoryConfig;
  /** Tasks state. */
  tasks: readonly FactoryTask[];
  /** Features state. */
  features: readonly Feature[];
  /** Operator order and optional exclusive focus; absent preserves FIFO. */
  objectiveQueue?: { order: readonly string[]; focusedFeatureId: string | null; existingOnly?: boolean };
  /** Jobs state. */
  jobs: readonly FactoryJob[];
  /** Skill Requests state. */
  skillRequests: readonly SkillRequest[];
  /** Now state. */
  now: number;
  /** Latest explicit learning instruction; absent means no operator research request. */
  feedbackAt?: number;
}
/** Append one dependency and role-gated delivery candidate. */
type AppendIntent = (role: FactoryRole | null, kind: FactoryJob['kind'], task: FactoryTask, step: WorkflowStep) => void;

/**
 * Offer one finite lead investigation before new implementation.
 *
 * @param input - Project state.
 * @param live - Owned jobs.
 * @param intents - Ordered candidates.
 */
function appendTriage(input: SchedulingState, live: readonly FactoryJob[], intents: JobIntent[]): void {
  if (live.some((job) => job.role === 'team-lead')) {
    return;
  }
  if (input.triage !== undefined) {
    for (const decision of input.triage) {
      const task = input.tasks.find((candidate) => candidate.id === decision.taskId);
      if (
        decision.state !== 'queued' ||
        ((input.objectiveQueue?.focusedFeatureId ?? null) !== null &&
          task?.featureId !== input.objectiveQueue?.focusedFeatureId) ||
        task?.version !== decision.version ||
        task.scopeReplacement !== undefined ||
        live.some((job) => job.taskId === task.id)
      ) {
        continue;
      }
      intents.push({
        role: 'team-lead',
        kind: 'triage',
        taskId: task.id,
        featureId: task.featureId,
        target: decision.id,
        head: task.head,
        base: task.base,
      });
      return;
    }
  }
}

/**
 * Leave fixed-owner roles for later repairs while retaining flexible alternatives.
 *
 * @param tasks - Eligible task groups in round-robin order.
 * @returns Primary assignments followed by transactional fallback choices.
 */
function assignDevelopmentRoles(tasks: JobIntent[][]): JobIntent[] {
  const reservations = new Map<FactoryRole, number>();
  for (const roles of tasks) {
    const only = roles.length === 1 ? roles[0] : undefined;
    if (only !== undefined) {
      reservations.set(only.role, (reservations.get(only.role) ?? 0) + 1);
    }
  }
  const primary: JobIntent[] = [];
  const alternatives: JobIntent[] = [];
  const assigned = new Set<FactoryRole>();
  let previousRole: FactoryRole | undefined;
  for (const roles of tasks) {
    const only = roles.length === 1 ? roles[0] : undefined;
    if (only !== undefined) {
      reservations.set(only.role, (reservations.get(only.role) ?? 1) - 1);
    }
    const unreserved = roles.filter((intent) => (reservations.get(intent.role) ?? 0) === 0);
    const choices = unreserved.length === 0 ? roles : unreserved;
    const lastRole = previousRole;
    const preferred =
      choices.find((intent) => !assigned.has(intent.role)) ??
      choices.find((intent) => intent.role !== lastRole) ??
      choices[0];
    if (preferred === undefined) {
      continue;
    }
    primary.push(preferred);
    assigned.add(preferred.role);
    previousRole = preferred.role;
    alternatives.push(...roles.filter((intent) => intent !== preferred));
  }
  return [...primary, ...alternatives];
}

/**
 * Round-robin eligible tasks across objectives before offering alternative roles. Task insertion order is the repository's creation order; updatedAt is mutable.
 *
 * @param input - Durable feature creation order.
 * @param candidates - Already gated development candidates.
 * @returns Reordered candidates without changing their eligibility.
 */
function interleaveDevelopment(input: SchedulingState, candidates: JobIntent[]): JobIntent[] {
  const features = input.features.toSorted((left, right) => {
    const order = input.objectiveQueue?.order;
    const rank = (id: string): number => {
      const index = order?.indexOf(id) ?? -1;
      return index < 0 ? Number.MAX_SAFE_INTEGER : index;
    };
    const difference = rank(left.id) - rank(right.id);
    return difference === 0 ? left.createdAt - right.createdAt : difference;
  });
  const ranks = new Map<string | null, number>(features.map((feature, index) => [feature.id, index]));
  const groups = new Map<string | null, Map<string | null, JobIntent[]>>();
  for (const intent of candidates) {
    const tasks = groups.get(intent.featureId) ?? new Map<string | null, JobIntent[]>();
    const roles = tasks.get(intent.taskId) ?? [];
    roles.push(intent);
    tasks.set(intent.taskId, roles);
    groups.set(intent.featureId, tasks);
  }
  // Standalone or absent-feature deliveries retain insertion order after known features.
  const queues = groups
    .entries()
    .toArray()
    .toSorted(([left], [right]) => (ranks.get(left) ?? ranks.size) - (ranks.get(right) ?? ranks.size))
    .map(([, tasks]) => tasks.values().toArray());
  const ordered: JobIntent[][] = [];
  const rounds = Math.max(0, ...queues.map((queue) => queue.length));
  for (let round = 0; round < rounds; round += 1) {
    for (const queue of queues) {
      const roles = queue[round];
      if (roles === undefined) {
        continue;
      }
      ordered.push(roles);
    }
  }
  return assignDevelopmentRoles(ordered);
}

/**
 * Schedule merged-main verification and the final check on each workflow's seats.
 *
 * @param input - Durable scheduling state.
 * @param live - Current exclusive role claims.
 * @param _intents - Accumulated candidate assignments.
 * @param append - Delivery admission helper.
 */
function scheduleGroup1(
  input: SchedulingState,
  live: readonly FactoryJob[],
  _intents: JobIntent[],
  append: AppendIntent,
): void {
  for (const task of input.tasks) {
    const workflow = taskWorkflow(task, input.features);
    if (task.phase === 'verifying') {
      const verify = spineStep(workflow, 'verify');
      append(seatFor(verify, live), 'verify', task, verify);
    }
    if (task.phase !== 'merge_ready' || task.error !== null || !hasApprovals(task, workflow)) {
      continue;
    }
    const final = spineStep(workflow, 'final');
    append(seatFor(final, live), 'final', task, final);
  }
}

/**
 * Schedule review-stage steps whose predecessors approved the current source.
 *
 * @param input - Durable scheduling state.
 * @param live - Current exclusive role claims.
 * @param _intents - Accumulated candidate assignments.
 * @param append - Delivery admission helper.
 */
function scheduleGroup2(
  input: SchedulingState,
  live: readonly FactoryJob[],
  _intents: JobIntent[],
  append: AppendIntent,
): void {
  const candidates = input.tasks.filter((candidate) => candidate.phase === 'review');
  for (const task of candidates) {
    const steps = startableSteps(task, taskWorkflow(task, input.features));
    for (const step of steps) {
      append(seatFor(step, live), REVIEW_STAGE_KINDS[step.kind] ?? 'review', task, step);
    }
  }
}

/**
 * Schedule implementation on the workflow's developer seats; rework stays with the original owner.
 *
 * @param input - Durable scheduling state.
 * @param _live - Current exclusive role claims.
 * @param _intents - Accumulated candidate assignments.
 * @param append - Delivery admission helper.
 */
function scheduleGroup3(
  input: SchedulingState,
  _live: readonly FactoryJob[],
  _intents: JobIntent[],
  append: AppendIntent,
): void {
  const candidates = input.tasks.filter(
    (candidate) => candidate.phase === 'ready' || candidate.phase === 'development',
  );
  for (const task of candidates) {
    if (
      task.dependencies.some((id) =>
        input.tasks.every((dependency) => !(dependency.id === id && dependency.phase === 'done')),
      ) ||
      task.attempts >= attemptBudget(task, input.config) ||
      isRevalidationDue(task, input.tasks, input.config)
    ) {
      continue;
    }
    const implement = spineStep(taskWorkflow(task, input.features), 'implement');
    for (const role of implement.roles) {
      if (task.developer === null || task.developer === role) {
        append(role, 'develop', task, implement);
      }
    }
  }
}

/**
 * Schedule the next planning step of each objective, in operator order.
 *
 * @param input - Durable scheduling state.
 * @param live - Current exclusive role claims.
 * @param intents - Accumulated candidate assignments.
 * @param _append - Delivery admission helper.
 */
function scheduleGroup4(
  input: SchedulingState,
  live: readonly FactoryJob[],
  intents: JobIntent[],
  _append: AppendIntent,
): void {
  const candidates = input.features
    .toSorted((left, right) => {
      const order = input.objectiveQueue?.order;
      const rank = (id: string): number => {
        const index = order?.indexOf(id) ?? -1;
        return index < 0 ? Number.MAX_SAFE_INTEGER : index;
      };
      const difference = rank(left.id) - rank(right.id);
      return difference === 0 ? left.createdAt - right.createdAt : difference;
    })
    .filter((candidate) => {
      return (
        candidate.scopeReplacement === undefined &&
        ((input.objectiveQueue?.focusedFeatureId ?? null) === null ||
          candidate.id === input.objectiveQueue?.focusedFeatureId) &&
        (candidate.phase === 'queued' || candidate.phase === 'refining')
      );
    });
  for (const feature of candidates) {
    const next = planningStep(feature, featureWorkflow(feature));
    const role = next === null ? null : seatFor(next.step, [...live, ...intents]);
    const scope = {
      kind: next?.kind ?? 'plan',
      taskId: null,
      featureId: feature.id,
      head: null,
      step: next?.step.id ?? null,
    };
    if (
      next !== null &&
      role !== null &&
      live.every((job) => job.featureId !== feature.id) &&
      !isBackingOff(input.jobs, scope, { now: input.now, reconcileMs: input.config.reconcileMs })
    ) {
      intents.push({
        role,
        kind: next.kind,
        taskId: null,
        featureId: feature.id,
        head: null,
        base: null,
        step: next.step.id,
        preferredProvider: planningProvider(input.jobs, feature.id, next.step),
      });
    }
  }
}

/**
 * The provider a planning step prefers. A plan review prefers the family that
 * did not write the current plan, so it is independent even when load or
 * availability routed the planner to the family the workflow names; when only
 * one family is enabled, admission falls back to it.
 *
 * @param jobs - Every recorded attempt.
 * @param featureId - Objective being planned.
 * @param step - Next planning step.
 * @returns Preferred provider, or `null` for none.
 */
function planningProvider(jobs: readonly FactoryJob[], featureId: string, step: WorkflowStep): Provider | null {
  if (step.kind !== 'plan_review') {
    return step.provider;
  }
  const planner = jobs
    .filter(
      (job) => job.featureId === featureId && job.taskId === null && job.kind === 'refine' && job.state === 'succeeded',
    )
    .toSorted((left, right) => (right.finishedAt ?? 0) - (left.finishedAt ?? 0))[0];
  return planner === undefined
    ? step.provider
    : (PROVIDERS.find((provider) => provider !== planner.provider) ?? step.provider);
}

/**
 * Schedule one independently bounded delivery or planning stage.
 *
 * @param input - Durable scheduling state.
 * @param live - Current exclusive role claims.
 * @param intents - Accumulated candidate assignments.
 * @param _append - Delivery admission helper.
 */
function scheduleGroup5(
  input: SchedulingState,
  live: readonly FactoryJob[],
  intents: JobIntent[],
  _append: AppendIntent,
): void {
  const candidates = input.skillRequests.filter((candidate) => candidate.status === 'pending');
  for (const request of candidates) {
    if (live.every((job) => job.role !== 'team-lead')) {
      intents.push({
        role: 'team-lead',
        kind: 'skill',
        taskId: null,
        featureId: null,
        target: request.id,
        head: null,
        base: null,
      });
    }
  }
}

/**
 * Resume a blocked feature at its last durable planning checkpoint.
 *
 * @param feature - Existing plan evidence.
 * @returns Valid refinement stage.
 */
export function retryFeaturePhase(feature: Feature): 'provisioning' | 'refining' | 'queued' {
  const record = feature;
  if (record.plan !== null) {
    return 'provisioning';
  }
  return record.productPlan === null ? 'queued' : 'refining';
}
