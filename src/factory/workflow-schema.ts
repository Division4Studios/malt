/**
 * Workflow definitions as pure data: the closed set of step kinds, the schemas,
 * every validation rule, execution layers and content digests. This module has
 * no storage or protocol dependencies, so persistence schemas can embed a
 * frozen workflow without import cycles. The revisioned library lives in
 * `workflows.ts`.
 *
 * @file
 */

import { createHash } from 'node:crypto';

import { z } from 'zod/v3';

import { FACTORY_ROLES, PROVIDERS, keySchema } from './seats.ts';

/** Steps that turn an objective into atomic deliveries. */
export const PLANNING_STEP_KINDS = ['specify', 'plan', 'plan_review', 'plan_revise', 'approve'] as const;
/** Steps that carry one delivery from implementation to verified main. */
export const DELIVERY_STEP_KINDS = [
  'implement',
  'review',
  'adjudicate',
  'document',
  'regress',
  'approve',
  'final',
  'verify',
] as const;
/** Every supported step kind; `approve` appears in both sections. */
export const STEP_KINDS = [
  'specify',
  'plan',
  'plan_review',
  'plan_revise',
  'implement',
  'review',
  'adjudicate',
  'document',
  'regress',
  'approve',
  'final',
  'verify',
] as const;
/** The default for projects that never chose a workflow; reproduces MALT's original pipeline. */
export const DEFAULT_WORKFLOW_ID = 'malt-assured';
/** Kinds every workflow that has them must run; they cannot be skipped. */
const REQUIRED_KINDS: ReadonlySet<string> = new Set(['plan', 'implement', 'final', 'verify']);
/** The final check and main verification act on merges; a human approves before them instead. */
const UNGATED_KINDS: ReadonlySet<string> = new Set(['final', 'verify']);
/** Seats that own a delivery branch and worktree. */
const DEVELOPER_SEATS: ReadonlySet<string> = new Set(['developer-1', 'developer-2']);
/** Bound one workflow independently of process admission. */
const MAX_PLANNING_STEPS = 12;
/** Bound one delivery's steps. */
const MAX_DELIVERY_STEPS = 24;
/** Bound extra per-step instructions; role prompts carry the bulk of guidance. */
const INSTRUCTIONS_MAX = 8000;
/** Short public label. */
const TITLE_MAX = 120;
/** Bound workflow descriptions. */
const DESCRIPTION_MAX = 2000;
/** Seats that may take one step. */
const MAX_STEP_ROLES = 4;
/** A revision is the SHA-256 of the validated definition. */
const revisionSchema = z.string().regex(/^[\da-f]{64}$/v);

/** One step definition, validated against its section by {@link workflowSchema}. */
export const workflowStepSchema = z
  .object({
    id: keySchema,
    kind: z.enum(STEP_KINDS),
    title: z.string().trim().min(1).max(TITLE_MAX),
    roles: z.array(z.enum(FACTORY_ROLES)).max(MAX_STEP_ROLES).default([]),
    /** Organization profile used instead of the seat's own type for this step. */
    profile: keySchema.nullable().default(null),
    after: z.array(keySchema).max(MAX_DELIVERY_STEPS).default([]),
    /** Earlier steps whose outputs this step may read; `null` means its ancestors. */
    inputs: z.array(keySchema).max(MAX_DELIVERY_STEPS).nullable().default(null),
    /** Review only: receive no peer findings, notes or feedback. */
    blind: z.boolean().default(false),
    /** Require a human approval in the Inbox after this step succeeds. */
    gate: z.boolean().default(false),
    /** The operator may skip this step for one delivery. */
    optional: z.boolean().default(false),
    /** Preferred provider family, for cross-family review; `null` uses normal routing. */
    provider: z.enum(PROVIDERS).nullable().default(null),
    instructions: z.string().max(INSTRUCTIONS_MAX).default(''),
  })
  .strict();
/** A validated step. */
export type WorkflowStep = z.output<typeof workflowStepSchema>;
/** A step kind. */
export type StepKind = WorkflowStep['kind'];

/** Unvalidated workflow shape; {@link workflowSchema} adds the graph and independence rules. */
const workflowShape = z
  .object({
    version: z.literal(1).default(1),
    id: keySchema,
    name: z.string().trim().min(1).max(TITLE_MAX),
    description: z.string().max(DESCRIPTION_MAX).default(''),
    planning: z.array(workflowStepSchema).max(MAX_PLANNING_STEPS),
    delivery: z.array(workflowStepSchema).min(1).max(MAX_DELIVERY_STEPS),
  })
  .strict();

