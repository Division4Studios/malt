/**
 * Configurable workflows: which steps an objective and each of its deliveries
 * pass through, who performs them, and where a human must approve.
 *
 * A workflow has two sections. Planning steps run once per objective and turn it
 * into atomic deliveries; an empty planning section makes the objective itself
 * the single delivery. Delivery steps run for every delivery from implementation
 * to verified main. Steps use a closed set of kinds, each with fixed semantics,
 * so a workflow is data that can be validated completely before anything runs.
 *
 * Built-in workflows ship in `resources/workflows`. Projects save their own
 * workflows as immutable revisions in SQLite. Each objective freezes the exact
 * revision it started with, so editing a workflow never changes running work.
 *
 * @file
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { z } from 'zod/v3';

import { run, selectAll, selectOne } from '../database.ts';
import { MeshError } from '../protocol.ts';

import { FACTORY_ROLES, PROVIDERS, factorySchemas, keySchema } from './schema.ts';

import type { Store } from '../store.ts';

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
/** Revisions listed per workflow in the console. */
const HISTORY_LIMIT = 50;
/** A revision is the SHA-256 of the validated definition. */
const revisionSchema = z.string().regex(/^[\da-f]{64}$/v);
/** Built-in workflow definitions shipped with the source. */
const BUILTIN_DIRECTORY = path.resolve(import.meta.dirname, '..', '..', 'resources', 'workflows');

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

/** Built-ins are validated once; the source directory does not change while the process runs. */
const builtinCache: { workflows: readonly Workflow[] | null } = { workflows: null };

/**
 * Built-in workflows, validated once. A broken built-in is a packaging defect.
 *
 * @returns Built-ins with the default first, then by name.
 * @throws {Error} When a shipped definition is invalid.
 */
