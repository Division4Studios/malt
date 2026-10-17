/**
 * DOM-free model of a workflow's revision history: decode the broker's
 * history, and compare two revisions step by step so the operator sees what
 * changed between them. Revisions decode into the editor's draft shape, so
 * any revision can also be opened as a new draft.
 *
 * @file
 */
import { data, number, records, text } from './api.js';
import { decodeWorkflow } from './workflow-model.js';

import type { DraftStep, DraftWorkflow, SectionName } from './workflow-model.js';

/** One objective that froze a revision. */
export interface RevisionObjective {
  /** Objective id. */
  readonly featureId: string;
  /** First line of the objective. */
  readonly title: string;
  /** Ledger phase. */
  readonly phase: string;
}

/** One revision. */
export interface Revision {
  /** Digest. */
  readonly revision: string;
  /** Save time, or `null` when known only from frozen work or a built-in. */
  readonly createdAt: number | null;
  /** Whether new objectives freeze it now. */
  readonly isCurrent: boolean;
  /** Definition. */
  readonly workflow: DraftWorkflow;
  /** Objectives that froze it, bounded. */
  readonly objectives: readonly RevisionObjective[];
  /** All objectives that froze it. */
  readonly objectiveCount: number;
  /** Deliveries that froze it. */
  readonly deliveryCount: number;
}

/** A workflow's history. */
export interface History {
  /** Workflow id. */
  readonly workflowId: string;
  /** Built-in, project or known only from frozen work. */
  readonly source: 'builtin' | 'project' | 'frozen';
  /** Revisions, current first. */
  readonly revisions: readonly Revision[];
}

/** One step's difference between two revisions. */
export interface StepChange {
  /** Section. */
  readonly section: SectionName;
  /** Step id. */
  readonly id: string;
  /** Title in the newer revision, or the older one when removed. */
  readonly title: string;
  /** What happened to it. */
  readonly change: 'added' | 'removed' | 'changed';
  /** Changed fields, in plain words. */
  readonly details: readonly string[];
}

/** Differences between two revisions. */
export interface RevisionDiff {
  /** Workflow-level changes (name, description). */
  readonly workflow: readonly string[];
  /** Step changes in section order. */
  readonly steps: readonly StepChange[];
}

/** Step fields compared, with plain labels. */
const STEP_FIELDS: readonly (readonly [keyof DraftStep, string])[] = [
  ['kind', 'kind'],
  ['title', 'title'],
  ['roles', 'seats'],
  ['profile', 'profile'],
  ['after', 'runs after'],
  ['inputs', 'inputs'],
  ['blind', 'blind review'],
  ['gate', 'approval gate'],
  ['optional', 'optional'],
  ['provider', 'preferred provider'],
  ['instructions', 'instructions'],
];

/**
 * Plain text for one step field value.
 *
 * @param value - Field value.
 * @returns Short text.
 */
function shown(value: DraftStep[keyof DraftStep]): string {
  if (value === null) {
    return 'its ancestors';
  }
  if (typeof value === 'boolean') {
    return value ? 'yes' : 'no';
  }
  if (typeof value === 'string') {
    return value === '' ? 'none' : value;
  }
  return value.length === 0 ? 'none' : value.join(', ');
}

/**
 * Decode one revision.
 *
 * @param record - Untrusted revision.
 * @returns Decoded revision with its definition and usage.
 */
function parseRevision(record: Record<string, unknown>): Revision {
  const { createdAt } = record;
  return {
    revision: text(record, 'revision'),
    createdAt: typeof createdAt === 'number' && Number.isFinite(createdAt) ? createdAt : null,
    isCurrent: record['isCurrent'] === true,
    workflow: decodeWorkflow(data(record['workflow'] ?? {})),
    objectives: records(record['objectives']).map((objective) => {
      return {
        featureId: text(objective, 'featureId'),
        title: text(objective, 'title'),
        phase: text(objective, 'phase'),
      };
    }),
    objectiveCount: number(record, 'objectiveCount'),
    deliveryCount: number(record, 'deliveryCount'),
  };
}

/**
 * Decode the broker's history; malformed input yields an empty history.
 *
 * @param value - Untrusted response.
 * @returns Decoded history, current revision first.
 */
export function parseHistory(value: unknown): History {
  try {
    const record = data(value);
    const source = text(record, 'source');
    return {
      workflowId: text(record, 'workflowId'),
      source: source === 'builtin' || source === 'project' ? source : 'frozen',
      revisions: records(record['revisions'])
        .map((revision) => parseRevision(revision))
        .filter((revision) => revision.revision !== ''),
    };
  } catch {
    return { workflowId: '', source: 'frozen', revisions: [] };
  }
}

/**
 * Field-level differences of one step.
 *
 * @param before - Older step.
 * @param after - Newer step.
 * @returns Changed fields in plain words.
 */
function stepDetails(before: DraftStep, after: DraftStep): string[] {
  return STEP_FIELDS.filter(([key]) => JSON.stringify(before[key]) !== JSON.stringify(after[key])).map(
    ([key, label]) =>
      key === 'instructions' ? 'instructions changed' : `${label}: ${shown(before[key])} → ${shown(after[key])}`,
  );
}

/**
 * Differences of one section.
 *
 * @param section - Section name.
 * @param older - Older steps.
 * @param newer - Newer steps.
 * @returns Added, removed and changed steps.
 */
function sectionChanges(section: SectionName, older: readonly DraftStep[], newer: readonly DraftStep[]): StepChange[] {
  const before = new Map(older.map((step) => [step.id, step]));
  const after = new Map(newer.map((step) => [step.id, step]));
  const changes: StepChange[] = [];
  for (const step of newer) {
    const previous = before.get(step.id);
    if (previous === undefined) {
      changes.push({ section, id: step.id, title: step.title, change: 'added', details: [] });
      continue;
    }
    const details = stepDetails(previous, step);
    if (details.length > 0) {
      changes.push({ section, id: step.id, title: step.title, change: 'changed', details });
    }
  }
  for (const step of older) {
    if (!after.has(step.id)) {
      changes.push({ section, id: step.id, title: step.title, change: 'removed', details: [] });
    }
  }
  return changes;
}

/**
 * Compare two revisions.
 *
 * @param older - Revision compared from.
 * @param newer - Revision compared to.
 * @returns What changed from the older to the newer one.
 */
export function diffRevisions(older: DraftWorkflow, newer: DraftWorkflow): RevisionDiff {
  const workflow = [
    ...(older.name === newer.name ? [] : [`name: ${older.name} → ${newer.name}`]),
    ...(older.description === newer.description ? [] : ['description changed']),
  ];
  return {
    workflow,
    steps: [
      ...sectionChanges('planning', older.planning, newer.planning),
      ...sectionChanges('delivery', older.delivery, newer.delivery),
    ],
  };
}

/**
 * Plain usage line for a revision.
 *
 * @param revision - Revision whose usage to describe.
 * @returns One plain sentence.
 */
export function usageText(revision: Revision): string {
  const objectives = `${String(revision.objectiveCount)} ${revision.objectiveCount === 1 ? 'objective' : 'objectives'}`;
  const deliveries = `${String(revision.deliveryCount)} ${revision.deliveryCount === 1 ? 'delivery' : 'deliveries'}`;
  return revision.objectiveCount === 0 && revision.deliveryCount === 0
    ? 'No objective or delivery runs it.'
    : `Frozen by ${objectives} and ${deliveries}.`;
}
