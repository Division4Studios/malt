/**
 * Ready-to-render console projection computed by the broker, so the browser
 * never re-implements workflow rules. It describes each delivery and planning
 * objective as a pipeline of steps with a plain state, places them on a
 * five-column board, and lists every decision waiting on the human as one
 * Inbox. Frozen workflow copies stay server-side.
 *
 * @file
 */

import { isArchived } from './delivery-controls.ts';
import { livenessView, retryView } from './liveness-view.ts';
import { definitionProgress, isDefinitionMet } from './objective-goals.ts';
import {
  approvalSource,
  awaitingApproval,
  currentReview,
  featureWorkflow,
  isStepSatisfied,
  planningApprovals,
  planningStep,
  startableSteps,
  taskWorkflow,
} from './pipeline.ts';
import { questionsStatus } from './questions.ts';
import { openBlocks, spendGate } from './spend.ts';
import { attemptedSteps } from './step-override-controls.ts';
import { customizationView, objectiveCustomizationView } from './step-override-view.ts';
import { stepLayers } from './workflows.ts';

import type { LivenessView, RetryView } from './liveness-view.ts';
import type { DoneItem } from './objective-goal-schema.ts';
import type { Question } from './question-schema.ts';
import type { FactoryRepository } from './repository.ts';
import type { FactoryJob, FactoryTask, Feature } from './schema.ts';
import type { CustomizationView } from './step-override-view.ts';
import type { Workflow, WorkflowStep } from './workflows.ts';

/** Reconcile interval assumed before a project is configured. */
const RECONCILE_FALLBACK_MS = 30_000;
/** Completed deliveries kept on the board; older ones remain in history. */
const DONE_ON_BOARD = 50;
/** Answered decisions listed in the Inbox. */
const ANSWERED_LIMIT = 50;
/** Longest objective title shown on a card. */
const TITLE_MAX = 120;
/** Phases before a delivery is published for review. */
const BUILDING_PHASES: ReadonlySet<string> = new Set(['development', 'publishing']);
/** Finished objectives kept in the objective list. */
const DONE_GOALS = 50;
/** Objective phases shown as planning cards. */
const PLANNING_PHASES: ReadonlySet<string> = new Set(['queued', 'refining', 'provisioning', 'blocked']);
/** Repair rounds shown per delivery, newest. */
const REPAIRS_SHOWN = 4;
/** Longest repair finding sent to the console; the developer receives the full one. */
const REPAIR_PREVIEW = 1500;

/** Where a step stands for its delivery or objective. */
export type StepState = 'done' | 'running' | 'ready' | 'needs_you' | 'waiting';
/** Board column. */
export type Column = 'planning' | 'ready' | 'in_progress' | 'needs_you' | 'done';

/** The latest result a step recorded, when it has one. */
export interface StepResultView {
  /** Verdict. */
  readonly outcome: string;
  /** What the role reported. */
  readonly summary: string;
  /** Severity-tagged findings, if any. */
  readonly findings: readonly string[];
  /** A fixer's or plan reviser's rulings, if any. */
  readonly dispositions: readonly { id: string; decision: string; reason: string; evidence: string }[];
  /** Seat that produced it, or `operator` for a human decision. */
  readonly role: string;
}

/** One step as the console shows it. */
export interface StepView {
  /** Step id within its workflow. */
  readonly id: string;
  /** Human title. */
  readonly title: string;
  /** Step kind. */
  readonly kind: string;
  /** One-based execution layer; steps sharing a layer run in parallel. */
  readonly layer: number;
  /** Seats that may perform it; empty for human approvals. */
  readonly roles: readonly string[];
  /** Plain state. */
  readonly state: StepState;
  /** Whether a human approves after it succeeds. */
  readonly gate: boolean;
  /** Whether it is a blind review. */
  readonly blind: boolean;
  /** Preferred provider family, if any. */
  readonly provider: string | null;
  /** Latest result, when recorded. */
  readonly result: StepResultView | null;
}

