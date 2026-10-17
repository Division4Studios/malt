/**
 * Ready-to-render console projection computed by the broker, so the browser
 * never re-implements workflow rules. It describes each delivery and planning
 * objective as a pipeline of steps with a plain state, places them on a
 * five-column board, and lists every decision waiting on the human as one
 * Inbox. Frozen workflow copies stay server-side.
 *
 * @file
 */

/** Where a step stands for its delivery or objective. */
export type StepState = 'done' | 'running' | 'ready' | 'needs_you' | 'waiting';
/** Board column. */
export type Column = 'planning' | 'ready' | 'in_progress' | 'needs_you' | 'done';

/** The latest result a step recorded, when it has one. */
export interface StepResultView {
  /** Verdict. */
  readonly outcome: string;
  /** What the role reported. */
  readonly summary: string;
  /** Severity-tagged findings, if any. */
  readonly findings: readonly string[];
  /** A fixer's or plan reviser's rulings, if any. */
  readonly dispositions: readonly { id: string; decision: string; reason: string; evidence: string }[];
  /** Seat that produced it, or `operator` for a human decision. */
  readonly role: string;
}

/** One step as the console shows it. */
export interface StepView {
  /** Step id within its workflow. */
  readonly id: string;
  /** Human title. */
  readonly title: string;
  /** Step kind. */
  readonly kind: string;
  /** One-based execution layer; steps sharing a layer run in parallel. */
  readonly layer: number;
  /** Seats that may perform it; empty for human approvals. */
  readonly roles: readonly string[];
  /** Plain state. */
  readonly state: StepState;
  /** Whether a human approves after it succeeds. */
  readonly gate: boolean;
  /** Whether it is a blind review. */
  readonly blind: boolean;
  /** Preferred provider family, if any. */
  readonly provider: string | null;
  /** Latest result, when recorded. */
  readonly result: StepResultView | null;
}

/** A delivery card and its pipeline. */
export interface DeliveryView {
  /** Delivery id. */
  readonly taskId: string;
  /** Tracker issue number. */
  readonly issue: number;
  /** Title. */
  readonly title: string;
  /** Owning objective, if any. */
  readonly featureId: string | null;
  /** Ledger phase. */
  readonly phase: string;
  /** Board column. */
  readonly column: Column;
  /** Workflow identity. */
  readonly workflow: { readonly id: string; readonly name: string };
  /** Steps in workflow order. */
  readonly steps: readonly StepView[];
  /** Live attempt, if one is running. */
  readonly running: { readonly jobId: string; readonly role: string; readonly step: string | null } | null;
  /** Current head. */
  readonly head: string | null;
  /** Current base. */
  readonly base: string | null;
  /** Pull request link, once published. */
  readonly prUrl: string | null;
  /** Implementation owner. */
  readonly developer: string | null;
  /** Issue numbers of unfinished dependencies blocking implementation. */
  readonly waitingOn: readonly number[];
  /** Attempts so far. */
  readonly attempts: number;
  /** Blocker or last error. */
  readonly error: string | null;
  /** Operator hold: no new attempt starts while set. */
  readonly held: { readonly at: number; readonly reason: string } | null;
  /** Whether the operator chose to keep it on the board after it finished. */
  readonly isKept: boolean;
  /** Last change time. */
  readonly updatedAt: number;
}

/** An objective card while it is being planned. */
export interface ObjectiveView {
  /** Objective id. */
  readonly featureId: string;
  /** First line of the objective. */
  readonly title: string;
  /** Ledger phase. */
  readonly phase: string;
  /** Board column. */
  readonly column: Column;
  /** Workflow identity. */
  readonly workflow: { readonly id: string; readonly name: string };
  /** Planning steps. */
  readonly steps: readonly StepView[];
  /** Delivery progress once provisioned. */
  readonly deliveries: { readonly total: number; readonly done: number };
  /** Blocker or last error. */
  readonly error: string | null;
  /** Creation time. */
  readonly createdAt: number;
}

/** Something waiting on the human. */
export interface InboxItem {
  /** Stable item id. */
  readonly id: string;
  /** What kind of decision it is. */
  readonly kind: 'approval' | 'plan_approval' | 'blocked_delivery' | 'blocked_objective' | 'skill';
  /** Headline. */
  readonly title: string;
  /** Context the operator needs. */
  readonly detail: string;
  /** When it started waiting. */
  readonly since: number;
  /** Delivery, when it concerns one. */
  readonly taskId: string | null;
  /** Objective, when it concerns one. */
  readonly featureId: string | null;
  /** Step to decide, for approvals. */
  readonly stepId: string | null;
  /** Head an approval binds, for delivery approvals. */
  readonly head: string | null;
  /** Skill request, for skill decisions. */
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

/** Complete console projection. */
export interface ConsoleView {
  /** Delivery cards. */
  readonly deliveries: readonly DeliveryView[];
  /** Objective cards while planning. */
  readonly objectives: readonly ObjectiveView[];
  /** Finished deliveries archived off the board. */
  readonly archived: number;
  /** Human decisions. */
  readonly inbox: { readonly open: readonly InboxItem[]; readonly answered: readonly AnsweredItem[] };
}
