/**
 * DOM-free reading of the broker's console projection (`snapshot.factory.console`)
 * for the Inbox, Board and delivery views. Every field is untrusted: records are
 * validated one by one, malformed members are skipped, and unknown states fall
 * back to a neutral value rather than being cast.
 *
 * @file
 */

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
