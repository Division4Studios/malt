/**
 * Typed view of the compiled `approval-model` browser module for DOM-free tests.
 * `npm run check` builds web/dist after typecheck, so the file does not exist yet when types are checked.
 *
 * @file
 */

declare module '*/web/dist/approval-model.js' {
  /** Delivery fields an approval reads. */
  interface Delivery {
    /** Delivery id. */
    readonly taskId: string;
    /** Issue number. */
    readonly issue: number;
    /** Title. */
    readonly title: string;
    /** Current head. */
    readonly head: string | null;
  }
  /** Step fields an approval reads. */
  interface Step {
    /** Step id. */
    readonly id: string;
    /** Title. */
    readonly title: string;
  }
  /** Inbox item fields an approval reads. */
  interface InboxItem {
    /** Item id. */
    readonly id: string;
    /** Decision kind. */
    readonly kind: string;
    /** Headline. */
    readonly title: string;
    /** Delivery concerned. */
    readonly taskId: string | null;
    /** Objective concerned. */
    readonly featureId: string | null;
    /** Step to decide. */
    readonly stepId: string | null;
    /** Bound head. */
    readonly head: string | null;
  }

  /** What an approval decides. */
  export interface ApprovalTarget {
    /** Delivery step or objective plan. */
    readonly scope: 'delivery' | 'objective';
    /** Delivery or objective id. */
    readonly id: string;
    /** Step decided. */
    readonly stepId: string;
    /** Bound head. */
    readonly head: string | null;
    /** Step title. */
    readonly stepTitle: string;
    /** Subject. */
    readonly subject: string;
  }

  /**
   * Describe an Inbox approval.
   *
   * @param item - Decision waiting on the operator.
   * @returns What it decides, or null for non-approvals.
   */
  export function targetFromItem(item: InboxItem): ApprovalTarget | null;

  /**
   * Describe a delivery step approval.
   *
   * @param delivery - Card that owns the step.
   * @param step - Step waiting on the human.
   * @param open - Open Inbox items carrying the bound head.
   * @returns What the decision binds.
   */
  export function targetFromStep(delivery: Delivery, step: Step, open: readonly InboxItem[]): ApprovalTarget;

  /**
   * Whether a target is still open.
   *
   * @param target - Decision shown in an open dialog.
   * @param open - Current open Inbox items.
   * @returns Whether a matching approval still waits.
   */
  export function isPending(target: ApprovalTarget, open: readonly InboxItem[]): boolean;

  /**
   * Build the `factory_approve` input.
   *
   * @param target - What is decided.
   * @param decision - Choice, note and idempotency key.
   * @returns Input to send, or an explanation why it cannot be sent.
   */
  export function approvalInput(
    target: ApprovalTarget,
    decision: { requestId: string; approve: boolean; note: string },
  ): { input: Record<string, unknown> } | { error: string };
}
