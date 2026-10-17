/**
 * Typed view of the compiled `workflow-model` browser module for DOM-free tests.
 * `npm run check` builds web/dist after typecheck, so the file does not exist yet when types are checked.
 *
 * @file
 */

declare module '*/web/dist/workflow-model.js' {
  /** Planning or delivery. */
  export type SectionName = 'planning' | 'delivery';
  /** One editable step; `uid` is browser-only. */
  export interface DraftStep {
    /** Browser-only stable identity. */
    readonly uid: string;
    /** Step key. */
    readonly id: string;
    /** Step kind. */
    readonly kind: string;
    /** Public label. */
    readonly title: string;
    /** Seats that may take the step. */
    readonly roles: readonly string[];
    /** Profile key, or empty. */
    readonly profile: string;
    /** Earlier steps it waits for. */
    readonly after: readonly string[];
    /** Explicit readable outputs, or null for everything it runs after. */
    readonly inputs: readonly string[] | null;
    /** Blind review. */
    readonly blind: boolean;
    /** Human approval after success. */
    readonly gate: boolean;
    /** Skippable per delivery. */
    readonly optional: boolean;
    /** Preferred provider, or empty. */
    readonly provider: string;
    /** Extra guidance. */
    readonly instructions: string;
  }
  /** One editable workflow. */
  export interface DraftWorkflow {
    /** Workflow key. */
    readonly id: string;
    /** Display name. */
    readonly name: string;
    /** Plain description. */
    readonly description: string;
    /** Planning steps. */
    readonly planning: readonly DraftStep[];
    /** Delivery steps. */
    readonly delivery: readonly DraftStep[];
  }
  /** One decoded library entry. */
  export interface LibraryItem {
    /** Workflow key. */
    readonly id: string;
    /** Revision digest. */
    readonly revision: string;
    /** Origin of the definition. */
    readonly source: 'builtin' | 'project';
    /** Whether new objectives use it. */
    readonly isDefault: boolean;
    /** Last project save, or null. */
    readonly updatedAt: number | null;
    /** Definition at this revision. */
    readonly workflow: DraftWorkflow;
  }
  /** The decoded library. */
  export interface Library {
    /** Default workflow id. */
    readonly defaultId: string;
    /** Every usable workflow. */
    readonly items: readonly LibraryItem[];
  }
  /** Where a draft came from. */
  export interface DraftOrigin {
    /** Opened workflow id, or empty. */
    readonly id: string;
    /** Opened revision, or null. */
    readonly revision: string | null;
  }
  /** Planning kinds in menu order. */
  export const PLANNING_KINDS: readonly string[];
  /** Delivery kinds in menu order. */
  export const DELIVERY_KINDS: readonly string[];
  /** Every seat a step may name. */
  export const SEATS: readonly string[];
  /** Provider families. */
  export const PROVIDERS: readonly string[];
  /** Longest valid key. */
  export const KEY_MAX: number;

  /**
   * Whether a value is a valid key.
   *
   * @param value - Candidate key.
   * @returns True when the server accepts it.
   */
  export function isKey(value: string): boolean;

  /**
   * First free key with numeric suffixes.
   *
   * @param base - Preferred key.
   * @param taken - Keys in use.
   * @returns Unused key.
   */
  export function uniqueKey(base: string, taken: ReadonlySet<string>): string;

  /**
   * Derive a unique key from a title.
   *
   * @param title - Free text.
   * @param taken - Keys in use.
   * @param fallback - Key used when the title has no letters or digits.
   * @returns Unused valid key.
   */
  export function deriveKey(title: string, taken: ReadonlySet<string>, fallback?: string): string;

  /**
   * Decode a workflow definition.
   *
   * @param value - Untrusted record.
   * @returns Editable draft.
   */
  export function decodeWorkflow(value: Record<string, unknown>): DraftWorkflow;

  /**
   * Decode the library from a snapshot.
   *
   * @param snapshot - Untrusted snapshot.
   * @returns Library, empty when unavailable.
   */
  export function parseLibrary(snapshot: unknown): Library;

  /**
   * Execution layer per step id.
   *
   * @param steps - One section in order.
   * @returns One-based layers.
   */
  export function stepLayers(steps: readonly { id: string; after: readonly string[] }[]): Map<string, number>;

  /**
   * Steps grouped by layer.
   *
   * @param steps - One section in order.
   * @returns Layers in order.
   */
  export function layerGroups<T extends { id: string; after: readonly string[] }>(steps: readonly T[]): T[][];

  /**
   * Change a step's kind and clear unsupported settings.
   *
   * @param step - Current step.
   * @param kind - New kind.
   * @returns Normalized step.
   */
  export function withKind(step: DraftStep, kind: string): DraftStep;
}
