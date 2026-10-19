/**
 * DOM-free reading of the broker's console projection (`snapshot.factory.console`)
 * for the Inbox, Board and delivery views. Every field is untrusted: records are
 * validated one by one, malformed members are skipped, and unknown states fall
 * back to a neutral value rather than being cast.
 *
 * @file
 */
import { number, text } from './api.js';
import { phrase, t, translated } from './i18n.js';
import { parseCustomization } from './step-override-model.js';
import { formatDuration } from './telemetry-format.js';

import type { Data } from './api.js';
import type { Customization } from './step-override-model.js';

/** Plain step states, in the order the broker defines them. */
export const STEP_STATES = ['done', 'running', 'ready', 'needs_you', 'waiting'] as const;
/** Board columns, left to right. */
export const COLUMNS = ['planning', 'ready', 'in_progress', 'needs_you', 'done'] as const;
/** Inbox decision kinds the console can act on. */
export const INBOX_KINDS = [
  'approval',
  'plan_approval',
  'question',
  'blocked_delivery',
  'blocked_objective',
  'skill',
  'spend_cap',
  'done_criteria',
] as const;
/** Inbox lanes: decisions that need a reply, and notices to look into. */
export const INBOX_LANES = ['reply', 'notice'] as const;

/** Where a step stands. */
export type StepState = (typeof STEP_STATES)[number];
/** Board column. */
export type Column = (typeof COLUMNS)[number];
/** Inbox decision kind. */
export type InboxKind = (typeof INBOX_KINDS)[number];
/** Where an Inbox item is listed: needs a reply, or a notice to look into. */
export type InboxLane = (typeof INBOX_LANES)[number];

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
  /** Live attempt and its checkpoint liveness. */
  readonly running: {
    readonly jobId: string;
    readonly role: string;
    readonly step: string | null;
    readonly liveness: Liveness | null;
  } | null;
  /** Retry backoff of the latest failed step, while it delays that step. */
  readonly retry: Retry | null;
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
  /** Operator hold: no new attempt starts while set. */
  readonly held: { readonly at: number; readonly reason: string } | null;
  /** Recent CI-failure and merge-conflict repair rounds, oldest first. */
  readonly repairs: readonly RepairRound[];
  /** Whether the operator kept it on the board after it finished. */
  readonly isKept: boolean;
  /** Step override editor state, while its steps can still change. */
  readonly customization: Customization | null;
  /** The lead's brief revalidation verdict, when recorded. */
  readonly revalidation: { readonly outcome: string; readonly summary: string; readonly at: number } | null;
  /** Last change time. */
  readonly updatedAt: number;
}

/** What a running attempt is doing, from its latest progress sample. */
export interface Liveness {
  /** `progressing`, `idle`, `awaiting_input`, `stalled` or `ceiling`. */
  readonly state: string;
  /** Newest meaningful signal. */
  readonly lastSignal: string | null;
  /** When it last progressed. */
  readonly lastProgressAt: number;
  /** What it waits on, if anything. */
  readonly awaiting: string | null;
  /** Next checkpoint. */
  readonly nextCheckpointAt: number;
  /** Extensions granted so far. */
  readonly extensions: number;
}

/** A failed step waiting to retry, or out of retries. */
export interface Retry {
  /** Failure class of the latest attempts. */
  readonly failureClass: string;
  /** Consecutive failures of that class. */
  readonly failures: number;
  /** When it may run again; null once retries are exhausted. */
  readonly retryAt: number | null;
}

/** One CI-failure or merge-conflict repair round. */
export interface RepairRound {
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

/** A finished delivery archived off the board, which the operator can restore. */
export interface ArchivedDelivery {
  /** Delivery id. */
  readonly taskId: string;
  /** Tracker issue number. */
  readonly issue: number;
  /** Title. */
  readonly title: string;
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
  /** Definition-of-done progress. */
  readonly definition: { readonly met: number; readonly total: number };
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
  /** Lane the item is listed in. */
  readonly lane: InboxLane;
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
  /** Archived deliveries: the total and the latest few. */
  readonly archived: { readonly total: number; readonly recent: readonly ArchivedDelivery[] };
}

/** Projection used when the snapshot carries none. */
export const EMPTY_CONSOLE: ConsoleModel = {
  deliveries: [],
  objectives: [],
  open: [],
  answered: [],
  archived: { total: 0, recent: [] },
};

/** Milliseconds per minute. */
const MINUTE_MS = 60_000;
/** Milliseconds per day. */
const DAY_MS = 86_400_000;
/** Characters of a commit shown as a short sha. */
const SHORT_SHA = 7;
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
    : {
        jobId: text(record, 'jobId'),
        role: text(record, 'role'),
        step: nullableText(record, 'step'),
        liveness: parseLiveness(record['liveness']),
      };
}

