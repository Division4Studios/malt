/**
 * DOM-free model of the objective view: each objective's definition of done
 * from the pushed console projection, checklist editor validation, and the
 * progress log pages read from `/api/objective-log`.
 *
 * @file
 */
import { asData } from './console-model.js';
import { phrase, t, translated } from './i18n.js';
import { parseCustomization } from './step-override-model.js';

import type { Data } from './api.js';
import type { Customization } from './step-override-model.js';

/** Checklist states. */
export const DONE_STATES = ['open', 'proposed', 'checked', 'waived'] as const;
/** States the operator can save; proposals are accepted as open or dismissed. */
export const SAVED_STATES = ['open', 'checked', 'waived'] as const;
/** Most checklist items per objective. */
export const DONE_ITEMS_MAX = 50;
/** Longest checklist item. */
const ITEM_TEXT_MAX = 300;
/** Longest evidence text. */
const EVIDENCE_MAX = 1000;
/** Every checklist state, for membership checks on untrusted values. */
const STATE_SET: ReadonlySet<unknown> = new Set(DONE_STATES);
/** States the operator can save, for membership checks on typed values. */
const SAVED_SET: ReadonlySet<unknown> = new Set(SAVED_STATES);

/** A checklist state. */
export type DoneState = (typeof DONE_STATES)[number];

/** One checklist item. */
export interface DoneItem {
  /** Item id. */
  readonly id: string;
  /** What must be true. */
  readonly text: string;
  /** Where it stands. */
  readonly state: DoneState;
  /** `operator` or the role that set the state. */
  readonly by: string | null;
  /** When the state was set. */
  readonly at: number | null;
  /** Supporting evidence. */
  readonly evidence: string | null;
}

/** One objective with its definition of done. */
export interface Goal {
  /** Objective id. */
  readonly featureId: string;
  /** First line. */
  readonly title: string;
  /** Full objective text. */
  readonly objective: string;
  /** Ledger phase. */
  readonly phase: string;
  /** Version the checklist save must present. */
  readonly updatedAt: number;
  /** Delivery progress. */
  readonly deliveries: { readonly total: number; readonly done: number };
  /** Checklist. */
  readonly items: readonly DoneItem[];
  /** Checked or waived items. */
  readonly met: number;
  /** Proposals awaiting the operator. */
  readonly proposed: number;
  /** Whether every delivery is done but the checklist is not met. */
  readonly awaitsDefinition: boolean;
  /** Step override editor state, while the objective has not started delivering. */
  readonly customization: Customization | null;
}

/** One progress log entry. */
export interface LogEntry {
  /** Cursor value. */
  readonly seq: number;
  /** When it happened. */
  readonly at: number;
  /** What it records. */
  readonly kind: string;
  /** Who did it. */
  readonly actor: string;
  /** Description. */
  readonly body: string;
}

/** One page of the progress log. */
export interface LogPage {
  /** Entries, newest first. */
  readonly entries: readonly LogEntry[];
  /** All entries kept for the objective. */
  readonly total: number;
  /** Cursor of the next older page, or `null`. */
  readonly next: number | null;
}

/** One editor row as typed. */
export interface ChecklistRow {
  /** Existing item id, or empty for a new item. */
  readonly id: string;
  /** Item text. */
  readonly text: string;
  /** Chosen state. */
  readonly state: string;
  /** Evidence text. */
  readonly evidence: string;
}

/** Visible label per log entry kind. */
export const LOG_LABELS: Readonly<Record<string, string>> = translated({
  plan: phrase('Plan'),
  delivery: phrase('Delivery'),
  check_in: 'Check-in',
  criteria: phrase('Definition of done'),
  note: phrase('Note'),
  objective: phrase('Objective'),
});

/** Visible label per checklist state. */
export const STATE_TEXT: Readonly<Record<DoneState, string>> = translated({
  open: phrase('Open'),
  proposed: phrase('Proposed'),
  checked: phrase('Checked'),
  waived: phrase('Waived'),
});