/** A delivery card and its pipeline. */
export interface DeliveryView {
  /** Delivery id. */
  readonly taskId: string;
  /** Tracker issue number. */
  readonly issue: number;
  /** Title. */
  readonly title: string;
  /** Owning objective, if any. */
  readonly featureId: string | null;
  /** Ledger phase. */
  readonly phase: string;
  /** Board column. */
  readonly column: Column;
  /** Workflow identity. */
  readonly workflow: { readonly id: string; readonly name: string };
  /** Steps in workflow order. */
  readonly steps: readonly StepView[];
  /** Live attempt, if one is running, with its checkpoint liveness. */
  readonly running: {
    readonly jobId: string;
    readonly role: string;
    readonly step: string | null;
    readonly liveness: LivenessView | null;
  } | null;
  /** Retry backoff of its latest failed step, while it delays that step. */
  readonly retry: RetryView | null;
  /** Current head. */
  readonly head: string | null;
  /** Current base. */
  readonly base: string | null;
  /** Pull request link, once published. */
  readonly prUrl: string | null;
  /** Implementation owner. */
  readonly developer: string | null;
  /** Issue numbers of unfinished dependencies blocking implementation. */
  readonly waitingOn: readonly number[];
  /** Attempts so far. */
  readonly attempts: number;
  /** Blocker or last error. */
  readonly error: string | null;
  /** Operator hold: no new attempt starts while set. */
  readonly held: { readonly at: number; readonly reason: string } | null;
  /** Recent CI-failure and merge-conflict repair rounds, oldest first. */
  readonly repairs: readonly RepairView[];
  /** Whether the operator chose to keep it on the board after it finished. */
  readonly isKept: boolean;
  /** Step override editor state, while its steps can still change. */
  readonly customization: CustomizationView | null;
  /** The lead's brief revalidation verdict, when one was recorded. */
  readonly revalidation: { readonly outcome: string; readonly summary: string; readonly at: number } | null;
  /** Last change time. */
  readonly updatedAt: number;
}

/** One CI-failure or merge-conflict repair round. */
export interface RepairView {
  /** What failed. */
  readonly kind: 'ci' | 'conflict';
  /** When the round started. */
  readonly at: number;
  /** Source that failed. */
  readonly head: string;
  /** One-line description. */
  readonly summary: string;
  /** Redacted evidence previews. */
  readonly findings: readonly string[];
}

/** An objective card while it is being planned. */
export interface ObjectiveView {
  /** Objective id. */
  readonly featureId: string;
  /** First line of the objective. */
  readonly title: string;
  /** Ledger phase. */
  readonly phase: string;
  /** Board column. */
  readonly column: Column;
  /** Workflow identity. */
  readonly workflow: { readonly id: string; readonly name: string };
  /** Planning steps. */
  readonly steps: readonly StepView[];
  /** Delivery progress once provisioned. */
  readonly deliveries: { readonly total: number; readonly done: number };
  /** Definition-of-done progress. */
  readonly definition: { readonly met: number; readonly total: number };
  /** Blocker or last error. */
  readonly error: string | null;
  /** Creation time. */
  readonly createdAt: number;
}

/** Inbox lane: decisions that need a reply, or notices to look into. */
export type InboxLane = 'reply' | 'notice';
/** An objective with its definition of done, for the objective view. */
export interface GoalView {
  /** Objective id. */
  readonly featureId: string;
  /** First line of the objective. */
  readonly title: string;
  /** Full objective text. */
  readonly objective: string;
  /** Ledger phase. */
  readonly phase: string;
  /** Version the checklist editor must present to save. */
  readonly updatedAt: number;
  /** Delivery progress. */
  readonly deliveries: { readonly total: number; readonly done: number };
  /** Checklist and counts. */
  readonly definition: {
    readonly items: readonly DoneItem[];
    readonly met: number;
    readonly proposed: number;
    readonly total: number;
  };
  /** Whether every delivery is done but the checklist is not met yet. */
  readonly awaitsDefinition: boolean;
  /** Step override editor state, while the objective has not started delivering. */
  readonly customization: CustomizationView | null;
}

