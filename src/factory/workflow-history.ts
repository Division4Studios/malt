/**
 * Revision history of one workflow: every revision the project saved, plus
 * every revision an objective or delivery froze (built-in revisions shipped
 * by older MALT versions included), each with the work that runs it. The
 * frozen copies carry their full definitions, so a revision stays viewable
 * after the library moved on.
 *
 * @file
 */

import { builtinWorkflows, workflowHistoryRequestSchema, workflowLibrary } from './workflows.ts';

import type { FactoryRepository } from './repository.ts';
import type { FactoryTask, Feature } from './schema.ts';
import type { Workflow } from './workflows.ts';

/** Revisions returned for one workflow. */
const MAX_REVISIONS = 50;
/** Objectives listed per revision; the rest are counted. */
const MAX_OBJECTIVES = 20;
/** Objective title length. */
const TITLE_MAX = 120;

/** One objective that froze a revision. */
export interface RevisionObjective {
  /** Objective id. */
  readonly featureId: string;
  /** First line of the objective. */
  readonly title: string;
  /** Ledger phase. */
  readonly phase: string;
}

/** One revision with the work that runs it. */
export interface WorkflowRevision {
  /** SHA-256 digest of the definition. */
  readonly revision: string;
  /** When the project saved it; `null` for revisions known only from frozen copies or built-ins. */
  readonly createdAt: number | null;
  /** Whether new objectives would freeze it now. */
  readonly isCurrent: boolean;
  /** The definition. */
  readonly workflow: Workflow;
  /** Objectives that froze it, newest first and bounded. */
  readonly objectives: readonly RevisionObjective[];
  /** All objectives that froze it. */
  readonly objectiveCount: number;
  /** Deliveries that froze it. */
  readonly deliveryCount: number;
}

/** History of one workflow. */
export interface WorkflowHistory {
  /** Workflow id. */
  readonly workflowId: string;
  /** Built-in, project-saved, or known only from frozen work. */
  readonly source: 'builtin' | 'project' | 'frozen';
  /** Revision new objectives would freeze, if the library still has the workflow. */
  readonly current: string | null;
  /** Revisions, current first, then newest. */
  readonly revisions: readonly WorkflowRevision[];
}

/** A revision being collected. */
interface Collected {
  /** Definition. */
  workflow: Workflow;
  /** Save time, when saved. */
  createdAt: number | null;
  /** Objectives that froze it. */
  readonly objectives: Feature[];
  /** Deliveries that froze it. */
  deliveries: number;
}

/**
 * Record one frozen copy.
 *
 * @param found - Revisions so far.
 * @param frozen - Frozen copy.
 * @param frozen.revision - Its digest.
 * @param frozen.workflow - Its definition.
 * @returns The collected entry.
 */
function collect(found: Map<string, Collected>, frozen: { revision: string; workflow: Workflow }): Collected {
  const existing = found.get(frozen.revision);
  if (existing !== undefined) {
    return existing;
  }
  const entry: Collected = { workflow: frozen.workflow, createdAt: null, objectives: [], deliveries: 0 };
  found.set(frozen.revision, entry);
  return entry;
}

/**
 * The frozen copy a delivery runs: its own, else its objective's.
 *
 * @param task - Delivery whose copy is wanted.
 * @param features - Objectives by id.
 * @returns Frozen copy, if any.
 */
function deliveryCopy(task: FactoryTask, features: ReadonlyMap<string, Feature>): Feature['workflow'] {
  return task.workflow ?? (task.featureId === null ? undefined : features.get(task.featureId)?.workflow);
}

/**
 * Sort key: the current revision first, then the newest save or objective.
 *
 * @param entry - Collected revision.
 * @returns Latest known time.
 */
function latest(entry: Collected): number {
  return Math.max(entry.createdAt ?? 0, ...entry.objectives.map((feature) => feature.createdAt));
}

/**
 * One workflow's revision history.
 *
 * @param repository - Project ledger and library.
 * @param input - Untrusted request naming the workflow.
 * @returns Revisions with the work that runs each.
 */
export function workflowHistory(repository: FactoryRepository, input: unknown): WorkflowHistory {
  const { workflowId } = workflowHistoryRequestSchema.parse(input);
  const library = workflowLibrary(repository.store);
  const found = new Map<string, Collected>();
  for (const saved of library.history(workflowId)) {
    collect(found, saved).createdAt = saved.createdAt;
  }
  const head = library.list().find((item) => item.id === workflowId);
  if (head !== undefined) {
    collect(found, head);
  }
  const features = repository.features();
  const byId = new Map(features.map((feature) => [feature.id, feature]));
  for (const feature of features) {
    if (feature.workflow?.id === workflowId) {
      collect(found, feature.workflow).objectives.push(feature);
    }
  }
  for (const task of repository.tasks()) {
    const copy = deliveryCopy(task, byId);
    if (copy?.id === workflowId) {
      collect(found, copy).deliveries += 1;
    }
  }
  const isBuiltin = builtinWorkflows().some((workflow) => workflow.id === workflowId);
  let source: WorkflowHistory['source'] = 'frozen';
  if (head !== undefined) {
    source = isBuiltin ? 'builtin' : 'project';
  }
  const revisions = [...found]
    .toSorted(([leftId, left], [rightId, right]) => {
      const current = Number(rightId === head?.revision) - Number(leftId === head?.revision);
      return current === 0 ? latest(right) - latest(left) : current;
    })
    .slice(0, MAX_REVISIONS)
    .map(([revision, entry]): WorkflowRevision => {
      const objectives = entry.objectives.toSorted((left, right) => right.createdAt - left.createdAt);
      return {
        revision,
        createdAt: entry.createdAt,
        isCurrent: revision === head?.revision,
        workflow: entry.workflow,
        objectives: objectives.slice(0, MAX_OBJECTIVES).map((feature) => {
          return {
            featureId: feature.id,
            title: (feature.objective.split('\n', 1)[0] ?? '').slice(0, TITLE_MAX),
            phase: feature.phase,
          };
        }),
        objectiveCount: objectives.length,
        deliveryCount: entry.deliveries,
      };
    });
  return { workflowId, source, current: head?.revision ?? null, revisions };
}
