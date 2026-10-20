/**
 * Typed view of the compiled `jira-workflow-model` browser module for DOM-free tests.
 * `npm run check` builds web/dist after typecheck, so the file does not exist yet when types are checked.
 *
 * @file
 */

declare module '*/web/dist/jira-workflow-model.js' {
  /** One Jira status. */
  interface JiraStatus {
    /** Status ID. */
    readonly id: string;
    /** Status name. */
    readonly name: string;
  }
  /** An issue intake skipped. */
  interface SkippedIssue {
    /** Jira key. */
    readonly key: string;
    /** Skip reason. */
    readonly reason: string;
  }
  /** The last intake read. */
  interface IntakeRead {
    /** When it read. */
    readonly checkedAt: string;
    /** Issues it offered. */
    readonly offered: readonly string[];
    /** Issues it skipped. */
    readonly skipped: readonly SkippedIssue[];
    /** Seconds Jira asked to wait, or zero. */
    readonly retryAfterSeconds: number;
    /** Why it failed, or empty. */
    readonly error: string;
  }
  /** A saved Jira workflow. */
  interface JiraWorkflowView {
    /** Intake filter, or empty. */
    readonly jql: string;
    /** Status ID per mapped stage. */
    readonly stages: Readonly<Record<string, string>>;
    /** The project's statuses. */
    readonly statuses: readonly JiraStatus[];
    /** The last intake read. */
    readonly lastIntake: IntakeRead | null;
  }
  /** Unsaved choices. */
  interface JiraWorkflowDraft {
    /** Intake filter. */
    readonly jql: string;
    /** Status ID per stage. */
    readonly stages: Readonly<Record<string, string>>;
  }
  /** What intake would file. */
  interface IntakePreview {
    /** Issues it would file. */
    readonly queue: readonly string[];
    /** Issues it would skip. */
    readonly skipped: readonly SkippedIssue[];
    /** Whether more issues match. */
    readonly isTruncated: boolean;
  }

  /** Stages a human may map. */
  export const MAPPED_STAGES: readonly string[];

  /**
   * Read a saved Jira tracker's workflow.
   *
   * @param github - `github_status` snapshot.
   * @returns Workflow, or null for another tracker.
   */
  export function readJiraWorkflow(github: Readonly<Record<string, unknown>>): JiraWorkflowView | null;

  /**
   * The draft a saved workflow starts from.
   *
   * @param view - Saved workflow.
   * @returns Unchanged choices.
   */
  export function workflowDraft(view: JiraWorkflowView): JiraWorkflowDraft;

  /**
   * Explain what is wrong with a draft.
   *
   * @param draft - Choices.
   * @returns Problem or null.
   */
  export function workflowProblem(draft: JiraWorkflowDraft): string | null;

  /**
   * The save control for a draft.
   *
   * @param draft - Choices.
   * @param statuses - The project's statuses.
   * @returns Control.
   */
  export function workflowSaveInput(
    draft: JiraWorkflowDraft,
    statuses: readonly JiraStatus[],
  ): { readonly operation: 'jira_workflow_save'; readonly input: Readonly<Record<string, unknown>> };

  /**
   * Read a save's preview.
   *
   * @param value - Save result.
   * @returns Preview or null.
   */
  export function readIntakePreview(value: unknown): IntakePreview | null;

  /**
   * Describe a skip reason.
   *
   * @param reason - Why intake skipped an issue.
   * @returns Display text.
   */
  export function skipReasonLabel(reason: string): string;
}
