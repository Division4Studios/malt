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
import { phrase, t, translated } from './i18n.js';

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
export const PROVIDERS = ['codex', 'claude', 'copilot'] as const;
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
export const KIND_LABELS: Readonly<Record<string, string>> = translated({
  specify: phrase('Specify'),
  plan: phrase('Plan'),
  plan_review: phrase('Plan review'),
  plan_revise: phrase('Plan revision'),
  approve: phrase('Human approval'),
  implement: phrase('Implement'),
  review: phrase('Review'),
  adjudicate: phrase('Adjudicate and fix'),
  document: phrase('Document'),
  regress: phrase('Regression check'),
  final: phrase('Final check'),
  verify: phrase('Verify main'),
});
/** Seats a newly added step of each kind starts with. */
const DEFAULT_ROLES: Readonly<Record<string, readonly string[]>> = {
  specify: ['product-owner'],
  plan: ['team-lead'],
  plan_review: ['plan-reviewer'],
  plan_revise: ['team-lead'],
  approve: [],
  implement: ['developer-1', 'developer-2'],
  review: ['qa-1'],
  adjudicate: ['fixer'],
  document: ['librarian'],
  regress: ['regression-verifier'],
  final: ['final-tester'],
  verify: ['final-tester'],
};
/** Kinds that cannot be skipped (mirrors `REQUIRED_KINDS`). */
const REQUIRED_KINDS: ReadonlySet<string> = new Set(['plan', 'implement', 'final', 'verify']);
/** Kinds that cannot carry a gate: merges are approved by an approval step instead. */
const UNGATED_KINDS: ReadonlySet<string> = new Set(['final', 'verify', 'approve']);
/** Delivery kinds that stay at the end when steps are added. */
const TAIL_KINDS: ReadonlySet<string> = new Set(['final', 'verify']);
/** Suffix added to copied workflow ids. */
const COPY_SUFFIX = '-copy';

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
 * Replace one id in a reference list.
 *
 * @param ids - `after` or `inputs` references.
 * @param from - Id being replaced.
 * @param to - Its replacement.
 * @returns New list in the same order.
 */
