/**
 * Typed view of the compiled `jira-model` browser module for DOM-free tests.
 * `npm run check` builds web/dist after typecheck, so the file does not exist yet when types are checked.
 *
 * @file
 */

declare module '*/web/dist/jira-model.js' {
  /** Discovery outcome. */
  type JiraDiscoveryState = 'verified' | 'degraded' | 'external_setup_required' | 'unsupported';
  /** The Jira form. */
  interface JiraSettings {
    /** Site. */
    readonly site: string;
    /** Project key. */
    readonly projectKey: string;
    /** Account email. */
    readonly email: string;
    /** Token variable name. */
    readonly tokenVariable: string;
  }
  /** What discovery found. */
  interface JiraFindings {
    /** Outcome. */
    readonly state: JiraDiscoveryState;
    /** Confirmed site. */
    readonly site: string;
    /** Account display name. */
    readonly account: string;
    /** The project. */
    readonly project: { readonly id: string; readonly key: string; readonly name: string; readonly url: string } | null;
    /** Issue type count. */
    readonly issueTypes: number;
    /** Missing permissions. */
    readonly missing: readonly { readonly permission: string; readonly action: string }[];
    /** Problems. */
    readonly problems: readonly { readonly scope: string; readonly message: string }[];
  }
  /** The admin summary. */
  interface JiraAccess {
    /** Mode. */
    readonly mode: string;
    /** Roles. */
    readonly roles: readonly string[];
    /** Reads. */
    readonly reads: readonly string[];
    /** Writes. */
    readonly writes: readonly { readonly capability: string; readonly change: string; readonly mode: string }[];
  }
  /** A save control. */
  interface SectionSave {
    /** Operation. */
    readonly operation: 'github_section_save';
    /** Input. */
    readonly input: Record<string, unknown>;
  }

  /**
   * Prefill the form.
   *
   * @param saved - Saved Jira tracker.
   * @returns Prefilled values.
   */
  export function jiraForm(saved: JiraSettings | null): JiraSettings;

  /**
   * The first problem with the form.
   *
   * @param form - Operator values.
   * @returns Problem or null.
   */
  export function jiraFormProblem(form: JiraSettings): string | null;

  /**
   * The discovery control.
   *
   * @param form - Operator values.
   * @returns Control.
   */
  export function jiraDiscoverInput(form: JiraSettings): {
    readonly operation: 'jira_discover';
    readonly input: Record<string, unknown>;
  };

  /**
   * Read a discovery result.
   *
   * @param value - Result.
   * @returns Findings.
   */
  export function readJiraDiscovery(value: unknown): JiraFindings;

  /**
   * Name an outcome.
   *
   * @param state - Outcome.
   * @returns Text.
   */
  export function jiraStateLabel(state: JiraDiscoveryState): string;

  /**
   * The tracker save for discovered findings.
   *
   * @param form - Operator values.
   * @param findings - Latest discovery.
   * @returns Save or null.
   */
  export function jiraSaveInput(form: JiraSettings, findings: JiraFindings | null): SectionSave | null;

  /**
   * Read the admin summary.
   *
   * @param value - Capability policy view.
   * @returns Summary or null.
   */
  export function readJiraAccess(value: unknown): JiraAccess | null;

  /**
   * Name a Jira mode.
   *
   * @param mode - Jira mode name.
   * @returns Text.
   */
  export function jiraModeLabel(mode: string): string;
}
