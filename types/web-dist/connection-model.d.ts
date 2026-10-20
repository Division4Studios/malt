/**
 * Typed view of the compiled `connection-model` browser module for DOM-free tests.
 * `npm run check` builds web/dist after typecheck, so the file does not exist yet when types are checked.
 *
 * @file
 */

declare module '*/web/dist/connection-model.js' {
  /** Verification state, or none before a save. */
  type SectionState = 'none' | 'saved' | 'verified' | 'degraded' | 'failed' | 'external';
  /** Whether a credential is available; never its value. */
  type CredentialPresence = 'present' | 'missing' | 'unverified';
  /** One step's failure. */
  interface StepError {
    /** Failed step. */
    readonly step: string;
    /** Remedy. */
    readonly message: string;
  }
  /** One section. */
  interface SectionView {
    /** State. */
    readonly state: SectionState;
    /** Last check. */
    readonly checkedAt: string;
    /** Presence only. */
    readonly credential: CredentialPresence;
    /** Saved choice. */
    readonly selection: string;
    /** Link. */
    readonly url: string;
    /** Step errors. */
    readonly errors: readonly StepError[];
  }
  /** A saved Jira tracker. */
  interface JiraSettings {
    /** Site origin. */
    readonly site: string;
    /** Project key. */
    readonly projectKey: string;
    /** Account email. */
    readonly email: string;
    /** Token variable name. */
    readonly tokenVariable: string;
  }
  /** Both sections. */
  interface ConnectionView {
    /** Saved tracker provider. */
    readonly trackerProvider: 'github-projects' | 'jira' | null;
    /** Work tracker. */
    readonly tracker: SectionView;
    /** Saved Jira tracker settings. */
    readonly jira: JiraSettings | null;
    /** The saved Jira tracker's intake filter, stage mapping and last intake read. */
    readonly jiraWorkflow: {
      readonly jql: string;
      readonly stages: Readonly<Record<string, string>>;
      readonly statuses: readonly { readonly id: string; readonly name: string }[];
      readonly lastIntake: unknown;
    } | null;
    /** Source provider in use. */
    readonly sourceProvider: 'github' | 'local';
    /** GitHub source. */
    readonly source: SectionView;
    /** Local hub, when it is the source. */
    readonly hub: {
      readonly base: string;
      readonly remote: string;
      readonly issues: number;
      readonly pulls: number;
    } | null;
    /** Saved owner. */
    readonly owner: string;
    /** Nothing saved yet. */
    readonly isUnsaved: boolean;
  }
  /** A save control. */
  interface SectionSave {
    /** Operation. */
    readonly operation: 'github_section_save';
    /** Input. */
    readonly input: Record<string, unknown>;
  }

  /**
   * Read the tracker and source sections from a snapshot.
   *
   * @param snapshot - Live snapshot.
   * @returns Sections.
   */
  export function readConnection(snapshot: unknown): ConnectionView;

  /**
   * Providers the tracker section offers.
   *
   * @returns Options.
   */
  export function trackerProviders(): readonly { readonly id: string; readonly label: string }[];

  /**
   * Providers the source section can show.
   *
   * @returns Options.
   */
  export function sourceProviders(): readonly { readonly id: string; readonly label: string }[];

  /**
   * Name a verification state for display.
   *
   * @param state - Verification state, or none.
   * @returns Display text.
   */
  export function sectionStateLabel(state: SectionState): string;

  /**
   * Name credential presence for display.
   *
   * @param presence - Reported availability.
   * @returns Display text.
   */
  export function credentialLabel(presence: CredentialPresence): string;

  /**
   * Combine section saves.
   *
   * @param saves - Saves, `null` entries skipped.
   * @returns One control, or null.
   */
  export function sectionSave(...saves: readonly (SectionSave | null)[]): SectionSave | null;
}
