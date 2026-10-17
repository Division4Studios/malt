/**
 * DOM-free Board logic: column copy, card grouping and filtering, saved view
 * preferences and tab-key navigation. The Board view only renders what these
 * functions return, so the rules are testable without a browser.
 *
 * @file
 */
import { COLUMNS } from './console-model.js';

import type { Column, ConsoleModel, Delivery, Objective, WorkflowIdentity } from './console-model.js';

/** Plain-language heading and description per column. */
export const COLUMN_COPY: Readonly<Record<Column, { readonly title: string; readonly description: string }>> = {
  planning: { title: 'Planning', description: 'Objectives being split into deliveries.' },
  ready: { title: 'Ready', description: 'Deliveries waiting for a free developer.' },
  in_progress: { title: 'In progress', description: 'Being built, reviewed, merged or verified.' },
  needs_you: { title: 'Needs you', description: 'Waiting on your approval or a blocker decision.' },
  done: { title: 'Done', description: 'Merged and verified on main.' },
};

/** A card on the board. */
export type Card =
  | { readonly type: 'delivery'; readonly key: string; readonly delivery: Delivery }
  | { readonly type: 'objective'; readonly key: string; readonly objective: Objective };

/** Operator-chosen board filters. */
export interface BoardFilter {
  /** Free text matched against titles and issue numbers. */
  readonly query: string;
  /** Workflow id, or empty for every workflow. */
  readonly workflow: string;
  /** Whether finished deliveries are listed. */
  readonly showDone: boolean;
}

/** Saved board preferences. */
export interface BoardPrefs extends BoardFilter {
  /** Column shown on narrow screens. */
  readonly tab: Column;
}

/** Preferences used before anything is saved. */
export const DEFAULT_PREFS: BoardPrefs = { query: '', workflow: '', showDone: false, tab: 'needs_you' };
/** Longest saved filter text. */
const QUERY_MAX = 200;

/** Cards grouped by column. */
export interface BoardGroups {
  /** Visible cards per column. */
  readonly columns: Readonly<Record<Column, readonly Card[]>>;
  /** Finished deliveries hidden by the Show done toggle. */
  readonly hiddenDone: number;
}

/**
 * Decide whether a card matches the text filter.
 *
 * @param card - Card to test.
 * @param query - Operator text; case-insensitive, `#12` or `12` match issue 12.
 * @returns Whether the card should be shown.
 */
export function isQueryMatch(card: Card, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') {
    return true;
  }
  if (card.type === 'objective') {
    return card.objective.title.toLowerCase().includes(needle);
  }
  const { issue, title } = card.delivery;
  const issueText = needle.startsWith('#') ? needle.slice(1) : needle;
  return title.toLowerCase().includes(needle) || (issueText !== '' && String(issue).startsWith(issueText));
}

/**
 * The workflow of a card.
 *
 * @param card - Delivery or objective card.
 * @returns Workflow identity.
 */
function cardWorkflow(card: Card): WorkflowIdentity {
  return card.type === 'delivery' ? card.delivery.workflow : card.objective.workflow;
}

/**
 * Group delivery and objective cards into the five columns.
 *
 * @param model - Validated console projection.
 * @param filter - Operator filters.
 * @returns Visible cards per column and how many finished cards are hidden.
 */
export function groupBoard(model: ConsoleModel, filter: BoardFilter): BoardGroups {
  const cards: { column: Column; card: Card }[] = [
    ...model.objectives.map((objective) => {
      return {
        column: objective.column,
        card: { type: 'objective', key: `objective:${objective.featureId}`, objective } as const,
      };
    }),
    ...model.deliveries.map((delivery) => {
      return {
        column: delivery.column,
        card: { type: 'delivery', key: `delivery:${delivery.taskId}`, delivery } as const,
      };
    }),
  ];
  const matching = cards.filter(
    ({ card }) =>
      (filter.workflow === '' || cardWorkflow(card).id === filter.workflow) && isQueryMatch(card, filter.query),
  );
  const columns = Object.fromEntries(COLUMNS.map((column) => [column, [] as Card[]]));
  let hiddenDone = 0;
  for (const { column, card } of matching) {
    if (column === 'done' && !filter.showDone) {
      hiddenDone += 1;
      continue;
    }
    columns[column]?.push(card);
  }
  return {
    columns: {
      planning: columns['planning'] ?? [],
      ready: columns['ready'] ?? [],
      in_progress: columns['in_progress'] ?? [],
      needs_you: columns['needs_you'] ?? [],
      done: columns['done'] ?? [],
    },
    hiddenDone,
  };
}

/**
 * List the workflows present on the board for the workflow filter.
 *
 * @param model - Validated console projection.
 * @returns Unique workflows sorted by name.
 */
export function workflowChoices(model: ConsoleModel): WorkflowIdentity[] {
  const all = [
    ...model.deliveries.map((delivery) => delivery.workflow),
    ...model.objectives.map((objective) => objective.workflow),
  ];
  const unique = new Map(all.filter((workflow) => workflow.id !== '').map((workflow) => [workflow.id, workflow]));
  return unique
    .values()
    .toArray()
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

/**
 * Decode stored JSON without throwing.
 *
 * @param raw - Stored text.
 * @returns Decoded value, or `null` when the text is not JSON.
 */
function decode(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Restore saved preferences, ignoring anything malformed.
 *
 * @param raw - Stored JSON text, or `null` when nothing is saved.
 * @returns Valid preferences.
 */
export function parsePrefs(raw: string | null): BoardPrefs {
  const value = raw === null ? null : decode(raw);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return DEFAULT_PREFS;
  }
  const { query, workflow, showDone, tab } = Object.fromEntries(Object.entries(value));
  return {
    query: typeof query === 'string' ? query.slice(0, QUERY_MAX) : DEFAULT_PREFS.query,
    workflow: typeof workflow === 'string' ? workflow : DEFAULT_PREFS.workflow,
    showDone: typeof showDone === 'boolean' ? showDone : DEFAULT_PREFS.showDone,
    tab: COLUMNS.find((column) => column === tab) ?? DEFAULT_PREFS.tab,
  };
}

/**
 * Move between tabs with the keyboard, following the ARIA tabs pattern.
 *
 * @param current - Index of the focused tab.
 * @param key - `KeyboardEvent.key`.
 * @param count - Number of tabs.
 * @returns Index of the tab to select, or `null` when the key does not navigate.
 */
export function tabTarget(current: number, key: string, count: number): number | null {
  const moves: Readonly<Record<string, number>> = {
    ArrowRight: (current + 1) % count,
    ArrowDown: (current + 1) % count,
    ArrowLeft: (current - 1 + count) % count,
    ArrowUp: (current - 1 + count) % count,
    Home: 0,
    End: count - 1,
  };
  return Object.hasOwn(moves, key) ? (moves[key] ?? null) : null;
}