/**
 * Read a string field.
 *
 * @param record - Untrusted record.
 * @param key - Field.
 * @returns String value, or empty.
 */
function stringOf(record: Data, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}

/**
 * Read a finite number field.
 *
 * @param record - Untrusted record.
 * @param key - Field.
 * @returns Number, or zero.
 */
function numberOf(record: Data, key: string): number {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Read a nullable string field.
 *
 * @param record - Untrusted record.
 * @param key - Field.
 * @returns String, or `null`.
 */
function nullableString(record: Data, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

/**
 * Plain records of an untrusted array.
 *
 * @param value - Untrusted array.
 * @returns Records, skipping anything else.
 */
function recordsOf(value: unknown): Data[] {
  return Array.isArray(value) ? value.map((entry) => asData(entry)).filter((entry) => entry !== null) : [];
}

/**
 * Whether a value is a checklist state.
 *
 * @param value - Untrusted value.
 * @returns True for a known state.
 */
function isDoneState(value: unknown): value is DoneState {
  return STATE_SET.has(value);
}

/**
 * Validate one checklist item.
 *
 * @param record - Untrusted item.
 * @returns Item, or `null` when incomplete.
 */
function parseItem(record: Data): DoneItem | null {
  const id = stringOf(record, 'id');
  const { state, at } = record;
  if (id === '' || !isDoneState(state)) {
    return null;
  }
  return {
    id,
    text: stringOf(record, 'text'),
    state,
    by: nullableString(record, 'by'),
    at: typeof at === 'number' ? at : null,
    evidence: nullableString(record, 'evidence'),
  };
}

/**
 * Validate one objective entry.
 *
 * @param record - Untrusted goal record.
 * @returns Goal, or `null` without an id.
 */
function parseGoal(record: Data): Goal | null {
  const featureId = stringOf(record, 'featureId');
  if (featureId === '') {
    return null;
  }
  const deliveries = asData(record['deliveries']) ?? {};
  const definition = asData(record['definition']) ?? {};
  return {
    featureId,
    title: stringOf(record, 'title'),
    objective: stringOf(record, 'objective'),
    phase: stringOf(record, 'phase'),
    updatedAt: numberOf(record, 'updatedAt'),
    deliveries: { total: numberOf(deliveries, 'total'), done: numberOf(deliveries, 'done') },
    items: recordsOf(definition['items'])
      .map((item) => parseItem(item))
      .filter((item) => item !== null),
    met: numberOf(definition, 'met'),
    proposed: numberOf(definition, 'proposed'),
    awaitsDefinition: record['awaitsDefinition'] === true,
    customization: parseCustomization(record['customization']),
  };
}

/**
 * Read every objective with its definition of done from a snapshot.
 *
 * @param snapshot - Console snapshot or raw `/api/snapshot` JSON.
 * @returns Objectives, oldest first; empty when the snapshot has none.
 */
export function readGoals(snapshot: unknown): Goal[] {
  const factory = asData(asData(snapshot)?.['factory']);
  const view = asData(factory?.['console']);
  return recordsOf(view?.['goals'])
    .map((record) => parseGoal(record))
    .filter((goal) => goal !== null);
}

/**
 * Summarize checklist progress.
 *
 * @param goal - Objective.
 * @returns Plain progress text.
 */
export function definitionText(goal: Pick<Goal, 'items' | 'met' | 'proposed'>): string {
  if (goal.items.length === 0) {
    return t('No definition of done yet');
  }
  const accepted = goal.items.length - goal.proposed;
  const proposals = goal.proposed === 0 ? '' : t(' · {proposed} proposed', { proposed: goal.proposed });
  return t('{met} of {accepted} criteria met{proposals}', {
    met: goal.met,
    accepted,
    proposals,
  });
}

/** Document event asking the console to open one objective; its detail is the objective id. */
export const OPEN_OBJECTIVE_EVENT = 'malt-open-objective';

/** An unfinished objective's definition-of-done progress, for the Mission overview. */
export interface GoalProgress {
  /** Objective id. */
  readonly featureId: string;
  /** First line. */
  readonly title: string;
  /** Checklist progress text. */
  readonly progress: string;
  /** Whether every delivery is done but the checklist is not met yet. */
  readonly awaitsDefinition: boolean;
}

/**
 * Unfinished objectives that have a definition of done or wait on one.
 *
 * @param snapshot - Console snapshot.
 * @returns Progress rows; objectives waiting on their definition come first.
 */
export function goalProgress(snapshot: unknown): GoalProgress[] {
  const rows: GoalProgress[] = [];
  for (const goal of readGoals(snapshot)) {
    if (goal.phase !== 'done' && (goal.items.length > 0 || goal.awaitsDefinition)) {
      rows.push({
        featureId: goal.featureId,
        title: goal.title,
        progress: definitionText(goal),
        awaitsDefinition: goal.awaitsDefinition,
      });
    }
  }
  return rows.toSorted((left, right) => Number(right.awaitsDefinition) - Number(left.awaitsDefinition));
}

/**
 * Validate editor rows into a `factory_objective_done` request.
 *
 * @param goal - Objective being edited.
 * @param rows - Rows as typed; dismissed proposals are simply absent.
 * @returns Request input, or the first problem.
 */
export function checklistInput(goal: Goal, rows: readonly ChecklistRow[]): { input: Data } | { error: string } {
  const filled = rows.filter((row) => row.text.trim() !== '' || row.id !== '');
  if (filled.length > DONE_ITEMS_MAX) {
    return {
      error: t('Keep the definition of done to {doneItemsMax} items or fewer.', {
        doneItemsMax: DONE_ITEMS_MAX,
      }),
    };
  }
  const known = new Set(goal.items.map((item) => item.id));
  const items: Data[] = [];
  for (const [index, row] of filled.entries()) {
    const text = row.text.trim();
    const label = t('Item {value}', { value: index + 1 });
    if (text === '' || text.length > ITEM_TEXT_MAX) {
      return {
        error: t('{label} needs text of at most {itemTextMax} characters.', {
          label,
          itemTextMax: ITEM_TEXT_MAX,
        }),
      };
    }
    if (!SAVED_SET.has(row.state)) {
      return { error: t('{label}: choose open, checked or waived.', { label }) };
    }
    const evidence = row.evidence.trim();
    if (evidence.length > EVIDENCE_MAX) {
      return {
        error: t('{label}: evidence is limited to {evidenceMax} characters.', {
          label,
          evidenceMax: EVIDENCE_MAX,
        }),
      };
    }
    if (row.id !== '' && !known.has(row.id)) {
      return { error: t('The checklist changed. Reopen the editor and apply your edits again.') };
    }
    items.push({
      ...(row.id !== '' && { id: row.id }),
      text,
      state: row.state,
      evidence: evidence === '' ? null : evidence,
    });
  }
  return { input: { featureId: goal.featureId, expectedUpdatedAt: goal.updatedAt, items } };
}

/**
 * Validate one progress log page.
 *
 * @param value - Untrusted route result.
 * @returns Page with valid entries.
 */
export function readLogPage(value: unknown): LogPage {
  const page = asData(value) ?? {};
  const { next } = page;
  return {
    entries: recordsOf(page['entries']).map((entry) => {
      return {
        seq: numberOf(entry, 'seq'),
        at: numberOf(entry, 'at'),
        kind: stringOf(entry, 'kind'),
        actor: stringOf(entry, 'actor'),
        body: stringOf(entry, 'body'),
      };
    }),
    total: numberOf(page, 'total'),
    next: typeof next === 'number' && next > 0 ? next : null,
  };
}
