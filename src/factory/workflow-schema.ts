/**
 * Workflow definitions as pure data: the closed set of step kinds, the schemas,
 * every validation rule, execution layers and content digests. This module has
 * no storage or protocol dependencies, so persistence schemas can embed a
 * frozen workflow without import cycles. The revisioned library lives in
 * `workflows.ts`.
 *
 * @file
 */

import { z } from 'zod/v3';

import { FACTORY_ROLES, PROVIDERS, keySchema } from './schema.ts';

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
export const workflowShape = z
  .object({
    version: z.literal(1).default(1),
    id: keySchema,
    name: z.string().trim().min(1).max(TITLE_MAX),
    description: z.string().max(DESCRIPTION_MAX).default(''),
    planning: z.array(workflowStepSchema).max(MAX_PLANNING_STEPS),
    delivery: z.array(workflowStepSchema).min(1).max(MAX_DELIVERY_STEPS),
  })
  .strict();

/**
 * Check rules shared by both sections: allowed kinds, ordering edges and inputs.
 *
 * @param steps - One section in execution order.
 * @param kinds - Kinds this section accepts.
 * @param section - Section name for messages.
 * @returns Problems found.
 */
export function sectionProblems(steps: readonly WorkflowStep[], kinds: readonly string[], section: string): string[] {
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
