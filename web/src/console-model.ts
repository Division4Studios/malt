/**
 * DOM-free reading of the broker's console projection (`snapshot.factory.console`)
 * for the Inbox, Board and delivery views. Every field is untrusted: records are
 * validated one by one, malformed members are skipped, and unknown states fall
 * back to a neutral value rather than being cast.
 *
 * @file
 */

import { number, text } from './api.js';

import type { Data } from './api.js';

/** Plain step states, in the order the broker defines them. */
export const STEP_STATES = ['done', 'running', 'ready', 'needs_you', 'waiting'] as const;
/** Board columns, left to right. */
export const COLUMNS = ['planning', 'ready', 'in_progress', 'needs_you', 'done'] as const;
/** Inbox decision kinds the console can act on. */
export const INBOX_KINDS = ['approval', 'plan_approval', 'blocked_delivery', 'blocked_objective', 'skill'] as const;

/** Where a step stands. */
export type StepState = (typeof STEP_STATES)[number];
/** Board column. */
export type Column = (typeof COLUMNS)[number];
/** Inbox decision kind. */
export type InboxKind = (typeof INBOX_KINDS)[number];

/** A fixer's or plan reviser's ruling on one finding. */
export interface Disposition {
  /** Finding identifier. */
  readonly id: string;
  /** Adopted, rejected or merged. */
  readonly decision: string;
  /** Why the ruling was made. */
  readonly reason: string;
  /** Supporting evidence. */
  readonly evidence: string;
}

/** Latest result recorded for a step. */
export interface StepResult {
  /** Verdict. */
  readonly outcome: string;
  /** What the role reported. */
  readonly summary: string;
  /** Severity-tagged findings. */
  readonly findings: readonly string[];
  /** Rulings on earlier findings. */
  readonly dispositions: readonly Disposition[];
  /** Seat that produced the result, or `operator`. */
  readonly role: string;
}

/** One pipeline step. */
export interface Step {
  /** Step id within its workflow. */
  readonly id: string;
  /** Human title. */
  readonly title: string;
  /** Step kind, such as `review` or `approve`. */
  readonly kind: string;
  /** One-based execution layer; equal layers run in parallel. */
  readonly layer: number;
  /** Seats that may perform it. */
  readonly roles: readonly string[];
  /** Plain state. */
  readonly state: StepState;
  /** Whether a human approves after it succeeds. */
  readonly gate: boolean;
  /** Whether it is a blind review. */
  readonly blind: boolean;
  /** Preferred provider family. */
  readonly provider: string | null;
  /** Latest result. */
  readonly result: StepResult | null;
}

/** Which workflow a card runs. */
export interface WorkflowIdentity {
  /** Stable workflow id. */
  readonly id: string;
  /** Display name. */
  readonly name: string;
}

/** A delivery and its pipeline. */
export interface Delivery {
  /** Delivery id. */
  readonly taskId: string;
  /** Tracker issue number. */
  readonly issue: number;
  /** Title. */
  readonly title: string;
  /** Owning objective. */
  readonly featureId: string | null;
  /** Ledger phase. */
  readonly phase: string;
  /** Board column. */
  readonly column: Column;
  /** Workflow it runs. */
  readonly workflow: WorkflowIdentity;
  /** Steps in workflow order. */
  readonly steps: readonly Step[];
  /** Live attempt. */
  readonly running: { readonly jobId: string; readonly role: string; readonly step: string | null } | null;
  /** Current head commit. */
  readonly head: string | null;
  /** Current base commit. */
  readonly base: string | null;
  /** Pull request link. */
  readonly prUrl: string | null;
  /** Implementation owner. */
  readonly developer: string | null;
  /** Unfinished dependency issue numbers. */
  readonly waitingOn: readonly number[];
  /** Attempts so far. */
  readonly attempts: number;
  /** Blocker or last error. */
  readonly error: string | null;
  /** Last change time. */
  readonly updatedAt: number;
}

/** An objective being planned. */
export interface Objective {
  /** Objective id. */
  readonly featureId: string;
  /** First line of the objective. */
  readonly title: string;
  /** Ledger phase. */
  readonly phase: string;
  /** Board column. */
  readonly column: Column;
  /** Workflow it runs. */
  readonly workflow: WorkflowIdentity;
  /** Planning steps. */
  readonly steps: readonly Step[];
  /** Provisioned delivery progress. */
  readonly deliveries: { readonly total: number; readonly done: number };
  /** Blocker or last error. */
  readonly error: string | null;
  /** Creation time. */
  readonly createdAt: number;
}

