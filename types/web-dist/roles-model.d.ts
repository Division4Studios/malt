/**
 * Typed view of the compiled `roles-model` browser module for DOM-free tests.
 * `npm run check` builds web/dist after typecheck, so the file does not exist yet when types are checked.
 *
 * @file
 */

declare module '*/web/dist/roles-model.js' {
  /** One local stdio MCP server. */
  interface ServerDraft {
    /** Server name. */
    readonly name: string;
    /** Executable. */
    readonly command: string;
    /** Literal arguments. */
    readonly args: readonly string[];
  }

  /** One editable role type. */
  interface TypeDraft {
    /** Type name. */
    readonly name: string;
    /** Label. */
    readonly label: string;
    /** Instructions. */
    readonly instructions: string;
    /** Prioritized skills. */
    readonly skills: readonly string[];
    /** Capability floor. */
    readonly minimumTier: 'small' | 'standard' | 'advanced';
    /** Provider waited for, or null. */
    readonly provider: 'codex' | 'claude' | null;
    /** Preferred policy entry, or null. */
    readonly modelId: string | null;
    /** Effort floor, or null. */
    readonly effort: string | null;
    /** How the tool list applies. */
    readonly toolMode: 'deny' | 'allow';
    /** Deny rules saved beside an allow list. */
    readonly keptDeny: readonly string[];
    /** Tools the mode lists. */
    readonly tools: readonly string[];
    /** Local MCP servers. */
    readonly servers: readonly ServerDraft[];
    /** Whether the role may ask questions. */
    readonly canAsk: boolean;
  }

  /** One seat's member entry. */
  interface MemberDraft {
    /** Seat. */
    readonly role: string;
    /** Type. */
    readonly type: string;
    /** Manager seat, or null. */
    readonly reportsTo: string | null;
  }

  /** Roles view model. */
  interface RolesModel {
    /** Whether the project has settings. */
    readonly isConfigured: boolean;
    /** Whether saves are possible now. */
    readonly isPaused: boolean;
    /** Saved types. */
    readonly types: readonly TypeDraft[];
    /** Saved members. */
    readonly members: readonly MemberDraft[];
    /** Editor choices. */
    readonly catalog: {
      /** Revision a save names. */
      readonly revision: string | null;
      /** Reviewed skills. */
      readonly skills: readonly string[];
      /** MALT tools with their seats. */
      readonly tools: readonly { readonly name: string; readonly seats: readonly string[] }[];
      /** Native families. */
      readonly native: readonly string[];
    };
    /** Allowed models. */
    readonly models: readonly {
      /** Entry id. */
      readonly id: string;
      /** Provider. */
      readonly provider: 'codex' | 'claude';
      /** Native model. */
      readonly model: string;
      /** Supported efforts. */
      readonly efforts: readonly string[];
    }[];
    /** Secret names granted to each type. */
    readonly secrets: Readonly<Record<string, readonly string[]>>;
  }

  /**
   * Read the Roles view model.
   *
   * @param snapshot - Live snapshot.
   * @returns Organization, catalog and allowed models.
   */
  export function readRoles(snapshot: unknown): RolesModel;

  /**
   * Seats that use a type.
   *
   * @param members - Seat entries to search.
   * @param type - Type name.
   * @returns Seats that use the type.
   */
  export function seatsUsing(members: readonly MemberDraft[], type: string): string[];

  /**
   * Tools a type's seats have.
   *
   * @param catalog - Editor choices.
   * @param seats - Seats using the type.
   * @returns Tool names.
   */
  export function toolsFor(catalog: RolesModel['catalog'], seats: readonly string[]): string[];

  /**
   * A fresh type.
   *
   * @param name - Name for the new type.
   * @returns Draft.
   */
  export function blankType(name: string): TypeDraft;

  /**
   * Copy a type under a free name.
   *
   * @param types - Existing types.
   * @param source - Type to copy.
   * @returns Copy.
   */
  export function duplicateType(types: readonly TypeDraft[], source: TypeDraft): TypeDraft;

  /**
   * Split argument text one per line.
   *
   * @param text - Arguments as typed.
   * @returns Arguments.
   */
  export function argumentLines(text: string): string[];

  /**
   * Problems with one type.
   *
   * @param type - Draft type.
   * @param model - View model.
   * @returns Problem sentences; empty when valid.
   */
  export function typeProblems(type: TypeDraft, model: RolesModel): string[];

  /**
   * Problems with the whole draft.
   *
   * @param types - Draft types.
   * @param members - Draft members.
   * @param model - View model.
   * @returns Problem sentences; empty when valid.
   */
  export function organizationProblems(
    types: readonly TypeDraft[],
    members: readonly MemberDraft[],
    model: RolesModel,
  ): string[];

  /**
   * The revision-checked save.
   *
   * @param revision - Base revision.
   * @param types - Draft types.
   * @param members - Draft members.
   * @returns Operator control.
   */
  export function rolesSaveInput(
    revision: string,
    types: readonly TypeDraft[],
    members: readonly MemberDraft[],
  ): { readonly operation: 'factory_roles_save'; readonly input: Record<string, unknown> };

  /**
   * Model and provider summary.
   *
   * @param type - Draft type.
   * @param models - Allowed models.
   * @returns Sentence for the view.
   */
  export function modelSummary(type: TypeDraft, models: RolesModel['models']): string;

  /**
   * Tool policy summary.
   *
   * @param type - Draft type.
   * @returns Sentence for the view.
   */
  export function toolSummary(type: TypeDraft): string;
}