/**
 * Validate a running attempt's liveness.
 *
 * @param value - Untrusted liveness record.
 * @returns Liveness, or `null`.
 */
function parseLiveness(value: unknown): Liveness | null {
  const record = asData(value);
  return record === null
    ? null
    : {
        state: text(record, 'state'),
        lastSignal: nullableText(record, 'lastSignal'),
        lastProgressAt: number(record, 'lastProgressAt'),
        awaiting: nullableText(record, 'awaiting'),
        nextCheckpointAt: number(record, 'nextCheckpointAt'),
        extensions: number(record, 'extensions'),
      };
}

/**
 * Validate a delivery's retry backoff.
 *
 * @param value - Untrusted retry record.
 * @returns Retry, or `null`.
 */
function parseRetry(value: unknown): Retry | null {
  const record = asData(value);
  if (record === null) {
    return null;
  }
  const { retryAt } = record;
  return {
    failureClass: text(record, 'failureClass'),
    failures: number(record, 'failures'),
    retryAt: typeof retryAt === 'number' && Number.isFinite(retryAt) ? retryAt : null,
  };
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
    retry: parseRetry(record['retry']),
    head: nullableText(record, 'head'),
    base: nullableText(record, 'base'),
    prUrl: nullableText(record, 'prUrl'),
    developer: nullableText(record, 'developer'),
    waitingOn: Array.isArray(waiting)
      ? waiting.filter((issue): issue is number => typeof issue === 'number' && Number.isFinite(issue))
      : [],
    attempts: number(record, 'attempts'),
    error: nullableText(record, 'error'),
    held: parseHold(record['held']),
    repairs: objects(record['repairs']).map((round) => {
      return {
        kind: round['kind'] === 'conflict' ? 'conflict' : 'ci',
        at: number(round, 'at'),
        head: text(round, 'head'),
        summary: text(round, 'summary'),
        findings: strings(round['findings']),
      };
    }),
    isKept: record['isKept'] === true,
    customization: parseCustomization(record['customization']),
    revalidation: parseRevalidation(record['revalidation']),
    updatedAt: number(record, 'updatedAt'),
  };
}

/**
 * Validate a brief revalidation verdict.
 *
 * @param value - Untrusted verdict.
 * @returns Outcome, summary and time, or `null` when none was recorded.
 */
function parseRevalidation(value: unknown): Delivery['revalidation'] {
  const verdict = asData(value);
  return verdict === null
    ? null
    : { outcome: text(verdict, 'outcome'), summary: text(verdict, 'summary'), at: number(verdict, 'at') };
}

/**
 * Validate an operator hold.
 *
 * @param value - Untrusted hold record.
 * @returns Hold time and reason, or `null` when the delivery is not held.
 */
function parseHold(value: unknown): Delivery['held'] {
  const hold = asData(value);
  return hold === null ? null : { at: number(hold, 'at'), reason: text(hold, 'reason') };
}

/**
 * Validate the archived summary.
 *
 * @param value - Untrusted archived record.
 * @returns Total and the restorable recent deliveries.
 */
function parseArchived(value: unknown): ConsoleModel['archived'] {
  const archived = asData(value) ?? {};
  const recent = objects(archived['recent'])
    .map((record) => ({ taskId: text(record, 'taskId'), issue: number(record, 'issue'), title: text(record, 'title') }))
    .filter((entry) => entry.taskId !== '');
  return { total: number(archived, 'total'), recent };
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
  const definition = asData(record['definition']) ?? {};
  return {
    featureId,
    title: text(record, 'title'),
    phase: text(record, 'phase'),
    column: parseColumn(record['column'], 'planning'),
    workflow: parseWorkflow(record['workflow']),
    steps: parseSteps(record['steps']),
    deliveries: { total: number(deliveries, 'total'), done: number(deliveries, 'done') },
    definition: { met: number(definition, 'met'), total: number(definition, 'total') },
    error: nullableText(record, 'error'),
    createdAt: number(record, 'createdAt'),
  };
}