/** A decision waiting on the human. */
export interface InboxItem {
  /** Stable item id. */
  readonly id: string;
  /** Decision kind. */
  readonly kind: InboxKind;
  /** Headline. */
  readonly title: string;
  /** Context for the operator. */
  readonly detail: string;
  /** When it started waiting. */
  readonly since: number;
  /** Delivery concerned. */
  readonly taskId: string | null;
  /** Objective concerned. */
  readonly featureId: string | null;
  /** Step to decide. */
  readonly stepId: string | null;
  /** Head an approval binds. */
  readonly head: string | null;
  /** Skill request. */
  readonly requestId: string | null;
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

/** Validated console projection. */
export interface ConsoleModel {
  /** Delivery cards. */
  readonly deliveries: readonly Delivery[];
  /** Objective cards. */
  readonly objectives: readonly Objective[];
  /** Open decisions, oldest first. */
  readonly open: readonly InboxItem[];
  /** Answered decisions, newest first. */
  readonly answered: readonly AnsweredItem[];
}

/** Projection used when the snapshot carries none. */
export const EMPTY_CONSOLE: ConsoleModel = { deliveries: [], objectives: [], open: [], answered: [] };
/** Lines of an error shown on a card. */
export const ERROR_LINES = 3;

/**
 * Narrow an untrusted value to a plain object without throwing.
 *
 * @param value - Untrusted decoded JSON.
 * @returns Plain object, or `null` for anything else.
 */
export function asData(value: unknown): Data | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}

/**
 * Keep the plain-object members of an untrusted array.
 *
 * @param value - Untrusted collection.
 * @returns Plain objects; other members are skipped.
 */
function objects(value: unknown): Data[] {
  return Array.isArray(value) ? value.map((item) => asData(item)).filter((item) => item !== null) : [];
}

/**
 * Read a string field that may be absent.
 *
 * @param value - Validated record.
 * @param key - Field name.
 * @returns Non-empty string, or `null`.
 */
function nullableText(value: Data, key: string): string | null {
  const field = value[key];
  return typeof field === 'string' && field !== '' ? field : null;
}

/**
 * Read an array of strings.
 *
 * @param value - Untrusted collection.
 * @returns Its string members.
 */
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/**
 * Check membership in a fixed list of literals.
 *
 * @param list - Allowed values.
 * @param value - Candidate.
 * @returns Whether the candidate is one of them.
 */
function isOneOf<Value extends string>(list: readonly Value[], value: unknown): value is Value {
  const members: readonly unknown[] = list;
  return members.includes(value);
}

/**
 * Validate a step result.
 *
 * @param value - Untrusted result.
 * @returns Result, or `null` when absent or malformed.
 */
function parseResult(value: unknown): StepResult | null {
  const record = asData(value);
  if (record === null) {
    return null;
  }
  const dispositions = objects(record['dispositions']).map((entry) => {
    return {
      id: text(entry, 'id'),
      decision: text(entry, 'decision'),
      reason: text(entry, 'reason'),
      evidence: text(entry, 'evidence'),
    };
  });
  return {
    outcome: text(record, 'outcome'),
    summary: text(record, 'summary'),
    findings: strings(record['findings']),
    dispositions,
    role: text(record, 'role'),
  };
}

/**
 * Validate one step.
 *
 * @param record - Untrusted step record.
 * @returns Step, or `null` without an id.
 */
function parseStep(record: Data): Step | null {
  const id = text(record, 'id');
  if (id === '') {
    return null;
  }
  const { state } = record;
  return {
    id,
    title: text(record, 'title') === '' ? id : text(record, 'title'),
    kind: text(record, 'kind'),
    layer: Math.max(1, Math.floor(number(record, 'layer'))),
    roles: strings(record['roles']),
    state: isOneOf(STEP_STATES, state) ? state : 'waiting',
    gate: record['gate'] === true,
    blind: record['blind'] === true,
    provider: nullableText(record, 'provider'),
    result: parseResult(record['result']),
  };
}

/**
 * Validate a list of steps.
 *
 * @param value - Untrusted collection.
 * @returns Valid steps in order.
 */
function parseSteps(value: unknown): Step[] {
  return objects(value)
    .map((record) => parseStep(record))
    .filter((step) => step !== null);
}

/**
 * Validate a workflow reference.
 *
 * @param value - Untrusted workflow identity.
 * @returns Identity with a readable name.
 */
function parseWorkflow(value: unknown): WorkflowIdentity {
  const record = asData(value) ?? {};
  const id = text(record, 'id');
  return { id, name: text(record, 'name') === '' ? id : text(record, 'name') };
}