/** Something waiting on the human. */
export interface InboxItem {
  /** Stable item id. */
  readonly id: string;
  /** What kind of decision it is. */
  readonly kind:
    | 'approval'
    | 'plan_approval'
    | 'question'
    | 'blocked_delivery'
    | 'blocked_objective'
    | 'skill'
    | 'spend_cap'
    | 'done_criteria';
  /** Lane it is listed in. */
  readonly lane: InboxLane;
  /** Headline. */
  readonly title: string;
  /** Context the operator needs. */
  readonly detail: string;
  /** When it started waiting. */
  readonly since: number;
  /** Delivery, when it concerns one. */
  readonly taskId: string | null;
  /** Objective, when it concerns one. */
  readonly featureId: string | null;
  /** Step to decide, for approvals. */
  readonly stepId: string | null;
  /** Head an approval binds, for delivery approvals. */
  readonly head: string | null;
  /** Skill request, for skill decisions. */
  readonly requestId: string | null;
  /** Agent question, for questions. */
  readonly questionId: string | null;
  /** Offered answers, for questions. */
  readonly choices: readonly string[];
  /** Whether a question accepts a written answer. */
  readonly allowText: boolean;
}

/** A decision already made. */
export interface AnsweredItem {
  /** Stable item id. */
  readonly id: string;
  /** What was decided. */
  readonly title: string;
  /** Operator note. */
  readonly note: string;
  /** Decision time. */
  readonly at: number;
}

/** Complete console projection. */
export interface ConsoleView {
  /** Delivery cards. */
  readonly deliveries: readonly DeliveryView[];
  /** Objective cards while planning. */
  readonly objectives: readonly ObjectiveView[];
  /** Every current objective with its definition of done, newest last. */
  readonly goals: readonly GoalView[];
  /** Finished deliveries archived off the board: how many, and the latest to restore from. */
  readonly archived: {
    readonly total: number;
    readonly recent: readonly { readonly taskId: string; readonly issue: number; readonly title: string }[];
  };
  /** Human decisions. */
  readonly inbox: { readonly open: readonly InboxItem[]; readonly answered: readonly AnsweredItem[] };
}

/** Fields an Inbox item leaves empty unless its kind uses them. */
const NO_TARGET = {
  lane: 'reply',
  taskId: null,
  featureId: null,
  stepId: null,
  head: null,
  requestId: null,
  questionId: null,
  choices: [],
  allowText: false,
} as const;

/**
 * A result recorded by a role, as the console shows it.
 *
 * @param fields - Outcome, summary and producing seat.
 * @param fields.outcome - Verdict.
 * @param fields.summary - Reported summary.
 * @param fields.role - Producing seat or `operator`.
 * @returns Result view without findings or rulings.
 */
function plainResult(fields: { outcome: string; summary: string; role: string }): StepResultView {
  return { outcome: fields.outcome, summary: fields.summary, role: fields.role, findings: [], dispositions: [] };
}

/**
 * The latest recorded result of a delivery step.
 *
 * @param task - Delivery whose ledger holds the results.
 * @param workflow - Workflow the delivery runs.
 * @param step - The step whose result to describe.
 * @returns Result view, or `null` when the step has none yet.
 */
function deliveryResult(task: FactoryTask, workflow: Workflow, step: WorkflowStep): StepResultView | null {
  if (step.kind === 'review') {
    const review = currentReview(task, workflow, step);
    return review === undefined ? null : { ...plainResult(review), findings: review.findings ?? [] };
  }
  const result = task.stepResults.findLast((entry) => entry.stepId === step.id);
  if (result !== undefined) {
    return { ...plainResult(result), findings: result.findings, dispositions: result.dispositions };
  }
  const approval = task.approvals.findLast((entry) => entry.stepId === step.id);
  if (approval !== undefined) {
    return plainResult({ outcome: 'approved', summary: approval.note, role: 'operator' });
  }
  const spineResults = new Map<string, { readonly summary: string } | null>([
    ['final', task.finalReview],
    ['verify', task.verifiedMain],
  ]);
  const spine = spineResults.get(step.kind);
  return spine === undefined || spine === null
    ? null
    : plainResult({ outcome: 'success', summary: spine.summary, role: step.roles[0] ?? '' });
}