/** A complete, validated workflow. */
export const workflowSchema = workflowShape.superRefine((workflow, context) => {
  for (const problem of workflowProblems(workflow)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: problem });
  }
});
/** A validated workflow. */
export type Workflow = z.output<typeof workflowSchema>;

/**
 * Explain every rule a workflow breaks, in plain language for the editor.
 *
 * @param workflow - Shape-valid workflow.
 * @returns Problems; empty when the workflow can run.
 */
export function workflowProblems(workflow: z.output<typeof workflowShape>): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const section of [workflow.planning, workflow.delivery]) {
    for (const step of section) {
      if (ids.has(step.id)) {
        problems.push(`Step id "${step.id}" is used more than once.`);
      }
      ids.add(step.id);
    }
  }
  problems.push(
    ...sectionProblems(workflow.planning, PLANNING_STEP_KINDS, 'planning'),
    ...sectionProblems(workflow.delivery, DELIVERY_STEP_KINDS, 'delivery'),
    ...planningProblems(workflow.planning),
    ...deliveryProblems(workflow.delivery),
  );
  return problems;
}

/**
 * Check rules shared by both sections: allowed kinds, ordering edges and inputs.
 *
 * @param steps - One section in execution order.
 * @param kinds - Kinds this section accepts.
 * @param section - Section name for messages.
 * @returns Problems found.
 */
function sectionProblems(steps: readonly WorkflowStep[], kinds: readonly string[], section: string): string[] {
  const problems: string[] = [];
  const earlier = new Set<string>();
  for (const step of steps) {
    if (!kinds.includes(step.kind)) {
      problems.push(`"${step.title}" uses kind ${step.kind}, which is not allowed in the ${section} section.`);
    }
    for (const id of step.after) {
      if (!earlier.has(id)) {
        problems.push(`"${step.title}" must come after "${id}", which is not an earlier ${section} step.`);
      }
    }
    problems.push(...inputProblems(steps, step), ...stepShapeProblems(step));
    earlier.add(step.id);
  }
  return problems;
}

/**
 * A step may only read outputs of steps that finish before it.
 *
 * @param steps - Its section.
 * @param step - The reading step.
 * @returns Problems found.
 */
function inputProblems(steps: readonly WorkflowStep[], step: WorkflowStep): string[] {
  if (step.inputs === null) {
    return [];
  }
  const ancestors = ancestorIds(steps, step.id);
  return step.inputs
    .filter((id) => !ancestors.has(id))
    .map((id) => `"${step.title}" reads "${id}", which does not run before it.`);
}

/**
 * Per-step field rules: who performs it, blindness and whether it may be skipped.
 *
 * @param step - One step.
 * @returns Problems found.
 */
function stepShapeProblems(step: WorkflowStep): string[] {
  const problems: string[] = [];
  if (step.kind === 'approve' && (step.roles.length > 0 || step.gate || step.blind)) {
    problems.push(`"${step.title}" is a human approval; it has no roles, gate or blind setting.`);
  }
  if (step.kind !== 'approve' && step.roles.length === 0) {
    problems.push(`"${step.title}" needs at least one role.`);
  }
  if (step.blind && step.kind !== 'review') {
    problems.push(`"${step.title}" cannot be blind; only reviews are.`);
  }
  if (step.optional && REQUIRED_KINDS.has(step.kind)) {
    problems.push(`"${step.title}" is required and cannot be optional.`);
  }
  if (step.gate && UNGATED_KINDS.has(step.kind)) {
    problems.push(`"${step.title}" cannot be gated; add an approval step before the final check instead.`);
  }
  return problems;
}

/**
 * Count the steps of one kind.
 *
 * @param steps - One section.
 * @param kind - Kind to count.
 * @returns Matching steps in order.
 */
function stepsOf(steps: readonly WorkflowStep[], kind: StepKind): WorkflowStep[] {
  return steps.filter((step) => step.kind === kind);
}

/**
 * Whether two steps share a seat.
 *
 * @param left - First step.
 * @param right - Second step.
 * @returns True when any role appears in both.
 */
function hasSharedRole(left: WorkflowStep, right: WorkflowStep): boolean {
  return left.roles.some((role) => right.roles.includes(role));
}

/**
 * Planning must produce exactly one delivery list, in a sensible order.
 *
 * @param steps - Planning section.
 * @returns Problems found.
 */
