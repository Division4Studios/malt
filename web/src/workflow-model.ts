/**
 * DOM-free model of the workflow editor: the closed step vocabulary, decoding
 * the library from an untrusted snapshot, execution layers, immutable draft
 * edits (add, remove, move, rename with reference updates) and the exact
 * request bodies sent through the console's operator control path. The
 * vocabulary mirrors `src/factory/workflow-schema.ts` and `src/factory/seats.ts`;
 * a test keeps the copies identical. The server remains the authority.
 *
 * @file
 */

import { child, data, hasFlag, records, text } from './api.js';

import type { Data } from './api.js';

/** Planning step kinds, in menu order (mirrors `PLANNING_STEP_KINDS`). */
export const PLANNING_KINDS = ['specify', 'plan', 'plan_review', 'plan_revise', 'approve'] as const;
/** Delivery step kinds, in menu order (mirrors `DELIVERY_STEP_KINDS`). */
export const DELIVERY_KINDS = [
  'implement',
  'review',
  'adjudicate',
  'document',
  'regress',
  'approve',
  'final',
  'verify',
] as const;
/** Every seat a step may name (mirrors `FACTORY_ROLES`). */
export const SEATS = [
  'product-owner',
  'team-lead',
  'developer-1',
  'developer-2',
  'qa-1',
  'qa-2',
  'final-tester',
  'learning-steward',
  'plan-reviewer',
  'fixer',
  'librarian',
  'regression-verifier',
] as const;
/** Provider families a step may prefer (mirrors `PROVIDERS`). */
export const PROVIDERS = ['codex', 'claude'] as const;
/** Section bounds (mirror the schema maxima), so the editor stops adding before the server refuses. */
export const MAX_STEPS = { planning: 12, delivery: 24 } as const;
/** Longest valid key. */
export const KEY_MAX = 64;
/** Longest step title or workflow name (mirrors `TITLE_MAX`). */
export const TITLE_MAX = 120;
/** Longest workflow description (mirrors `DESCRIPTION_MAX`). */
export const DESCRIPTION_MAX = 2000;
/** Longest step instructions (mirrors `INSTRUCTIONS_MAX`). */
export const INSTRUCTIONS_MAX = 8000;
/** The server's key rule: a lowercase letter or digit, then up to 63 word characters or hyphens. */
const KEY_PATTERN = /^[\da-z][\w\-]{0,63}$/v;
/** Readable names for each step kind. */
export const KIND_LABELS: Readonly<Record<string, string>> = {
  specify: 'Specify',
  plan: 'Plan',
  plan_review: 'Plan review',
  plan_revise: 'Plan revision',
  approve: 'Human approval',
  implement: 'Implement',
  review: 'Review',
  adjudicate: 'Adjudicate and fix',
  document: 'Document',
  regress: 'Regression check',
  final: 'Final check',
  verify: 'Verify main',
};
/** Kinds that cannot be skipped (mirrors `REQUIRED_KINDS`). */
const REQUIRED_KINDS: ReadonlySet<string> = new Set(['plan', 'implement', 'final', 'verify']);
/** Kinds that cannot carry a gate: merges are approved by an approval step instead. */
const UNGATED_KINDS: ReadonlySet<string> = new Set(['final', 'verify', 'approve']);

/** One workflow section. */
export type SectionName = 'planning' | 'delivery';
/** Both sections in execution order. */
export const SECTIONS: readonly SectionName[] = ['planning', 'delivery'];

/** One editable step; `uid` is a browser-only identity that survives id edits and moves. */
export interface DraftStep {
  /** Browser-only stable identity; never sent. */
  readonly uid: string;
  /** Step key referenced by `after` and `inputs`. */
  readonly id: string;
  /** Step kind from the closed vocabulary. */
  readonly kind: string;
  /** Short public label. */
  readonly title: string;
  /** Seats that may take the step. */
  readonly roles: readonly string[];
  /** Organization profile key, or empty for the seat's own. */
  readonly profile: string;
  /** Earlier steps of the same section this step waits for. */
  readonly after: readonly string[];
  /** Explicit readable outputs, or `null` for everything it runs after. */
  readonly inputs: readonly string[] | null;
  /** Review only: no peer findings. */
  readonly blind: boolean;
  /** Ask a human in the Inbox after success. */
  readonly gate: boolean;
  /** The operator may skip it for one delivery. */
  readonly optional: boolean;
  /** Preferred provider family, or empty for normal routing. */
  readonly provider: string;
  /** Extra step guidance. */
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
  /** Planning steps in execution order. */
  readonly planning: readonly DraftStep[];
  /** Delivery steps in execution order. */
  readonly delivery: readonly DraftStep[];
}