/**
 * The plain state of one delivery step.
 *
 * @param task - Delivery whose step is described.
 * @param workflow - Workflow the delivery runs.
 * @param step - The step whose state to compute.
 * @param context - Live attempt and the steps waiting on the human or ready to start.
 * @param context.running - The delivery's live attempt, if any.
 * @param context.waiting - Steps waiting on a human decision.
 * @param context.startable - Review-stage steps that may start now.
 * @returns State for display.
 */
function deliveryState(
  task: FactoryTask,
  workflow: Workflow,
  step: WorkflowStep,
  context: { running: FactoryJob | undefined; waiting: ReadonlySet<string>; startable: ReadonlySet<string> },
): StepState {
  if (context.waiting.has(step.id)) {
    return 'needs_you';
  }
  if (isStepSatisfied(task, workflow, step)) {
    return 'done';
  }
  if (context.running !== undefined && (context.running.step === step.id || context.running.kind === step.kind)) {
    return 'running';
  }
  const spine: Partial<Record<string, boolean>> = {
    implement: task.phase === 'ready' || BUILDING_PHASES.has(task.phase),
    final: task.phase === 'merge_ready' || task.phase === 'merging',
    verify: task.phase === 'verifying' || task.phase === 'closing',
  };
  return context.startable.has(step.id) || spine[step.kind] === true ? 'ready' : 'waiting';
}

/**
 * The board column for a delivery.
 *
 * @param task - Delivery to place.
 * @param waiting - How many of its steps wait on a human decision.
 * @param running - Its live attempt, if any.
 * @returns The column the delivery card belongs in.
 */
function deliveryColumn(task: FactoryTask, waiting: number, running: FactoryJob | undefined): Column {
  if (task.phase === 'done') {
    return 'done';
  }
  if (waiting > 0 || task.phase === 'blocked') {
    return 'needs_you';
  }
  return running === undefined && task.phase === 'ready' ? 'ready' : 'in_progress';
}

/**
 * The static fields of a step view.
 *
 * @param step - Workflow step to describe.
 * @param layers - Execution layer of each step in its section.
 * @returns Step fields other than state and result.
 */
function stepShape(step: WorkflowStep, layers: ReadonlyMap<string, number>): Omit<StepView, 'state' | 'result'> {
  return {
    id: step.id,
    title: step.title,
    kind: step.kind,
    layer: layers.get(step.id) ?? 1,
    roles: step.roles,
    gate: step.gate,
    blind: step.blind,
    provider: step.provider,
  };
}

/**
 * Project one delivery.
 *
 * @param task - Delivery to describe.
 * @param context - Every delivery, objectives and running attempts.
 * @param context.tasks - Every delivery, for dependency issue numbers.
 * @param context.features - Objectives, for deliveries without a frozen workflow.
 * @param context.live - Running attempts.
 * @param context.jobs - Every attempt, for retry backoff.
 * @param context.timing - Current time and reconcile interval.
 * @param context.attempted - Steps any attempt ran, for the override editor.
 * @returns Card and pipeline.
 */