function planningProblems(steps: readonly WorkflowStep[]): string[] {
  if (steps.length === 0) {
    return [];
  }
  const problems: string[] = [];
  const [plan] = stepsOf(steps, 'plan');
  const [specify] = stepsOf(steps, 'specify');
  if (stepsOf(steps, 'plan').length !== 1) {
    problems.push('Planning needs exactly one plan step, which produces the deliveries.');
  }
  if (stepsOf(steps, 'specify').length > 1 || stepsOf(steps, 'plan_revise').length > 1) {
    problems.push('Planning allows at most one specify step and one revision step.');
  }
  if (specify !== undefined && plan !== undefined && !ancestorIds(steps, plan.id).has(specify.id)) {
    problems.push('The plan step must come after the specify step.');
  }
  return [...problems, ...planReviewProblems(steps, plan)];
}

/**
 * Reviewed plans are revised, and nobody reviews their own plan.
 *
 * @param steps - Planning section.
 * @param plan - Its plan step, if present.
 * @returns Problems found.
 */
function planReviewProblems(steps: readonly WorkflowStep[], plan: WorkflowStep | undefined): string[] {
  const problems: string[] = [];
  const reviews = stepsOf(steps, 'plan_review');
  const [revise] = stepsOf(steps, 'plan_revise');
  for (const review of reviews) {
    if (plan === undefined || !ancestorIds(steps, review.id).has(plan.id)) {
      problems.push(`"${review.title}" must come after the plan step.`);
    } else if (hasSharedRole(review, plan)) {
      problems.push('The planner cannot review its own plan.');
    }
  }
  if (revise === undefined && reviews.length > 0) {
    problems.push('A reviewed plan needs a revision step that addresses the findings.');
  }
  if (revise !== undefined) {
    const before = ancestorIds(steps, revise.id);
    if (reviews.length === 0 || reviews.some((review) => !before.has(review.id))) {
      problems.push('The revision step must come after every plan review.');
    }
    if (reviews.some((review) => hasSharedRole(review, revise))) {
      problems.push('A plan reviewer cannot also revise the plan it reviewed.');
    }
  }
  return problems;
}

/**
 * Delivery steps must implement, independently review, merge once and verify main.
 *
 * @param steps - Delivery section.
 * @returns Problems found.
 */
function deliveryProblems(steps: readonly WorkflowStep[]): string[] {
  const [implement] = stepsOf(steps, 'implement');
  const [final] = stepsOf(steps, 'final');
  const authors = new Set([implement, ...stepsOf(steps, 'adjudicate')].flatMap((step) => step?.roles ?? []));
  return [
    ...deliveryShapeProblems(steps, implement, final),
    ...reviewProblems(steps, implement, final, authors),
    ...adjudicationProblems(steps, authors),
  ];
}

/**
 * Implement first; final then verify last; nothing runs after the final check except verify.
 *
 * @param steps - Delivery section.
 * @param implement - Its implement step, if present.
 * @param final - Its final step, if present.
 * @returns Problems found.
 */
function deliveryShapeProblems(
  steps: readonly WorkflowStep[],
  implement: WorkflowStep | undefined,
  final: WorkflowStep | undefined,
): string[] {
  const problems: string[] = [];
  if (stepsOf(steps, 'implement').length !== 1 || steps[0] !== implement || implement?.after.length !== 0) {
    problems.push('Delivery needs exactly one implement step, and it must be first.');
  }
  if (implement?.roles.some((role) => !DEVELOPER_SEATS.has(role)) === true) {
    problems.push('Implementation runs on developer seats (developer-1, developer-2).');
  }
  if (stepsOf(steps, 'final').length !== 1 || stepsOf(steps, 'verify').length !== 1) {
    problems.push('Delivery needs exactly one final step and one verify step.');
  }
  const verify = steps.at(-1);
  if (final === undefined || verify?.kind !== 'verify' || !verify.after.includes(final.id)) {
    problems.push('The verify step must be last and come directly after the final step.');
  }
  return [...problems, ...finalJoinProblems(steps, final)];
}

/**
 * The final check joins every other step, so nothing changes code after it.
 *
 * @param steps - Delivery section.
 * @param final - Its final step, if present.
 * @returns Problems found.
 */
function finalJoinProblems(steps: readonly WorkflowStep[], final: WorkflowStep | undefined): string[] {
  if (final === undefined) {
    return [];
  }
  const before = ancestorIds(steps, final.id);
  return steps
    .filter((step) => step !== final && step.kind !== 'verify' && !before.has(step.id))
    .map((step) => `"${step.title}" must finish before the final step.`);
}

/**
 * At least one review; reviewers and the final checker are independent of authors.
 *
 * @param steps - Delivery section.
 * @param implement - Its implement step, if present.
 * @param final - Its final step, if present.
 * @param authors - Roles that write code.
 * @returns Problems found.
 */