function replaceId(ids: readonly string[], from: string, to: string): string[] {
  return ids.map((id) => (id === from ? to : id));
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

/**
 * Change a step's kind and clear settings the new kind does not support.
 *
 * @param step - Current step.
 * @param kind - New kind.
 * @returns Normalized step.
 */
export function withKind(step: DraftStep, kind: string): DraftStep {
  const allows = kindAllows(kind);
  const previous = DEFAULT_ROLES[step.kind] ?? [];
  // Untouched default seats follow the kind; seats the operator chose are kept.
  const isDefault = step.roles.length === previous.length && step.roles.every((role) => previous.includes(role));
  const kept = !isDefault && allows.roles ? step.roles : [];
  return {
    ...step,
    kind,
    roles: allows.roles && kept.length === 0 ? [...(DEFAULT_ROLES[kind] ?? [])] : kept,
    blind: allows.blind && step.blind,
    gate: allows.gate && step.gate,
    optional: allows.optional && step.optional,
  };
}

/**
 * Every step id in a draft.
 *
 * @param draft - The workflow being edited.
 * @returns Ids across both sections.
 */
export function stepIds(draft: DraftWorkflow): Set<string> {
  return new Set([...draft.planning, ...draft.delivery].map((step) => step.id));
}

/**
 * Replace one section of a draft.
 *
 * @param draft - The workflow being edited.
 * @param section - Section to replace.
 * @param steps - New steps.
 * @returns Updated draft.
 */
function withSection(draft: DraftWorkflow, section: SectionName, steps: readonly DraftStep[]): DraftWorkflow {
  return section === 'planning' ? { ...draft, planning: steps } : { ...draft, delivery: steps };
}

/**
 * Apply a field patch to one step.
 *
 * @param draft - The workflow being edited.
 * @param section - Planning or delivery, where the step lives.
 * @param uid - Step identity.
 * @param patch - Fields to replace; use {@link renameStep} for ids and {@link withKind} for kinds.
 * @returns Updated draft.
 */
export function updateStep(
  draft: DraftWorkflow,
  section: SectionName,
  uid: string,
  patch: Partial<Omit<DraftStep, 'uid' | 'id'>>,
): DraftWorkflow {
  return withSection(
    draft,
    section,
    draft[section].map((step) => (step.uid === uid ? { ...step, ...patch } : step)),
  );
}

/**
 * Rename a step and update every `after` and `inputs` reference in its section.
 *
 * @param draft - The workflow being edited.
 * @param section - Planning or delivery, where the step lives.
 * @param uid - Step identity.
 * @param id - New id.
 * @returns Updated draft.
 */
export function renameStep(draft: DraftWorkflow, section: SectionName, uid: string, id: string): DraftWorkflow {
  const previous = draft[section].find((step) => step.uid === uid)?.id;
  if (previous === undefined || previous === id) {
    return draft;
  }
  const swap = (ids: readonly string[]): string[] => replaceId(ids, previous, id);
  return withSection(
    draft,
    section,
    draft[section].map((step) => {
      return {
        ...step,
        id: step.uid === uid ? id : step.id,
        after: swap(step.after),
        inputs: step.inputs === null ? null : swap(step.inputs),
      };
    }),
  );
}

/**
 * Insert a new step with sensible defaults. In delivery it goes before the
 * trailing final/verify steps, after the step before it, and takes that
 * step's place in the final step's `after`, so the chain stays connected.
 *
 * @param draft - The workflow being edited.
 * @param section - Planning or delivery, where steps are added.
 * @param kind - Kind to add.
 * @returns Updated draft and the new step's uid.
 */
export function addStep(
  draft: DraftWorkflow,
  section: SectionName,
  kind: string,
): { draft: DraftWorkflow; uid: string } {
  const steps = draft[section];
  const tail =
    section === 'delivery' && !TAIL_KINDS.has(kind)
      ? steps.findIndex((candidate) => TAIL_KINDS.has(candidate.kind))
      : -1;
  const position = tail === -1 ? steps.length : tail;
  const previous = steps[position - 1];
  const title = KIND_LABELS[kind] ?? kind;
  const step = withKind(
    {
      uid: allocateUid(),
      id: deriveKey(kind.replaceAll('_', '-'), stepIds(draft)),
      kind,
      title,
      roles: [],
      profile: '',
      after: previous === undefined ? [] : [previous.id],
      inputs: null,
      blind: false,
      gate: false,
      optional: false,
      provider: '',
      instructions: '',
    },
    kind,
  );
  const relinked: DraftStep[] = [];
  for (const [index, existing] of steps.entries()) {
    const shouldRelink = previous !== undefined && index >= position && existing.after.includes(previous.id);
    relinked.push(shouldRelink ? { ...existing, after: replaceId(existing.after, previous.id, step.id) } : existing);
  }
  const next = [...relinked.slice(0, position), step, ...relinked.slice(position)];
  return { draft: withSection(draft, section, next), uid: step.uid };
}

/**
 * Remove a step. Steps that ran after it now run after its own predecessors,
 * so a chain stays connected; it is dropped from explicit inputs.
 *
 * @param draft - The workflow being edited.
 * @param section - Planning or delivery, where the step lives.
 * @param uid - Step identity.
 * @returns Updated draft.
 */
export function removeStep(draft: DraftWorkflow, section: SectionName, uid: string): DraftWorkflow {
  const removed = draft[section].find((step) => step.uid === uid);
  if (removed === undefined) {
    return draft;
  }
  const rest = draft[section].filter((step) => step.uid !== uid);
  return withSection(
    draft,
    section,
    rest.map((step) => {
      if (!step.after.includes(removed.id) && step.inputs?.includes(removed.id) !== true) {
        return step;
      }
      const after = step.after.flatMap((id) => (id === removed.id ? removed.after : id));
      return {
        ...step,
        after: [...new Set(after)],
        inputs: step.inputs === null ? null : step.inputs.filter((id) => id !== removed.id),
      };
    }),
  );
}

/**
 * Move a step one place earlier or later. References are kept; the checks
 * flag any that now point at a later step.
 *
 * @param draft - The workflow being edited.
 * @param section - Planning or delivery, where the step lives.
 * @param uid - Step identity.
 * @param offset - `-1` for earlier, `1` for later.
 * @returns Updated draft, unchanged at either end.
 */
export function moveStep(draft: DraftWorkflow, section: SectionName, uid: string, offset: -1 | 1): DraftWorkflow {
  const steps = [...draft[section]];
  const index = steps.findIndex((step) => step.uid === uid);
  const target = index + offset;
  const moving = steps[index];
  const other = steps[target];
  if (index === -1 || moving === undefined || other === undefined) {
    return draft;
  }
  steps[index] = other;
  steps[target] = moving;
  return withSection(draft, section, steps);
}

/**
 * Copy a step list with fresh browser identities.
 *
 * @param steps - Steps to copy.
 * @returns Equal steps with new uids.
 */
function freshSteps(steps: readonly DraftStep[]): DraftStep[] {
  return steps.map((step) => ({ ...step, uid: allocateUid() }));
}

/**
 * Open a library workflow as a draft; a built-in is copied under a new id and name.
 *
 * @param item - Library entry.
 * @param library - Whole library, for unique ids and names.
 * @returns Draft and the origin its save will expect.
 */
export function draftFrom(item: LibraryItem, library: Library): { draft: DraftWorkflow; origin: DraftOrigin } {
  const base = {
    ...item.workflow,
    planning: freshSteps(item.workflow.planning),
    delivery: freshSteps(item.workflow.delivery),
  };
  return item.source === 'project'
    ? { draft: base, origin: { id: item.id, revision: item.revision } }
    : { draft: { ...base, ...copyNames(item.workflow, library) }, origin: { id: '', revision: null } };
}

/**
 * Suggest a unique id and name for a copy.
 *
 * @param workflow - Workflow being copied.
 * @param library - Existing library.
 * @returns Unused id and name.
 */
export function copyNames(
  workflow: Pick<DraftWorkflow, 'id' | 'name'>,
  library: Library,
): { id: string; name: string } {
  const ids = new Set(library.items.map((item) => item.id));
  const names = new Set(library.items.map((item) => item.workflow.name));
  const stem = workflow.id.slice(0, KEY_MAX - COPY_SUFFIX.length);
  // Shorten the original so the suffix always fits the saved name limit.
  const fit = (suffix: string): string => `${workflow.name.slice(0, TITLE_MAX - suffix.length)}${suffix}`;
  let name = fit(' (copy)');
  let index = 1;
  while (names.has(name)) {
    index += 1;
    name = fit(t(' (copy {index})', { index }));
  }
  return { id: uniqueKey(`${stem}${COPY_SUFFIX}`, ids), name };
}

/**
 * Start a new workflow with the smallest valid delivery: implement, review, final, verify.
 *
 * @param library - Existing library, for a unique id and name.
 * @returns Draft and an origin that expects no existing revision.
 */
export function blankDraft(library: Library): { draft: DraftWorkflow; origin: DraftOrigin } {
  const ids = new Set(library.items.map((item) => item.id));
  let draft: DraftWorkflow = {
    id: uniqueKey('workflow', ids),
    name: t('New workflow'),
    description: '',
    planning: [],
    delivery: [],
  };
  // Tail kinds first, so the review is inserted between implementation and the final check.
  for (const kind of ['implement', 'final', 'verify', 'review']) {
    draft = addStep(draft, 'delivery', kind).draft;
  }
  return { draft, origin: { id: '', revision: null } };
}

/**
 * The wire form of one step: no uid, nulls for empty profile and provider.
 *
 * @param step - Draft step.
 * @returns Plain step definition.
 */
function wireStep(step: DraftStep): Record<string, unknown> {
  return {
    id: step.id,
    kind: step.kind,
    title: step.title,
    roles: [...step.roles],
    profile: step.profile.trim() === '' ? null : step.profile.trim(),
    after: [...step.after],
    inputs: step.inputs === null ? null : [...step.inputs],
    blind: step.blind,
    gate: step.gate,
    optional: step.optional,
    provider: step.provider === '' ? null : step.provider,
    instructions: step.instructions,
  };
}

/**
 * The wire form of a workflow definition.
 *
 * @param draft - The workflow being edited.
 * @returns Plain definition the server validates.
 */
export function wireWorkflow(draft: DraftWorkflow): Record<string, unknown> {
  return {
    version: 1,
    id: draft.id,
    name: draft.name,
    description: draft.description,
    planning: draft.planning.map((step) => wireStep(step)),
    delivery: draft.delivery.map((step) => wireStep(step)),
  };
}

/**
 * The revision a save must expect: the opened revision while the id is unchanged, otherwise none.
 *
 * @param draft - The workflow being edited.
 * @param origin - Where the draft came from.
 * @returns Revision digest, or null for a new workflow.
 */
export function expectedRevision(draft: DraftWorkflow, origin: DraftOrigin): string | null {
  return draft.id === origin.id ? origin.revision : null;
}

/**
 * Input of `factory_workflow_save`.
 *
 * @param draft - The workflow being edited.
 * @param origin - Where the draft came from.
 * @returns Request body.
 */
export function saveRequest(
  draft: DraftWorkflow,
  origin: DraftOrigin,
): { workflow: Record<string, unknown>; expectedRevision: string | null } {
  return { workflow: wireWorkflow(draft), expectedRevision: expectedRevision(draft, origin) };
}

/**
 * Input of `factory_workflow_default`.
 *
 * @param workflowId - Workflow to make the default.
 * @returns Request body.
 */
export function defaultRequest(workflowId: string): { workflowId: string } {
  return { workflowId };
}

/**
 * Whether two drafts define the same workflow, ignoring browser identities.
 *
 * @param left - First draft.
 * @param right - Second draft.
 * @returns True when their wire forms are equal.
 */
export function isSameDefinition(left: DraftWorkflow, right: DraftWorkflow): boolean {
  return JSON.stringify(wireWorkflow(left)) === JSON.stringify(wireWorkflow(right));
}