function deliveryView(
  task: FactoryTask,
  context: {
    tasks: readonly FactoryTask[];
    features: readonly Feature[];
    live: readonly FactoryJob[];
    jobs: readonly FactoryJob[];
    timing: { now: number; reconcileMs: number };
    attempted: ReadonlySet<string>;
  },
): DeliveryView {
  const workflow = taskWorkflow(task, context.features);
  const layers = stepLayers(workflow.delivery);
  const running = context.live.find((job) => job.taskId === task.id);
  const waiting = new Set(awaitingApproval(task, workflow).map((step) => step.id));
  const startable = new Set(task.phase === 'review' ? startableSteps(task, workflow).map((step) => step.id) : []);
  const steps = workflow.delivery.map((step) => {
    return {
      ...stepShape(step, layers),
      state: deliveryState(task, workflow, step, { running, waiting, startable }),
      result: deliveryResult(task, workflow, step),
    };
  });
  const waitingOn = context.tasks
    .filter((candidate) => task.dependencies.includes(candidate.id) && candidate.phase !== 'done')
    .map((dependency) => dependency.issue);
  return {
    taskId: task.id,
    issue: task.issue,
    title: task.title,
    featureId: task.featureId,
    phase: task.phase,
    column: deliveryColumn(task, waiting.size, running),
    workflow: { id: workflow.id, name: workflow.name },
    steps,
    running:
      running === undefined
        ? null
        : { jobId: running.id, role: running.role, step: running.step, liveness: livenessView(running) },
    retry: running === undefined ? retryView(task, context.jobs, context.timing) : null,
    head: task.head,
    base: task.base,
    prUrl: task.prUrl,
    developer: task.developer,
    waitingOn,
    attempts: task.attempts,
    error: task.error,
    held: task.hold,
    repairs: task.repairs.slice(-REPAIRS_SHOWN).map((round) => {
      return {
        kind: round.kind,
        at: round.at,
        head: round.head,
        summary: round.summary,
        findings: round.findings.map((finding) => finding.slice(0, REPAIR_PREVIEW)),
      };
    }),
    isKept: task.archive?.state === 'kept',
    customization: customizationView(task, context.features, context.attempted),
    revalidation:
      task.revalidation === null
        ? null
        : { outcome: task.revalidation.outcome, summary: task.revalidation.summary, at: task.revalidation.at },
    updatedAt: task.updatedAt,
  };
}

/**
 * The plain state of one planning step.
 *
 * @param feature - Objective being planned.
 * @param workflow - Workflow the objective runs.
 * @param step - The planning step whose state to compute.
 * @param running - The objective's live planning attempt, if any.
 * @returns State for display.
 */
function planningState(
  feature: Feature,
  workflow: Workflow,
  step: WorkflowStep,
  running: FactoryJob | undefined,
): StepState {
  if (planningApprovals(feature, workflow).some((candidate) => candidate.id === step.id)) {
    return 'needs_you';
  }
  if (running?.step === step.id) {
    return 'running';
  }
  const next = planningStep(feature, workflow);
  if (next?.step.id === step.id) {
    return 'ready';
  }
  const order = workflow.planning.findIndex((candidate) => candidate.id === step.id);
  const current = next === null ? workflow.planning.length : workflow.planning.indexOf(next.step);
  return order < current ? 'done' : 'waiting';
}

/**
 * Project one objective that is still being planned.
 *
 * @param feature - Objective to describe.
 * @param tasks - Deliveries, for provisioning progress.
 * @param live - Running attempts.
 * @returns Card and planning pipeline.
 */
function objectiveView(feature: Feature, tasks: readonly FactoryTask[], live: readonly FactoryJob[]): ObjectiveView {
  const workflow = featureWorkflow(feature);
  const layers = stepLayers(workflow.planning);
  const running = live.find((job) => job.taskId === null && job.featureId === feature.id);
  const children = tasks.filter((task) => task.featureId === feature.id);
  const isWaiting = feature.phase === 'blocked' || planningApprovals(feature, workflow).length > 0;
  const stateOf = (step: WorkflowStep): StepState => planningState(feature, workflow, step, running);
  return {
    featureId: feature.id,
    title: titleOf(feature.objective),
    phase: feature.phase,
    column: isWaiting ? 'needs_you' : 'planning',
    workflow: { id: workflow.id, name: workflow.name },
    steps: workflow.planning.map((step) => ({ ...stepShape(step, layers), state: stateOf(step), result: null })),
    deliveries: { total: children.length, done: children.filter((task) => task.phase === 'done').length },
    definition: definitionProgress(feature),
    error: feature.error,
    createdAt: feature.createdAt,
  };
}

/**
 * Project one objective with its definition of done.
 *
 * @param feature - Objective to describe.
 * @param tasks - Current deliveries.
 * @param attempted - Steps any attempt ran, for the override editor.
 * @returns Objective view entry.
 */
