/**
 * Shapes of Inbox entries in the console projection: decisions waiting on the
 * human and the ones already made.
 *
 * @file
 */

/** Inbox lane: decisions that need a reply, or notices to look into. */
export type InboxLane = 'reply' | 'notice';
/** Something waiting on the human. */
export interface InboxItem {
  /** Stable item id. */
  readonly id: string;
  /** What kind of decision it is. */
  readonly kind:
    | 'approval'
    | 'plan_approval'
    | 'question'
    | 'blocked_delivery'
    | 'blocked_objective'
    | 'skill'
    | 'spend_cap'
    | 'done_criteria';
  /** Lane it is listed in. */
  readonly lane: InboxLane;
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