function reviewProblems(
  steps: readonly WorkflowStep[],
  implement: WorkflowStep | undefined,
  final: WorkflowStep | undefined,
  authors: ReadonlySet<string>,
): string[] {
  const problems: string[] = [];
  const reviews = stepsOf(steps, 'review');
  if (reviews.length === 0) {
    problems.push('Delivery needs at least one independent review.');
  }
  for (const review of reviews) {
    if (implement !== undefined && hasSharedRole(review, implement)) {
      problems.push(`"${review.title}" cannot be performed by the implementer.`);
    }
  }
  if (final?.roles.some((role) => authors.has(role)) === true) {
    problems.push('The final step must be independent of everyone who wrote code.');
  }
  return problems;
}

/**
 * Whoever writes code never judges it: fixers are not reviewers, regressions are independent.
 *
 * @param steps - Delivery section.
 * @param authors - Roles that write code.
 * @returns Problems found.
 */
function adjudicationProblems(steps: readonly WorkflowStep[], authors: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  const reviews = stepsOf(steps, 'review');
  const fixes = stepsOf(steps, 'adjudicate');
  const [fix] = fixes;
  if (fixes.length > 1) {
    problems.push('Delivery allows at most one adjudicate step.');
  }
  if (fix !== undefined) {
    const before = ancestorIds(steps, fix.id);
    if (reviews.some((review) => !before.has(review.id))) {
      problems.push('The adjudicate step must come after every review.');
    }
    if (reviews.some((review) => hasSharedRole(review, fix))) {
      problems.push('A reviewer cannot also adjudicate and fix its own findings.');
    }
  }
  for (const regress of stepsOf(steps, 'regress')) {
    if (fix === undefined || !ancestorIds(steps, regress.id).has(fix.id)) {
      problems.push(`"${regress.title}" verifies adjudicated fixes, so it must come after the adjudicate step.`);
    }
    if (regress.roles.some((role) => authors.has(role))) {
      problems.push(`"${regress.title}" must be independent of everyone who wrote code.`);
    }
  }
  return problems;
}

/**
 * Every step reachable backwards through `after` edges.
 *
 * @param steps - One section.
 * @param id - Starting step.
 * @returns Ancestor ids, excluding the step itself.
 */
export function ancestorIds(steps: readonly WorkflowStep[], id: string): Set<string> {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const found = new Set<string>();
  const pending = [...(byId.get(id)?.after ?? [])];
  while (pending.length > 0) {
    const next = pending.pop();
    if (next === undefined || found.has(next)) {
      continue;
    }
    found.add(next);
    pending.push(...(byId.get(next)?.after ?? []));
  }
  return found;
}

/**
 * Execution layers: steps sharing a layer may run in parallel; the next layer joins them.
 *
 * @param steps - One section in execution order.
 * @returns One-based layer for each step id.
 */
export function stepLayers(steps: readonly WorkflowStep[]): Map<string, number> {
  const layers = new Map<string, number>();
  for (const step of steps) {
    layers.set(step.id, 1 + Math.max(0, ...step.after.map((id) => layers.get(id) ?? 0)));
  }
  return layers;
}

/**
 * Content identity of a workflow, computed from its validated, ordered definition.
 *
 * @param workflow - Validated workflow.
 * @returns Lowercase SHA-256 hex.
 */
export function workflowDigest(workflow: Workflow): string {
  return createHash('sha256').update(JSON.stringify(workflow)).digest('hex');
}

/** Library entry shown in the console and status. */
export const workflowSummarySchema = z
  .object({
    /** Stable identifier referenced by objectives and the default setting. */
    id: keySchema,
    /** The definition at the current revision. */
    workflow: workflowSchema,
    /** SHA-256 digest that identifies the current definition exactly. */
    revision: revisionSchema,
    /** Shipped with MALT (read-only, clone to change) or saved by this project. */
    source: z.enum(['builtin', 'project']),
    /** Whether new objectives use this workflow when none is chosen. */
    isDefault: z.boolean(),
    /** Last save time for project workflows; `null` for built-ins. */
    updatedAt: z.number().nullable(),
  })
  .strict();
/** One library entry. */
export type WorkflowSummary = z.output<typeof workflowSummarySchema>;
/** The library as projected into status: the default plus every usable workflow. */
export const workflowLibrarySchema = z.object({ defaultId: keySchema, items: z.array(workflowSummarySchema) }).strict();

/** A workflow frozen into an objective when it starts. */
export const frozenWorkflowSchema = z
  .object({ id: keySchema, revision: revisionSchema, workflow: workflowSchema })
  .strict();
