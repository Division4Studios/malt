/**
 * Pure factory scheduling rules: dependency-ready deliveries, original-owner
 * rework, two independent exact-head reviews and normalized provider fairness.
 * Empty role slots stay parked without invoking a model.
 *
 * @file
 */

import { MeshError } from '../protocol.ts';

import { PROVIDERS, isTokenCapExceeded } from './schema.ts';

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
  readonly jobs: readonly FactoryJob[];
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
 *
 * @param input - Capacity snapshots, settings and live attempts.
 * @returns Provider choice, absent when neither can admit another assignment.
 */
export function chooseProvider(input: ProviderInput): Provider | null {
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
 * Confirm that both independent reviewers hasApprovals the exact source/base pair.
 *
 * @param task - Delivery being considered for merge.
 * @returns Whether its approvals satisfy the local mandatory gate.
 */
export function hasApprovals(task: FactoryTask): boolean {
  return ['qa-1', 'qa-2'].every((role) => {
    return task.reviews.some(
      (review) =>
        review.role === role && review.outcome === 'success' && review.head === task.head && review.base === task.base,
    );
  });
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
  const append = (role: FactoryRole, kind: FactoryJob['kind'], task: FactoryTask): void => {
    if (
      task.scopeReplacement !== undefined ||
      live.some((job) => job.role === role || (kind === 'develop' && job.taskId === task.id))
    ) {
      return;
    }
    const recent = input.jobs.findLast(
      (job) => job.kind === kind && job.taskId === task.id && job.head === task.head && job.state === 'failed',
    );
    if (recent !== undefined && (recent.finishedAt ?? input.now) + input.config.reconcileMs > input.now) {
      return;
    }
    intents.push({ role, kind, taskId: task.id, featureId: task.featureId, head: task.head, base: task.base });
  };
  scheduleGroup1(input, live, intents, append);
  scheduleGroup2(input, live, intents, append);
  scheduleGroup3(input, live, intents, append);
  scheduleGroup4(input, live, intents, append);

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
  return intents;
}

/** Current durable scheduling state. */
interface SchedulingState {
  /** Config state. */
  config: FactoryConfig;
  /** Tasks state. */
  tasks: readonly FactoryTask[];
  /** Features state. */
  features: readonly Feature[];
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
type AppendIntent = (role: FactoryRole, kind: FactoryJob['kind'], task: FactoryTask) => void;

/**
 * Schedule one independently bounded delivery or planning stage.
 *
 * @param input - Durable scheduling state.
 * @param _live - Current exclusive role claims.
 * @param _intents - Accumulated candidate assignments.
 * @param append - Delivery admission helper.
 */
function scheduleGroup1(
  input: SchedulingState,
  _live: readonly FactoryJob[],
  _intents: JobIntent[],
  append: AppendIntent,
): void {
  for (const task of input.tasks) {
    if (task.phase === 'verifying') {
      append('final-tester', 'verify', task);
    }
    if (task.phase === 'merge_ready' && task.error === null && hasApprovals(task)) {
      append('final-tester', 'final', task);
    }
  }
}

/**
 * Schedule one independently bounded delivery or planning stage.
 *
 * @param input - Durable scheduling state.
 * @param _live - Current exclusive role claims.
 * @param _intents - Accumulated candidate assignments.
 * @param append - Delivery admission helper.
 */
function scheduleGroup2(
  input: SchedulingState,
  _live: readonly FactoryJob[],
  _intents: JobIntent[],
  append: AppendIntent,
): void {
  const candidates = input.tasks.filter((candidate) => candidate.phase === 'review');
  for (const task of candidates) {
    for (const role of ['qa-1', 'qa-2'] as const) {
      if (
        task.reviews.every((review) => {
          return !(
            review.role === role &&
            review.head === task.head &&
            review.base === task.base &&
            review.outcome === 'success'
          );
        })
      ) {
        append(role, 'review', task);
      }
    }
  }
}

/**
 * Schedule one independently bounded delivery or planning stage.
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
      task.attempts >= input.config.maxAttempts
    ) {
      continue;
    }
    for (const role of ['developer-1', 'developer-2'] as const) {
      if (task.developer === null || task.developer === role) {
        append(role, 'develop', task);
      }
    }
  }
}

/**
 * Schedule one independently bounded delivery or planning stage.
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
  const candidates = input.features.filter(
    (candidate) =>
      candidate.scopeReplacement === undefined && (candidate.phase === 'queued' || candidate.phase === 'refining'),
  );
  for (const feature of candidates) {
    const role = feature.productPlan === null ? 'product-owner' : 'team-lead';
    if (live.every((job) => !(job.role === role || job.featureId === feature.id))) {
      intents.push({
        role,
        kind: feature.productPlan === null ? 'plan' : 'refine',
        taskId: null,
        featureId: feature.id,
        head: null,
        base: null,
      });
    }
  }
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
