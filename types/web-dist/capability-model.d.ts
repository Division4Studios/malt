/**
 * Typed view of the compiled `capability-model` browser module for DOM-free tests.
 * `npm run check` builds web/dist after typecheck, so the file does not exist yet when types are checked.
 *
 * @file
 */

declare module '*/web/dist/capability-model.js' {
  /** A policy mode. */
  type CapabilityMode = 'disabled' | 'human-only' | 'approved-agent-roles';
  /** Provider support. */
  type SupportState = 'supported' | 'unsupported' | 'unverified';

  /** Mode and roles. */
  interface PolicyDraft {
    /** Mode. */
    readonly mode: CapabilityMode;
    /** Approved roles. */
    readonly roles: readonly string[];
  }

  /** One capability row. */
  interface CapabilityRow extends PolicyDraft {
    /** Capability. */
    readonly capability: string;
    /** Provider support. */
    readonly support: SupportState;
  }

  /** One policy change. */
  interface PolicyChange {
    /** Capability. */
    readonly capability: string;
    /** Actor. */
    readonly actor: string;
    /** Before. */
    readonly previous: PolicyDraft;
    /** After. */
    readonly next: PolicyDraft;
    /** ISO time. */
    readonly time: string;
  }

  /** Capabilities view model. */
  interface CapabilityMatrix {
    /** Provider. */
    readonly provider: string;
    /** Rows. */
    readonly rows: readonly CapabilityRow[];
    /** Newest first. */
    readonly history: readonly PolicyChange[];
  }

  /** Policy modes. */
  export const CAPABILITY_MODES: readonly CapabilityMode[];
  /** Grantable roles. */
  export const AGENT_ROLES: readonly string[];

  /**
   * Read the capability view.
   *
   * @param value - Broker response.
   * @returns Model.
   */
  export function readCapabilities(value: unknown): CapabilityMatrix;

  /**
   * Describe provider support.
   *
   * @param support - Combined provider support.
   * @returns Display text.
   */
  export function supportLabel(support: SupportState): string;

  /**
   * Describe a mode.
   *
   * @param mode - Stored or drafted mode.
   * @returns Display text.
   */
  export function modeLabel(mode: CapabilityMode): string;

  /**
   * Whether a row may take a mode.
   *
   * @param row - Capability row.
   * @param mode - Candidate.
   * @returns Whether offered.
   */
  export function isModeOffered(row: CapabilityRow, mode: CapabilityMode): boolean;

  /**
   * Why a draft cannot be saved.
   *
   * @param draft - Chosen mode and roles.
   * @returns Problem or null.
   */
  export function draftProblem(draft: PolicyDraft): string | null;

  /**
   * The policy edit.
   *
   * @param capability - Connector capability name.
   * @param draft - Chosen mode and roles.
   * @returns Operator control.
   */
  export function policySetInput(
    capability: string,
    draft: PolicyDraft,
  ): { readonly operation: 'capability_policy_set'; readonly input: Record<string, unknown> };

  /**
   * Describe one change.
   *
   * @param change - History entry.
   * @returns Line.
   */
  export function changeText(change: PolicyChange): string;
}