/** A frozen workflow revision. */
export type FrozenWorkflow = z.output<typeof frozenWorkflowSchema>;

/** Bound an operator decision note. */
const NOTE_MAX = 4000;
/** A human approval of one step, bound to the source it judged; planning approvals have no head. */
export const approvalSchema = z.object({
  stepId: keySchema,
  head: z.string().nullable(),
  base: z.string().nullable(),
  note: z.string(),
  at: z.number(),
  requestId: z.string().uuid(),
});
/** A human decision on one approval step or gated step, bound to the source it judged. */
export const approveRequestSchema = z
  .object({
    requestId: z.string().uuid(),
    taskId: z.string().uuid().optional(),
    featureId: z.string().uuid().optional(),
    stepId: keySchema,
    head: z.string().max(TITLE_MAX).nullable(),
    approve: z.boolean(),
    note: z.string().trim().max(NOTE_MAX).default(''),
  })
  .strict();
/** Save request; the library validates the definition, and any revision other than the stored one is stale. */
export const saveWorkflowRequestSchema = z
  .object({ workflow: z.unknown(), expectedRevision: revisionSchema.nullable() })
  .strict();
/** Default workflow selection request. */
export const defaultWorkflowRequestSchema = z.object({ workflowId: keySchema }).strict();
/** Bound dispositions recorded by one fix. */
const MAX_DISPOSITIONS = 200;
/** The fixer's ruling on one review finding, identified as `<reviewStepId>-<n>`. */
export const dispositionSchema = z
  .object({
    id: z.string().min(1).max(TITLE_MAX),
    decision: z.enum(['adopted', 'rejected', 'merged']),
    reason: z.string().min(1).max(NOTE_MAX),
    evidence: z.string().max(NOTE_MAX),
  })
  .strict();
/** One ruling. */
export type Disposition = z.output<typeof dispositionSchema>;
/** A bounded disposition ledger. */
export const dispositionsSchema = z.array(dispositionSchema).max(MAX_DISPOSITIONS);
/** Version of every typed step output; results saved before it existed parse as version 1. */
export const STEP_OUTPUT_VERSION = 1;
/** Output version field shared by every typed step output. */
const outputVersionSchema = z.literal(STEP_OUTPUT_VERSION).default(STEP_OUTPUT_VERSION);
/** A fix-stage step result, bound to the source it produced (fix, docs) or judged (regression). */
export const stepResultSchema = z
  .object({
    schemaVersion: outputVersionSchema,
    stepId: keySchema,
    kind: z.enum(['adjudicate', 'document', 'regress']),
    role: z.enum(FACTORY_ROLES),
    jobId: z.string().uuid(),
    head: z.string(),
    base: z.string(),
    outcome: z.enum(['success', 'changes_requested']),
    summary: z.string(),
    findings: z.array(z.string()).default([]),
    dispositions: dispositionsSchema.default([]),
    at: z.number(),
  })
  .strict();
/** One recorded fix-stage result. */
export type StepResult = z.output<typeof stepResultSchema>;
/** A planning review or revision result, bound to the plan it judged or produced. */
export const planningResultSchema = z
  .object({
    schemaVersion: outputVersionSchema,
    stepId: keySchema,
    kind: z.enum(['plan_review', 'plan_revise']),
    role: z.enum(FACTORY_ROLES),
    jobId: z.string().uuid(),
    outcome: z.enum(['success', 'changes_requested']),
    summary: z.string(),
    findings: z.array(z.string()).default([]),
    dispositions: dispositionsSchema.default([]),
    at: z.number(),
  })
  .strict();
/** One recorded planning result. */
export type PlanningResult = z.output<typeof planningResultSchema>;
/** Bound a commit identity in typed outputs. */
const COMMIT_MAX = 64;

/**
 * A typed specification or plan output: which step produced it, which exact
 * source commit the attempt read, and how many deliveries it named. Brief
 * revalidation compares a delivery's predecessors against this source.
 */
export const planOutputSchema = z
  .object({
    schemaVersion: outputVersionSchema,
    /** Producing step; `null` for objectives planned before workflows. */
    stepId: keySchema.nullable(),
    kind: z.enum(['specify', 'plan', 'plan_revise']),
    role: z.enum(FACTORY_ROLES),
    jobId: z.string().uuid(),
    /** Exact source commit the attempt was sealed to, when known. */
    source: z.string().min(1).max(COMMIT_MAX).nullable(),
    /** Deliveries the output named. */
    deliveries: z.number().int().nonnegative(),
    at: z.number(),
  })
  .strict();
/** One recorded specification or plan output. */
export type PlanOutput = z.output<typeof planOutputSchema>;