/**
 * The lane an item belongs in when an older broker sends none.
 *
 * @param kind - Decision kind.
 * @returns Notices for blockers, replies for everything else.
 */
function defaultLane(kind: InboxKind): InboxLane {
  return kind === 'blocked_delivery' || kind === 'blocked_objective' ? 'notice' : 'reply';
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
  const { lane, choices } = record;
  return {
    id,
    kind,
    lane: isOneOf(INBOX_LANES, lane) ? lane : defaultLane(kind),
    title: text(record, 'title'),
    detail: text(record, 'detail'),
    since: number(record, 'since'),
    taskId: nullableText(record, 'taskId'),
    featureId: nullableText(record, 'featureId'),
    stepId: nullableText(record, 'stepId'),
    head: nullableText(record, 'head'),
    requestId: nullableText(record, 'requestId'),
    questionId: nullableText(record, 'questionId'),
    choices: Array.isArray(choices)
      ? choices.filter((choice): choice is string => typeof choice === 'string' && choice !== '')
      : [],
    allowText: record['allowText'] === true,
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
    archived: parseArchived(view['archived']),
    // Like every other Inbox entry, an answered decision without a stable id is skipped.
    answered: objects(inbox['answered'])
      .filter((record) => text(record, 'id') !== '')
      .map((record) => {
        return {
          id: text(record, 'id'),
          title: text(record, 'title'),
          note: text(record, 'note'),
          at: number(record, 'at'),
        };
      }),
  };
}

/**
 * Count decisions waiting on the human, for a navigation badge.
 *
 * @param snapshot - Console snapshot.
 * @returns Open Inbox items.
 */
export function inboxCount(snapshot: unknown): number {
  return readConsole(snapshot).open.length;
}

/** Visible label and glyph for each step state; the glyph keeps state readable without color. */
export const STATE_LABELS: Readonly<Record<StepState, { readonly label: string; readonly glyph: string }>> = translated(
  {
    done: { label: phrase('Done'), glyph: '✓' },
    running: { label: phrase('Running'), glyph: '▶' },
    ready: { label: phrase('Ready'), glyph: '○' },
    needs_you: { label: phrase('Needs you'), glyph: '!' },
    waiting: { label: phrase('Waiting'), glyph: '·' },
  },
);

/**
 * Describe how long ago something happened.
 *
 * @param since - Epoch milliseconds of the event.
 * @param now - Current epoch milliseconds.
 * @returns Text such as `just now`, `4m 10s ago`, `2h 05m ago` or `3d ago`.
 */
export function relativeAge(since: number, now: number): string {
  if (since <= 0) {
    return t('unknown time');
  }
  const elapsed = Math.max(0, now - since);
  if (elapsed < MINUTE_MS) {
    return t('just now');
  }
  return elapsed < DAY_MS ? `${formatDuration(elapsed)} ago` : t('{days}d ago', { days: Math.floor(elapsed / DAY_MS) });
}

/**
 * Shorten a commit id for display.
 *
 * @param sha - Full commit id.
 * @returns Seven leading characters, or `—` when absent.
 */
export function shortSha(sha: string | null): string {
  return sha === null ? '—' : sha.slice(0, SHORT_SHA);
}

/**
 * Bound an error to its leading lines.
 *
 * @param message - Full error text.
 * @param lines - Lines to keep.
 * @returns Leading lines, with an ellipsis when more were dropped.
 */
export function excerpt(message: string, lines = ERROR_LINES): string {
  const all = message.split('\n');
  return all.length > lines ? `${all.slice(0, lines).join('\n')}…` : message;
}

/**
 * Split a severity tag such as `[P1]` from the start of a finding.
 *
 * @param finding - Finding text.
 * @returns Severity (`P0`, `P1` or `P2`) when tagged, and the remaining text.
 */
export function findingSeverity(finding: string): { severity: string | null; text: string } {
  const match = /^\s*\[(?<severity>P[0-2])\]\s*/v.exec(finding);
  const severity = match?.groups?.['severity'];
  return severity === undefined || match === null
    ? { severity: null, text: finding }
    : { severity, text: finding.slice(match[0].length) };
}