/** One library entry decoded from the snapshot. */
export interface LibraryItem {
  /** Workflow key. */
  readonly id: string;
  /** Current revision digest. */
  readonly revision: string;
  /** Shipped with MALT or saved by this project. */
  readonly source: 'builtin' | 'project';
  /** Whether new objectives use it. */
  readonly isDefault: boolean;
  /** Last project save time, or null for built-ins. */
  readonly updatedAt: number | null;
  /** Definition at the current revision. */
  readonly workflow: DraftWorkflow;
}

/** The decoded library. */
export interface Library {
  /** Default workflow id. */
  readonly defaultId: string;
  /** Every usable workflow. */
  readonly items: readonly LibraryItem[];
}

/** Where a draft came from, which decides the revision a save expects. */
export interface DraftOrigin {
  /** Workflow id at the time it was opened; empty for a new workflow. */
  readonly id: string;
  /** Revision it was opened at; null for a new or copied workflow. */
  readonly revision: string | null;
}

/** Counter for browser-only step identities. */
const uidCounter = { next: 0 };

/**
 * Allocate a browser-only step identity.
 *
 * @returns A fresh uid.
 */
function allocateUid(): string {
  uidCounter.next += 1;
  return `step-${String(uidCounter.next)}`;
}

/**
 * Kind choices for a section's menus.
 *
 * @param section - Planning or delivery.
 * @returns Value and readable label pairs.
 */
export function kindOptions(section: SectionName): [string, string][] {
  return sectionKinds(section).map((kind) => [kind, KIND_LABELS[kind] ?? kind]);
}

/**
 * Kinds a section accepts.
 *
 * @param section - Section name.
 * @returns Its closed kind list.
 */
export function sectionKinds(section: SectionName): readonly string[] {
  return section === 'planning' ? PLANNING_KINDS : DELIVERY_KINDS;
}

/**
 * Whether a value is a valid key under the server's rule.
 *
 * @param value - Candidate key.
 * @returns True when the server accepts it as an id.
 */
export function isKey(value: string): boolean {
  return KEY_PATTERN.test(value);
}

/**
 * Pick a key that is not taken, suffixing `-2`, `-3`… within the length bound.
 *
 * @param base - Preferred valid key.
 * @param taken - Keys already in use.
 * @returns First free key.
 */