function goalView(feature: Feature, tasks: readonly FactoryTask[], attempted: ReadonlySet<string>): GoalView {
  const children = tasks.filter((task) => task.featureId === feature.id);
  const done = children.filter((task) => task.phase === 'done').length;
  return {
    featureId: feature.id,
    title: titleOf(feature.objective),
    objective: feature.objective,
    phase: feature.phase,
    updatedAt: feature.updatedAt,
    deliveries: { total: children.length, done },
    definition: { items: feature.definitionOfDone ?? [], ...definitionProgress(feature) },
    awaitsDefinition:
      feature.phase === 'active' && children.length > 0 && done === children.length && !isDefinitionMet(feature),
    customization: objectiveCustomizationView(feature, attempted),
  };
}

/**
 * Decisions waiting on an objective's definition of done.
 *
 * @param goal - Objective view entry.
 * @returns Proposal review or completion items.
 */
function definitionItems(goal: GoalView): InboxItem[] {
  const { met, proposed, total } = goal.definition;
  if (proposed === 0 && !goal.awaitsDefinition) {
    return [];
  }
  const proposals = proposed === 0 ? '' : ` ${String(proposed)} proposed by agents to review.`;
  return [
    {
      ...NO_TARGET,
      id: `done:${goal.featureId}`,
      kind: 'done_criteria',
      title: `Definition of done · ${goal.title}`,
      detail: goal.awaitsDefinition
        ? `Every delivery is done; ${String(met)} of ${String(total)} criteria are met. Check or waive the rest to complete the objective.${proposals}`
        : `${String(met)} of ${String(total)} criteria met.${proposals}`,
      since: goal.updatedAt,
      featureId: goal.featureId,
    },
  ];
}

/**
 * Scopes a reached spend cap stops.
 *
 * @param repository - Project ledger.
 * @returns One item per stopped scope.
 */
function spendItems(repository: FactoryRepository): InboxItem[] {
  const tasks = new Map(repository.tasks().map((task) => [task.id, task]));
  const features = new Map(repository.features().map((feature) => [feature.id, feature]));
  const now = repository.store.now();
  return openBlocks(repository, spendGate(repository)).map((block): InboxItem => {
    const task = block.scope === 'delivery' ? tasks.get(block.id) : undefined;
    const feature = block.scope === 'objective' ? features.get(block.id) : undefined;
    let name = 'Project';
    if (task !== undefined) {
      name = `#${String(task.issue)} ${task.title}`;
    } else if (feature !== undefined) {
      name = titleOf(feature.objective);
    }
    return {
      ...NO_TARGET,
      id: `spend:${block.scope}:${block.id}:${block.reason}`,
      kind: 'spend_cap',
      title: `Spend cap · ${name}`,
      detail: block.message,
      since: task?.updatedAt ?? feature?.updatedAt ?? now,
      taskId: task?.id ?? null,
      featureId: feature?.id ?? null,
    };
  });
}

/**
 * The first line of an objective, bounded for a card.
 *
 * @param objective - Full objective or brief text.
 * @returns Title without Markdown heading markers.
 */
function titleOf(objective: string): string {
  const first = objective.split('\n').find((candidate) => candidate.trim().length > 0) ?? objective;
  const line = first.replaceAll('#', '').trim();
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
}

/**
 * Decisions waiting on one delivery.
 *
 * @param task - Delivery to inspect.
 * @param features - Objectives, for deliveries without a frozen workflow.
 * @returns Approval and blocker items.
 */