/**
 * Group steps by execution layer.
 *
 * @param steps - Steps in workflow order.
 * @returns Layers in ascending order, each with its steps in workflow order.
 */
export function layerGroups(steps: readonly Step[]): { layer: number; steps: Step[] }[] {
  const groups = Map.groupBy(steps, (step) => step.layer);
  return Array.from(groups, ([layer, members]) => ({ layer, steps: members })).toSorted(
    (left, right) => left.layer - right.layer,
  );
}

/** One segment of a compact step strip. */
export interface Segment {
  /** Step id. */
  readonly id: string;
  /** Step state. */
  readonly state: StepState;
  /** Accessible description such as `Review: Running`. */
  readonly label: string;
}

/**
 * Turn steps into strip segments and a one-line progress caption.
 *
 * @param steps - Steps in workflow order.
 * @returns Segments and a caption such as `3 of 7 steps done`.
 */
export function stepStrip(steps: readonly Step[]): { segments: Segment[]; caption: string } {
  const segments = steps.map((step) => {
    const label = `${step.title}: ${STATE_LABELS[step.state].label}`;
    return { id: step.id, state: step.state, label };
  });
  const done = steps.filter((step) => step.state === 'done').length;
  return {
    segments,
    caption: t('{done} of {length} steps done', { done, length: steps.length }),
  };
}

/**
 * Describe the step a delivery is running now.
 *
 * @param delivery - Delivery to describe.
 * @returns Text such as `qa-1 · QA review`, or `null` when nothing runs.
 */
export function runningText(delivery: Delivery): string | null {
  if (delivery.running === null) {
    return null;
  }
  const { role, step } = delivery.running;
  const title = delivery.steps.find((candidate) => candidate.id === step)?.title ?? step;
  return title === null ? role : `${role} · ${title}`;
}

/** Plain words for each failure class. */
const FAILURE_LABELS: Readonly<Record<string, string>> = translated({
  rate_limit: phrase('hit a provider limit'),
  transient: 'failed',
  stalled: 'stalled',
  invalid_output: phrase('returned no usable result'),
  gate: phrase('waited on a gate'),
  cancelled: phrase('was interrupted'),
});

/**
 * Describe a running attempt's liveness.
 *
 * @param liveness - Latest liveness record.
 * @param now - Current epoch milliseconds.
 * @returns Text such as `Progressing · tool Bash 2m 10s ago · next checkpoint in 8m 00s`.
 */
export function livenessText(liveness: Liveness, now: number): string {
  const checkpoint = t('next checkpoint in {wait}', {
    wait: formatDuration(Math.max(0, liveness.nextCheckpointAt - now)),
  });
  const extended = liveness.extensions === 0 ? '' : t(' · extended {extensions}×', { extensions: liveness.extensions });
  if (liveness.state === 'awaiting_input') {
    return t('Awaiting input · {awaiting} · {checkpoint}{extended}', {
      awaiting: liveness.awaiting ?? t('a permission or an answer'),
      checkpoint,
      extended,
    });
  }
  const signal =
    liveness.lastSignal === null
      ? t('no progress yet, started {age}', { age: relativeAge(liveness.lastProgressAt, now) })
      : `${liveness.lastSignal} ${relativeAge(liveness.lastProgressAt, now)}`;
  const state = t(liveness.state === 'progressing' ? 'Progressing' : 'Idle');
  return `${state} · ${signal} · ${checkpoint}${extended}`;
}

/**
 * Describe a failed step's retry backoff.
 *
 * @param retry - Retry state.
 * @param now - Current epoch milliseconds.
 * @returns Text such as `Stalled 2 times · retrying in 9m 00s`, or that retries are exhausted.
 */
export function retryText(retry: Retry, now: number): string {
  const label = FAILURE_LABELS[retry.failureClass] ?? 'failed';
  const times = retry.failures === 1 ? 'once' : `${String(retry.failures)} times`;
  const what = `${label.charAt(0).toUpperCase()}${label.slice(1)} ${times}`;
  return retry.retryAt === null
    ? t('{what} · out of automatic retries; recover it or change its scope', { what })
    : t('{what} · retrying in {wait}', { what, wait: formatDuration(Math.max(0, retry.retryAt - now)) });
}
