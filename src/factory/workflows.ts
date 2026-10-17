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

import { factorySchemas, keySchema } from './schema.ts';
import {
  PLANNING_STEP_KINDS,
  DELIVERY_STEP_KINDS,
  DEFAULT_WORKFLOW_ID,
  workflowShape,
  ancestorIds,
  sectionProblems,
  stepsOf,
  hasSharedRole,
  planningProblems,
  deliveryShapeProblems,
  reviewProblems,
} from './workflow-schema.ts';

import type { Store } from '../store.ts';
import type { WorkflowStep } from './workflow-schema.ts';

export * from './workflow-schema.ts';
/** Revisions listed per workflow in the console. */
const HISTORY_LIMIT = 50;
/** A revision is the SHA-256 of the validated definition. */
const revisionSchema = z.string().regex(/^[\da-f]{64}$/v);
/** Built-in workflow definitions shipped with the source. */
const BUILTIN_DIRECTORY = path.resolve(import.meta.dirname, '..', '..', 'resources', 'workflows');

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