function deliveryItems(task: FactoryTask, features: readonly Feature[]): InboxItem[] {
  const workflow = taskWorkflow(task, features);
  const items = awaitingApproval(task, workflow).map((step): InboxItem => {
    return {
      ...NO_TARGET,
      id: `approval:${task.id}:${step.id}`,
      kind: 'approval',
      title: `${step.title} · #${String(task.issue)} ${task.title}`,
      detail:
        step.kind === 'approve'
          ? 'Approve to continue, or reject with what must change.'
          : 'This gated step finished and waits for your approval.',
      since: task.updatedAt,
      taskId: task.id,
      stepId: step.id,
      head: approvalSource(task, workflow, step)?.head ?? null,
    };
  });
  if (task.phase === 'blocked') {
    items.push({
      ...NO_TARGET,
      id: `blocked:${task.id}`,
      kind: 'blocked_delivery',
      lane: 'notice',
      title: `Blocked · #${String(task.issue)} ${task.title}`,
      detail: task.error ?? 'Stopped without a recorded reason.',
      since: task.updatedAt,
      taskId: task.id,
    });
  }
  return items;
}

/**
 * Decisions waiting on one objective's planning.
 *
 * @param feature - Objective to inspect.
 * @returns Plan approval and blocker items.
 */
function objectiveItems(feature: Feature): InboxItem[] {
  const items = planningApprovals(feature, featureWorkflow(feature)).map((step): InboxItem => {
    return {
      ...NO_TARGET,
      id: `plan:${feature.id}:${step.id}`,
      kind: 'plan_approval',
      title: `${step.title} · ${titleOf(feature.objective)}`,
      detail: 'Approve the plan to create its deliveries, or reject it with what must change.',
      since: feature.updatedAt,
      featureId: feature.id,
      stepId: step.id,
    };
  });
  if (feature.phase === 'blocked') {
    items.push({
      ...NO_TARGET,
      id: `objective:${feature.id}`,
      kind: 'blocked_objective',
      lane: 'notice',
      title: `Planning stopped · ${titleOf(feature.objective)}`,
      detail: feature.error ?? 'Stopped without a recorded reason.',
      since: feature.updatedAt,
      featureId: feature.id,
    });
  }
  return items;
}

/**
 * Every decision waiting on the human, oldest first.
 *
 * @param repository - Project ledger, for skill decisions.
 * @param tasks - Current deliveries.
 * @param features - Current objectives.
 * @returns Open Inbox items.
 */
function openItems(
  repository: FactoryRepository,
  tasks: readonly FactoryTask[],
  features: readonly Feature[],
): InboxItem[] {
  const skills = repository
    .skillRequests()
    .filter((request) => request.status === 'awaiting_operator')
    .map((request): InboxItem => {
      return {
        ...NO_TARGET,
        id: `skill:${request.id}`,
        kind: 'skill',
        title: `Skill ${request.state === 'active' ? 'adoption' : 'retirement'} · ${request.name}`,
        detail: request.leadSummary ?? request.reason,
        since: request.reviewedAt ?? request.requestedAt,
        requestId: request.id,
      };
    });
  const current = features.filter((feature) => feature.scopeReplacement === undefined);
  const questions = questionsStatus(repository.store).open.map((question): InboxItem => {
    return {
      ...NO_TARGET,
      id: `question:${question.id}`,
      kind: 'question',
      title: `${question.role} asks · ${subjectOf(question, tasks, features)}`,
      detail: question.question,
      since: question.askedAt,
      taskId: question.taskId,
      featureId: question.taskId === null ? question.featureId : null,
      stepId: question.stepId,
      questionId: question.id,
      choices: question.choices,
      allowText: question.allowText,
    };
  });
  return [
    ...questions,
    ...tasks.flatMap((task) => deliveryItems(task, features)),
    ...current.flatMap((feature) => objectiveItems(feature)),
    // Inbox items read only the checklist, so no attempted-step lookup is needed.
    ...current.flatMap((feature) => definitionItems(goalView(feature, tasks, new Set()))),
    ...spendItems(repository),
    ...skills,
  ].toSorted((left, right) => left.since - right.since);
}

/**
 * What a question is about, as its Inbox title names it.
 *
 * @param question - Stored question.
 * @param tasks - Current deliveries.
 * @param features - Current objectives.
 * @returns Delivery issue and title, or objective title.
 */