/**
 * Validate a board column.
 *
 * @param value - Untrusted column.
 * @param fallback - Column used when the value is unknown.
 * @returns Known column.
 */
function parseColumn(value: unknown, fallback: Column): Column {
  return isOneOf(COLUMNS, value) ? value : fallback;
}

/**
 * Validate a live attempt.
 *
 * @param value - Untrusted running attempt.
 * @returns Attempt, or `null`.
 */
function parseRunning(value: unknown): Delivery['running'] {
  const record = asData(value);
  return record === null
    ? null
    : { jobId: text(record, 'jobId'), role: text(record, 'role'), step: nullableText(record, 'step') };
}

/**
 * Validate one delivery.
 *
 * @param record - Untrusted delivery record.
 * @returns Delivery, or `null` without an id.
 */
function parseDelivery(record: Data): Delivery | null {
  const taskId = text(record, 'taskId');
  if (taskId === '') {
    return null;
  }
  const waiting: unknown = record['waitingOn'];
  return {
    taskId,
    issue: number(record, 'issue'),
    title: text(record, 'title'),
    featureId: nullableText(record, 'featureId'),
    phase: text(record, 'phase'),
    column: parseColumn(record['column'], 'in_progress'),
    workflow: parseWorkflow(record['workflow']),
    steps: parseSteps(record['steps']),
    running: parseRunning(record['running']),
    head: nullableText(record, 'head'),
    base: nullableText(record, 'base'),
    prUrl: nullableText(record, 'prUrl'),
    developer: nullableText(record, 'developer'),
    waitingOn: Array.isArray(waiting)
      ? waiting.filter((issue): issue is number => typeof issue === 'number' && Number.isFinite(issue))
      : [],
    attempts: number(record, 'attempts'),
    error: nullableText(record, 'error'),
    updatedAt: number(record, 'updatedAt'),
  };
}

/**
 * Validate one objective.
 *
 * @param record - Untrusted objective record.
 * @returns Objective, or `null` without an id.
 */
function parseObjective(record: Data): Objective | null {
  const featureId = text(record, 'featureId');
  if (featureId === '') {
    return null;
  }
  const deliveries = asData(record['deliveries']) ?? {};
  return {
    featureId,
    title: text(record, 'title'),
    phase: text(record, 'phase'),
    column: parseColumn(record['column'], 'planning'),
    workflow: parseWorkflow(record['workflow']),
    steps: parseSteps(record['steps']),
    deliveries: { total: number(deliveries, 'total'), done: number(deliveries, 'done') },
    error: nullableText(record, 'error'),
    createdAt: number(record, 'createdAt'),
  };
}

/**
 * Validate one open Inbox item.
 *
 * @param record - Untrusted item.
 * @returns Item, or `null` for an unknown kind or missing id.
 */
function parseInboxItem(record: Data): InboxItem | null {
  const id = text(record, 'id');
  const { kind } = record;
  if (id === '' || !isOneOf(INBOX_KINDS, kind)) {
    return null;
  }
  return {
    id,
    kind,
    title: text(record, 'title'),
    detail: text(record, 'detail'),
    since: number(record, 'since'),
    taskId: nullableText(record, 'taskId'),
    featureId: nullableText(record, 'featureId'),
    stepId: nullableText(record, 'stepId'),
    head: nullableText(record, 'head'),
    requestId: nullableText(record, 'requestId'),
  };
}

/**
 * Read the console projection from a snapshot.
 *
 * @param snapshot - Validated console snapshot or raw `/api/snapshot` JSON.
 * @returns Validated projection; empty when the snapshot has none.
 */
export function readConsole(snapshot: unknown): ConsoleModel {
  const factory = asData(asData(snapshot)?.['factory']);
  const view = asData(factory?.['console']);
  if (view === null) {
    return EMPTY_CONSOLE;
  }
  const inbox = asData(view['inbox']) ?? {};
  return {
    deliveries: objects(view['deliveries'])
      .map((record) => parseDelivery(record))
      .filter((entry) => entry !== null),
    objectives: objects(view['objectives'])
      .map((record) => parseObjective(record))
      .filter((entry) => entry !== null),
    open: objects(inbox['open'])
      .map((record) => parseInboxItem(record))
      .filter((entry) => entry !== null),
    answered: objects(inbox['answered']).map((record) => {
      return {
        id: text(record, 'id'),
        title: text(record, 'title'),
        note: text(record, 'note'),
        at: number(record, 'at'),
      };
    }),
  };
}