export function builtinWorkflows(): readonly Workflow[] {
  if (builtinCache.workflows === null) {
    const files = readdirSync(BUILTIN_DIRECTORY).filter((file) => file.endsWith('.json'));
    const parsed = files.map((file) => {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- File names come from the fixed resources directory listing above.
      const raw: unknown = JSON.parse(readFileSync(path.join(BUILTIN_DIRECTORY, file), 'utf8'));
      return workflowSchema.parse(raw);
    });
    builtinCache.workflows = parsed.toSorted((left, right) => {
      const rank = Number(right.id === DEFAULT_WORKFLOW_ID) - Number(left.id === DEFAULT_WORKFLOW_ID);
      return rank === 0 ? left.name.localeCompare(right.name) : rank;
    });
  }
  return builtinCache.workflows;
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

/** Stored revision row. */
const revisionRow = z.object({ revision: z.string(), data: z.string(), created_at: z.number() });
/** Current revision pointer row. */
const headRow = z.object({ id: z.string(), revision: z.string(), updated_at: z.number() });

/** Project workflow library: built-ins plus immutable project revisions. */
export class WorkflowLibrary {
  /** Shared transaction owner. */
  private readonly store: Store;

  /**
   * Create the additive tables without touching existing factory state.
   *
   * @param store - Selected project's SQLite owner.
   */
  public constructor(store: Store) {
    this.store = store;
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS factory_workflow_revisions (id TEXT NOT NULL, revision TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(id, revision));
      CREATE TABLE IF NOT EXISTS factory_workflow_heads (id TEXT PRIMARY KEY, revision TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS factory_workflow_default (id INTEGER PRIMARY KEY CHECK(id = 1), workflow TEXT NOT NULL);
    `);
  }

  /**
   * Projection for status and the console.
   *
   * @returns The default id plus every usable workflow.
   */
  public status(): z.output<typeof workflowLibrarySchema> {
    return { defaultId: this.defaultId(), items: this.list() };
  }

  /**
   * Every workflow this project can use.
   *
   * @returns Built-ins followed by project workflows.
   */
  public list(): WorkflowSummary[] {
    const defaultId = this.defaultId();
    const shipped = builtinWorkflows().map((workflow) => {
      return {
        id: workflow.id,
        workflow,
        revision: workflowDigest(workflow),
        source: 'builtin' as const,
        isDefault: workflow.id === defaultId,
        updatedAt: null,
      };
    });
    const heads = selectAll(
      this.store.db,
      headRow,
      'SELECT id, revision, updated_at FROM factory_workflow_heads ORDER BY id',
    );
    const saved = heads.map((head) => {
      return {
        id: head.id,
        workflow: this.revision(head.id, head.revision),
        revision: head.revision,
        source: 'project' as const,
        isDefault: head.id === defaultId,
        updatedAt: head.updated_at,
      };
    });
    return [...shipped, ...saved];
  }

  /**
   * Revision history of one project workflow, newest first.
   *
   * @param id - Project workflow whose saved revisions to list.
   * @returns Bounded revision list.
   */
  public history(id: string): { revision: string; createdAt: number; workflow: Workflow }[] {
    const rows = selectAll(
      this.store.db,
      revisionRow,
      'SELECT revision, data, created_at FROM factory_workflow_revisions WHERE id = ? ORDER BY created_at DESC, revision LIMIT ?',
      id,
      HISTORY_LIMIT,
    );
    return rows.map((row) => {
      return {
        revision: row.revision,
        createdAt: row.created_at,
        workflow: workflowSchema.parse(JSON.parse(row.data)),
      };
    });
  }

  /**
   * Save a new revision. Built-in ids are reserved; clone them under a new id.
   *
   * @param input - Untrusted definition and the revision the editor started from.
   * @returns The saved revision summary.
   * @throws {MeshError} For invalid definitions, reserved ids or concurrent edits.
   */
  public save(input: unknown): WorkflowSummary {
    const { workflow: raw, expectedRevision } = factorySchemas.factory_workflow_save.parse(input);
    const parsed = workflowSchema.safeParse(raw);
    if (!parsed.success) {
      throw new MeshError('INVALID_INPUT', parsed.error.issues.map((issue) => issue.message).join(' '));
    }
    const workflow = parsed.data;
    if (builtinWorkflows().some((candidate) => candidate.id === workflow.id)) {
      throw new MeshError('INVALID_INPUT', `"${workflow.id}" is a built-in workflow; save a copy under a new id.`);
    }
    const revision = workflowDigest(workflow);
    return this.store.transaction(() => {
      const head = this.head(workflow.id);
      if ((head?.revision ?? null) !== expectedRevision) {
        throw new MeshError(
          'INVALID_REVISION',
          'This workflow changed since you opened it. Reload and reapply your edit.',
        );
      }
      const now = this.store.now();
      if (head?.revision !== revision) {
        run(
          this.store.db,
          'INSERT OR IGNORE INTO factory_workflow_revisions(id, revision, data, created_at) VALUES (?, ?, ?, ?)',
          workflow.id,
          revision,
          JSON.stringify(workflow),
          now,
        );
        run(
          this.store.db,
          'INSERT INTO factory_workflow_heads(id, revision, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, updated_at = excluded.updated_at',
          workflow.id,
          revision,
          now,
        );
      }
      return {
        id: workflow.id,
        workflow,
        revision,
        source: 'project',
        isDefault: this.defaultId() === workflow.id,
        updatedAt: now,
      };
    });
  }

  /**
   * Choose the workflow new objectives use.
   *
   * @param input - Untrusted workflow id.
   * @throws {MeshError} For an unknown workflow.
   */
  public setDefault(input: unknown): void {
    const { workflowId } = factorySchemas.factory_workflow_default.parse(input);
    this.store.transaction(() => {
      if (this.find(workflowId) === null) {
        throw new MeshError('NOT_FOUND', `No workflow named "${workflowId}".`);
      }
      run(
        this.store.db,
        'INSERT INTO factory_workflow_default(id, workflow) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET workflow = excluded.workflow',
        workflowId,
      );
    });
  }

  /**
   * The id new objectives use; falls back to the built-in default.
   *
   * @returns Identifier of the saved default, or the built-in default when none is set.
   */
  public defaultId(): string {
    const row = selectOne(
      this.store.db,
      z.object({ workflow: z.string() }),
      'SELECT workflow FROM factory_workflow_default WHERE id = 1',
    );
    return row?.workflow ?? DEFAULT_WORKFLOW_ID;
  }

  /**
   * Freeze the current revision of a workflow for a new objective.
   *
   * @param id - Requested workflow, or `null` for the project default.
   * @returns Exact definition and revision.
   * @throws {MeshError} For an unknown requested workflow.
   */
  public freeze(id: string | null = null): FrozenWorkflow {
    const wanted = id ?? this.defaultId();
    // A deleted default falls back to the built-in default rather than blocking new work.
    const found = this.find(wanted) ?? (id === null ? this.find(DEFAULT_WORKFLOW_ID) : null);
    if (found === null) {
      throw new MeshError('NOT_FOUND', `No workflow named "${wanted}".`);
    }
    return found;
  }

  /**
   * Resolve the current project revision, or a built-in.
   *
   * @param id - Identifier to look up among project workflows first, then built-ins.
   * @returns Frozen definition, or `null` when unknown.
   */
  private find(id: string): FrozenWorkflow | null {
    const head = this.head(id);
    if (head !== undefined) {
      return { id, revision: head.revision, workflow: this.revision(id, head.revision) };
    }
    const shipped = builtinWorkflows().find((workflow) => workflow.id === id);
    return shipped === undefined ? null : { id, revision: workflowDigest(shipped), workflow: shipped };
  }

  /**
   * Current revision pointer for one project workflow.
   *
   * @param id - Project workflow whose current revision pointer to read.
   * @returns Pointer row, when the project saved this workflow.
   */
  private head(id: string): z.output<typeof headRow> | undefined {
    return selectOne(
      this.store.db,
      headRow,
      'SELECT id, revision, updated_at FROM factory_workflow_heads WHERE id = ?',
      id,
    );
  }

  /**
   * Load one immutable revision.
   *
   * @param id - Project workflow that owns the revision.
   * @param revision - SHA-256 digest of the definition to load.
   * @returns Validated definition.
   * @throws {MeshError} When the revision is missing.
   */
  private revision(id: string, revision: string): Workflow {
    const row = selectOne(
      this.store.db,
      revisionRow,
      'SELECT revision, data, created_at FROM factory_workflow_revisions WHERE id = ? AND revision = ?',
      id,
      revision,
    );
    if (row === undefined) {
      throw new MeshError('NOT_FOUND', `Workflow ${id} revision ${revision} is missing.`);
    }
    return workflowSchema.parse(JSON.parse(row.data));
  }
}

/** One library per open store, so every caller shares the same table setup. */
const libraries = new WeakMap<Store, WorkflowLibrary>();

/**
 * The workflow library of one project store.
 *
 * @param store - Selected project's SQLite owner.
 * @returns Shared library instance for that store.
 */
export function workflowLibrary(store: Store): WorkflowLibrary {
  const existing = libraries.get(store);
  if (existing !== undefined) {
    return existing;
  }
  const library = new WorkflowLibrary(store);
  libraries.set(store, library);
  return library;
}