function subjectOf(question: Question, tasks: readonly FactoryTask[], features: readonly Feature[]): string {
  const task = tasks.find((candidate) => candidate.id === question.taskId);
  if (task !== undefined) {
    return `#${String(task.issue)} ${task.title}`;
  }
  const feature = features.find((candidate) => candidate.id === question.featureId);
  return feature === undefined ? 'earlier work' : titleOf(feature.objective);
}

/**
 * The operator's answer as one line.
 *
 * @param answer - Recorded answer.
 * @param answer.choice - Chosen option, if any.
 * @param answer.text - Written answer, possibly empty.
 * @returns Choice and text joined.
 */
function answerText(answer: { choice: string | null; text: string }): string {
  return [answer.choice, answer.text].filter((part) => part !== null && part !== '').join(' — ');
}

/**
 * Recent human approvals and answers, newest first.
 *
 * @param repository - Project ledger, for answered questions.
 * @param tasks - Current deliveries.
 * @param features - Current objectives.
 * @returns Answered Inbox items.
 */
function answeredItems(
  repository: FactoryRepository,
  tasks: readonly FactoryTask[],
  features: readonly Feature[],
): AnsweredItem[] {
  const fromQuestions = questionsStatus(repository.store).answered.map((question) => {
    return {
      id: question.answer?.requestId ?? question.id,
      title: `Answered ${question.role} · ${subjectOf(question, tasks, features)}`,
      note: `${question.question}
→ ${answerText(question.answer ?? { choice: null, text: '' })}`,
      at: question.answer?.at ?? question.askedAt,
    };
  });
  const fromTasks = tasks.flatMap((task) => {
    return task.approvals.map((approval) => {
      return {
        id: approval.requestId,
        title: `Approved ${approval.stepId} · #${String(task.issue)} ${task.title}`,
        note: approval.note,
        at: approval.at,
      };
    });
  });
  const fromFeatures = features.flatMap((feature) => {
    return feature.approvals.map((approval) => {
      return {
        id: approval.requestId,
        title: `Approved ${approval.stepId} · ${titleOf(feature.objective)}`,
        note: approval.note,
        at: approval.at,
      };
    });
  });
  return [...fromQuestions, ...fromTasks, ...fromFeatures]
    .toSorted((left, right) => right.at - left.at)
    .slice(0, ANSWERED_LIMIT);
}

/**
 * Build the complete console projection.
 *
 * @param repository - Project ledger.
 * @returns Board, pipelines and Inbox.
 */
export function consoleView(repository: FactoryRepository): ConsoleView {
  const tasks = repository.tasks().filter((task) => task.scopeReplacement === undefined);
  const features = repository.features();
  const jobs = repository.jobs();
  const live = jobs.filter((job) => job.state === 'running');
  const now = repository.store.now();
  const timing = { now, reconcileMs: repository.config()?.reconcileMs ?? RECONCILE_FALLBACK_MS };
  const attempted = attemptedSteps(repository);
  const archived = tasks.filter((task) => isArchived(task, now));
  const done = tasks.filter((task) => task.phase === 'done' && !isArchived(task, now)).slice(-DONE_ON_BOARD);
  const shown = [...tasks.filter((task) => task.phase !== 'done'), ...done];
  const current = features.filter((feature) => feature.scopeReplacement === undefined);
  const planning = current.filter((feature) => PLANNING_PHASES.has(feature.phase));
  return {
    deliveries: shown.map((task) => deliveryView(task, { tasks, features, live, jobs, timing, attempted })),
    objectives: planning.map((feature) => objectiveView(feature, tasks, live)),
    goals: [
      ...current.filter((feature) => feature.phase === 'done').slice(-DONE_GOALS),
      ...current.filter((feature) => feature.phase !== 'done'),
    ].map((feature) => goalView(feature, tasks, attempted)),
    archived: {
      total: archived.length,
      recent: archived
        .slice(-DONE_ON_BOARD)
        .toReversed()
        .map((task) => ({ taskId: task.id, issue: task.issue, title: task.title })),
    },
    inbox: { open: openItems(repository, tasks, features), answered: answeredItems(repository, tasks, features) },
  };
}
