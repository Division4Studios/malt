/**
 * DOM-free approval rules shared by the Inbox and delivery views: what a
 * decision targets and the exact `factory_approve` input it sends. The server
 * re-validates everything; these checks only give the operator early feedback.
 *
 * @file
 */
import { t } from './i18n.js';

import type { Delivery, InboxItem, Step } from './console-model.js';

/** Longest note the server accepts. */
export const NOTE_MAX = 4000;
/** Separator the broker places between a step title and its subject. */
const TITLE_SEPARATOR = ' · ';

/** What an approval decides. */
export interface ApprovalTarget {
  /** Whether a delivery step or an objective's plan is decided. */
  readonly scope: 'delivery' | 'objective';
  /** Delivery id or objective id. */
  readonly id: string;
  /** Step to decide. */
  readonly stepId: string;
  /** Head the decision binds; `null` for plan approvals. */
  readonly head: string | null;
  /** Step title shown in the dialog. */
  readonly stepTitle: string;
  /** Delivery or objective the step belongs to. */
  readonly subject: string;
}

/** The operator's decision. */
export interface ApprovalDecision {
  /** Idempotency key, generated once per dialog opening. */
  readonly requestId: string;
  /** Approve or reject. */
  readonly approve: boolean;
  /** Operator note; required when rejecting. */
  readonly note: string;
}

/** Exact `factory_approve` input. */
export interface ApprovalInput {
  /** Idempotency key. */
  readonly requestId: string;
  /** Delivery decided, for delivery approvals. */
  readonly taskId?: string;
  /** Objective decided, for plan approvals. */
  readonly featureId?: string;
  /** Step decided. */
  readonly stepId: string;
  /** Bound head, or `null` for plan approvals. */
  readonly head: string | null;
  /** Approve or reject. */
  readonly approve: boolean;
  /** Trimmed note. */
  readonly note: string;
}

/**
 * Split a broker item title into step title and subject.
 *
 * @param title - Title such as `Security review · #12 Add login`.
 * @returns Step title and subject; the whole title is both when unseparated.
 */
function splitTitle(title: string): { stepTitle: string; subject: string } {
  const at = title.indexOf(TITLE_SEPARATOR);
  return at === -1
    ? { stepTitle: title, subject: title }
    : { stepTitle: title.slice(0, at), subject: title.slice(at + TITLE_SEPARATOR.length) };
}

/**
 * Describe what an Inbox approval decides.
 *
 * @param item - Open Inbox item.
 * @returns Target, or `null` when the item is not an approval or lacks its ids.
 */
export function targetFromItem(item: InboxItem): ApprovalTarget | null {
  if (item.stepId === null) {
    return null;
  }
  const names = splitTitle(item.title);
  if (item.kind === 'approval' && item.taskId !== null) {
    return { scope: 'delivery', id: item.taskId, stepId: item.stepId, head: item.head, ...names };
  }
  return item.kind === 'plan_approval' && item.featureId !== null
    ? { scope: 'objective', id: item.featureId, stepId: item.stepId, head: null, ...names }
    : null;
}

/**
 * Describe what approving a delivery step decides.
 *
 * @param delivery - Delivery shown.
 * @param step - Step waiting on the human.
 * @param open - Open Inbox items, whose matching item carries the bound head.
 * @returns Target bound to the item's head, or the delivery head when no item matches.
 */
export function targetFromStep(delivery: Delivery, step: Step, open: readonly InboxItem[]): ApprovalTarget {
  const item = open.find((candidate) => candidate.id === `approval:${delivery.taskId}:${step.id}`);
  return {
    scope: 'delivery',
    id: delivery.taskId,
    stepId: step.id,
    head: item === undefined ? delivery.head : item.head,
    stepTitle: step.title,
    subject: `#${String(delivery.issue)} ${delivery.title}`,
  };
}

/**
 * Whether a target is still waiting on the human.
 *
 * @param target - Target of an open dialog.
 * @param open - Current open Inbox items.
 * @returns Whether a matching approval is still open.
 */
export function isPending(target: ApprovalTarget, open: readonly InboxItem[]): boolean {
  const id =
    target.scope === 'delivery' ? `approval:${target.id}:${target.stepId}` : `plan:${target.id}:${target.stepId}`;
  return open.some((item) => item.id === id);
}

/**
 * Build the `factory_approve` input for a decision.
 *
 * @param target - What is decided.
 * @param decision - Operator's choice, note and request id.
 * @returns Input to send, or a message explaining why it cannot be sent.
 */
export function approvalInput(
  target: ApprovalTarget,
  decision: ApprovalDecision,
): { input: ApprovalInput } | { error: string } {
  const note = decision.note.trim();
  if (note === '' && !decision.approve) {
    return { error: t('Explain what must change before rejecting.') };
  }
  if (note.length > NOTE_MAX) {
    return { error: t('Keep the note under {noteMax} characters.', { noteMax: NOTE_MAX }) };
  }
  const owner = target.scope === 'delivery' ? { taskId: target.id } : { featureId: target.id };
  return {
    input: {
      requestId: decision.requestId,
      ...owner,
      stepId: target.stepId,
      head: target.scope === 'delivery' ? target.head : null,
      approve: decision.approve,
      note,
    },
  };
}