export function uniqueKey(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) {
    return base;
  }
  for (let index = 2; ; index++) {
    const suffix = `-${String(index)}`;
    const candidate = `${base.slice(0, KEY_MAX - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
}

/**
 * Derive a lowercase key from a title: letters and digits joined by hyphens.
 *
 * @param title - Free text.
 * @param taken - Keys already in use.
 * @param fallback - Key used when the title has no letters or digits.
 * @returns Unique valid key.
 */
export function deriveKey(title: string, taken: ReadonlySet<string>, fallback = 'step'): string {
  const words = title
    .normalize('NFKD')
    // Drop the combining marks NFKD separates from letters, so "É" becomes "e".
    .replaceAll(/\p{M}/gv, '')
    .toLowerCase()
    .split(/[^\da-z]+/v)
    .filter((word) => word !== '');
  // Words are joined by single hyphens, so trimming one trailing hyphen after truncation is enough.
  const slug = words.join('-').slice(0, KEY_MAX).replace(/-$/v, '');
  return uniqueKey(slug === '' ? fallback : slug, taken);
}

/**
 * Read a string array field, dropping anything that is not a string.
 *
 * @param value - Validated record.
 * @param key - Field name.
 * @returns Strings in order.
 */
function strings(value: Data, key: string): string[] {
  const field = value[key];
  return Array.isArray(field) ? field.filter((item): item is string => typeof item === 'string') : [];
}

/**
 * Decode one step from untrusted data.
 *
 * @param value - Step record.
 * @returns Editable step with a fresh uid.
 */
function decodeStep(value: Data): DraftStep {
  return {
    uid: allocateUid(),
    id: text(value, 'id'),
    kind: text(value, 'kind'),
    title: text(value, 'title'),
    roles: strings(value, 'roles'),
    profile: text(value, 'profile'),
    after: strings(value, 'after'),
    inputs: Array.isArray(value['inputs']) ? strings(value, 'inputs') : null,
    blind: hasFlag(value, 'blind'),
    gate: hasFlag(value, 'gate'),
    optional: hasFlag(value, 'optional'),
    provider: text(value, 'provider'),
    instructions: text(value, 'instructions'),
  };
}

/**
 * Decode one workflow definition from untrusted data.
 *
 * @param value - Workflow record.
 * @returns Editable workflow.
 */
export function decodeWorkflow(value: Data): DraftWorkflow {
  return {
    id: text(value, 'id'),
    name: text(value, 'name'),
    description: text(value, 'description'),
    planning: records(value['planning']).map((step) => decodeStep(step)),
    delivery: records(value['delivery']).map((step) => decodeStep(step)),
  };
}

/**
 * Decode `snapshot.factory.workflows`; malformed entries are skipped, never trusted.
 *
 * @param snapshot - Untrusted live snapshot.
 * @returns Library, empty when unavailable.
 */
export function parseLibrary(snapshot: unknown): Library {
  try {
    const library = child(child(data(snapshot), 'factory'), 'workflows');
    const items = records(library['items']).flatMap((item): LibraryItem[] => {
      const id = text(item, 'id');
      if (id === '' || item['workflow'] === null || typeof item['workflow'] !== 'object') {
        return [];
      }
      const { updatedAt } = item;
      return [
        {
          id,
          revision: text(item, 'revision'),
          source: text(item, 'source') === 'project' ? 'project' : 'builtin',
          isDefault: hasFlag(item, 'isDefault'),
          updatedAt: typeof updatedAt === 'number' && Number.isFinite(updatedAt) ? updatedAt : null,
          workflow: decodeWorkflow(data(item['workflow'])),
        },
      ];
    });
    return { defaultId: text(library, 'defaultId'), items };
  } catch {
    return { defaultId: '', items: [] };
  }
}

/**
 * Execution layers, by the server's rule: one more than the deepest step it runs after.
 *
 * @param steps - One section in execution order.
 * @returns One-based layer for each step id.
 */
export function stepLayers(steps: readonly Pick<DraftStep, 'id' | 'after'>[]): Map<string, number> {
  const layers = new Map<string, number>();
  for (const step of steps) {
    layers.set(step.id, 1 + Math.max(0, ...step.after.map((id) => layers.get(id) ?? 0)));
  }
  return layers;
}

/**
 * Group a section's steps by layer, keeping execution order within each layer.
 *
 * @param steps - One section in execution order.
 * @returns Layers from first to last; steps in one layer may run in parallel.
 */
export function layerGroups<T extends Pick<DraftStep, 'id' | 'after'>>(steps: readonly T[]): T[][] {
  const layers = stepLayers(steps);
  const groups: T[][] = [];
  for (const step of steps) {
    const index = (layers.get(step.id) ?? 1) - 1;
    for (let missing = groups.length; missing <= index; missing++) {
      groups.push([]);
    }
    groups[index]?.push(step);
  }
  return groups.filter((group) => group.length > 0);
}

/**
 * Every step reachable backwards through `after` edges (mirrors `ancestorIds`).
 *
 * @param steps - One section.
 * @param id - Starting step.
 * @returns Ancestor ids, excluding the step itself.
 */
export function ancestors(steps: readonly Pick<DraftStep, 'id' | 'after'>[], id: string): Set<string> {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const found = new Set<string>();
  const pending = [...(byId.get(id)?.after ?? [])];
  while (pending.length > 0) {
    const next = pending.pop();
    if (next === undefined || found.has(next)) {
      continue;
    }

    found.add(next);
    pending.push(...(byId.get(next)?.after ?? []));
  }
  return found;
}

/**
 * Which per-step settings a kind supports.
 *
 * @param kind - Step kind.
 * @returns Flags for the roles, blind, gate and optional controls.
 */
export function kindAllows(kind: string): { roles: boolean; blind: boolean; gate: boolean; optional: boolean } {
  return {
    roles: kind !== 'approve',
    blind: kind === 'review',
    gate: !UNGATED_KINDS.has(kind),
    optional: !REQUIRED_KINDS.has(kind),
  };
}
