/**
 * Typed view of the compiled `discovery-model` browser module for DOM-free tests.
 * `npm run check` builds web/dist after typecheck, so the file does not exist yet when types are checked.
 *
 * @file
 */

declare module '*/web/dist/discovery-model.js' {
  /** One step's failure. */
  interface StepError {
    /** Failed step. */
    readonly step: string;
    /** Remedy. */
    readonly message: string;
  }
  /** Discovery as choices. */
  interface DiscoveryChoices {
    /** Login. */
    readonly login: string;
    /** Repositories. */
    readonly repositories: readonly { readonly id: string; readonly name: string; readonly url: string }[];
    /** Owner whose Projects were listed. */
    readonly owner: string;
    /** Owners that can be listed next. */
    readonly owners: readonly string[];
    /** Open Projects. */
    readonly projects: readonly {
      readonly id: string;
      readonly number: number;
      readonly title: string;
      readonly url: string;
    }[];
    /** Single-select fields. */
    readonly fields: readonly { readonly id: string; readonly name: string }[];
    /** Step errors. */
    readonly errors: readonly StepError[];
  }
  /** A save control. */
  interface SectionSave {
    /** Operation. */
    readonly operation: 'github_section_save';
    /** Input. */
    readonly input: Record<string, unknown>;
  }

  /**
   * The read-only route that inspects a selection.
   *
   * @param project - Console project.
   * @param selection - Repository, owner and Project number.
   * @returns Same-origin path.
   */
  export function discoveryRoute(
    project: string,
    selection: { readonly repository: string; readonly owner: string; readonly projectNumber: number },
  ): string;

  /**
   * Turn a broker result into choices.
   *
   * @param value - Broker result.
   * @returns Choices.
   */
  export function readDiscovery(value: unknown): DiscoveryChoices;

  /**
   * The tracker section save for discovered choices.
   *
   * @param choices - Discovery.
   * @param projectId - Chosen Project.
   * @param fieldId - Chosen field.
   * @returns Control or null.
   */
  export function trackerSaveInput(choices: DiscoveryChoices, projectId: string, fieldId: string): SectionSave | null;

  /**
   * The source section save for a discovered repository.
   *
   * @param choices - Discovery.
   * @param repositoryId - Node ID of the chosen repository.
   * @returns Control or null.
   */
  export function sourceSaveInput(choices: DiscoveryChoices, repositoryId: string): SectionSave | null;
}
