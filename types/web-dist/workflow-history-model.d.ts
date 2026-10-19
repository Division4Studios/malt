/**
 * Typed view of the compiled `workflow-history-model` browser module for DOM-free tests.
 * `npm run check` builds web/dist after typecheck, so the file does not exist yet when types are checked.
 *
 * @file
 */

declare module '*/web/dist/workflow-history-model.js' {
  /** One editable step, as the editor decodes it. */
  interface HistoryStep {
    /** Step key. */
    readonly id: string;
    /** Kind. */
    readonly kind: string;
    /** Title. */
    readonly title: string;
    /** Seats. */
    readonly roles: readonly string[];
    /** Profile, or empty. */
    readonly profile: string;
    /** Steps it waits for. */
    readonly after: readonly string[];
    /** Readable outputs, or null for its ancestors. */
    readonly inputs: readonly string[] | null;
    /** Blind review. */
    readonly blind: boolean;
    /** Approval gate. */
    readonly gate: boolean;
    /** Skippable. */
    readonly optional: boolean;
    /** Preferred provider, or empty. */
    readonly provider: string;
    /** Extra guidance. */
    readonly instructions: string;
  }
  /** One decoded workflow. */
  interface HistoryWorkflow {
    /** Key. */
    readonly id: string;
    /** Display name. */
    readonly name: string;
    /** Description. */
    readonly description: string;
    /** Planning steps. */
    readonly planning: readonly HistoryStep[];
    /** Delivery steps. */
    readonly delivery: readonly HistoryStep[];
  }
  /** One revision. */
  interface Revision {
    /** Digest. */
    readonly revision: string;
    /** Save time or null. */
    readonly createdAt: number | null;
    /** Whether it is current. */
    readonly isCurrent: boolean;
    /** Definition. */
    readonly workflow: HistoryWorkflow;
    /** Objectives that froze it. */
    readonly objectives: readonly { featureId: string; title: string; phase: string }[];
    /** All objectives that froze it. */
    readonly objectiveCount: number;
    /** Deliveries that froze it. */
    readonly deliveryCount: number;
  }
  /** A workflow's history. */
  interface History {
    /** Workflow id. */
    readonly workflowId: string;
    /** Where it comes from. */
    readonly source: 'builtin' | 'project' | 'frozen';
    /** Revisions, current first. */
    readonly revisions: readonly Revision[];
  }
  /** Differences between two revisions. */
  interface RevisionDiff {
    /** Workflow-level changes. */
    readonly workflow: readonly string[];
    /** Step changes. */
    readonly steps: readonly {
      section: 'planning' | 'delivery';
      id: string;
      title: string;
      change: 'added' | 'removed' | 'changed';
      details: readonly string[];
    }[];
  }

  /**
   * Decode the broker's history.
   *
   * @param value - Untrusted response.
   * @returns Decoded history, empty when malformed.
   */
  export function parseHistory(value: unknown): History;

  /**
   * Compare two revisions.
   *
   * @param older - Revision compared from.
   * @param newer - Revision compared to.
   * @returns Workflow and step changes.
   */
  export function diffRevisions(older: HistoryWorkflow, newer: HistoryWorkflow): RevisionDiff;

  /**
   * Plain usage line.
   *
   * @param revision - Revision whose usage to describe.
   * @returns One sentence.
   */
  export function usageText(revision: Revision): string;
}
