/**
 * Lightweight browser checks that mirror the most common server workflow
 * rules, so the editor can point at the offending step before a save. The
 * messages match `workflowProblems` in `src/factory/workflow-schema.ts` where
 * a rule is shared; a test keeps them aligned. The server stays authoritative:
 * saves are always attempted and its problems are shown verbatim.
 *
 * @file
 */
import { KIND_LABELS, SECTIONS, ancestors, isKey, kindAllows, sectionKinds } from './workflow-model.js';

import type { DraftOrigin, DraftStep, DraftWorkflow, Library, SectionName } from './workflow-model.js';

/** One problem and where to show it. */
export interface Problem {
  /** Section it belongs to, or null for the workflow fields. */
  readonly section: SectionName | null;
  /** Offending step, or null for a section or workflow problem. */
  readonly uid: string | null;
  /** Plain explanation. */
  readonly message: string;
}

/** The server's stale-revision explanation. */
const STALE_MARKER = 'changed since you opened it';

/**
 * Workflow-level checks: id, name and collisions with the library.
 *
 * @param draft - The workflow being edited.
 * @param library - Workflows already shipped or saved, for id collisions.
 * @param origin - Where the draft came from.
 * @returns Problems without a section.
 */
function workflowFieldProblems(draft: DraftWorkflow, library: Library, origin: DraftOrigin): Problem[] {
  const messages: string[] = [];
  if (!isKey(draft.id)) {
    messages.push(
      'The workflow id must start with a lowercase letter or digit and use only letters, digits, "_" or "-" (64 characters at most).',
    );
  }
  if (draft.name.trim() === '') {
    messages.push('The workflow needs a name.');
  }
  const existing = library.items.find((item) => item.id === draft.id);
  if (existing?.source === 'builtin') {
    messages.push(`"${draft.id}" is a built-in workflow; save a copy under a new id.`);
  } else if (existing !== undefined && draft.id !== origin.id) {
    messages.push(`A project workflow with id "${draft.id}" already exists; choose another id or edit that workflow.`);
  }
  return messages.map((message) => ({ section: null, uid: null, message }));
}

/**
 * Id and title rules for one step (browser-only wording).
 *
 * @param step - The step whose id and title are checked.
 * @returns Explanations of any invalid id or missing title.
 */
function identityProblems(step: DraftStep): string[] {
  const messages: string[] = [];
  if (!isKey(step.id)) {
    messages.push(
      `Step id "${step.id}" must start with a lowercase letter or digit and use only letters, digits, "_" or "-" (64 characters at most).`,
    );
  }
  if (step.title.trim() === '') {
    messages.push(`The ${KIND_LABELS[step.kind] ?? step.kind} step "${step.id}" needs a title.`);
  }
  return messages;
}

/**
 * Field rules for one step (mirrors `stepShapeProblems`).
 *
 * @param step - The step whose seats and flags are checked.
 * @returns Explanations using the server's wording.
 */
function stepFieldProblems(step: DraftStep): string[] {
  const messages = identityProblems(step);
  const allows = kindAllows(step.kind);
  if (step.kind === 'approve' && (step.roles.length > 0 || step.gate || step.blind)) {
    messages.push(`"${step.title}" is a human approval; it has no roles, gate or blind setting.`);
  }
  if (allows.roles && step.roles.length === 0) {
    messages.push(`"${step.title}" needs at least one role.`);
  }
  if (step.blind && !allows.blind) {
    messages.push(`"${step.title}" cannot be blind; only reviews are.`);
  }
  if (step.optional && !allows.optional) {
    messages.push(`"${step.title}" is required and cannot be optional.`);
  }
  if (step.gate && step.kind !== 'approve' && !allows.gate) {
    messages.push(`"${step.title}" cannot be gated; add an approval step before the final check instead.`);
  }
  return messages;
}

/**
 * Ordering and input rules for one step (mirrors `sectionProblems` and `inputProblems`).
 *
 * @param steps - The step's whole section, in order.
 * @param step - The step whose references are checked.
 * @param earlier - Ids of the steps before it.
 * @param section - Planning or delivery, for the wording.
 * @returns Explanations using the server's wording.
 */
function referenceProblems(
  steps: readonly DraftStep[],
  step: DraftStep,
  earlier: ReadonlySet<string>,
  section: SectionName,
): string[] {
  const messages = step.after
    .filter((id) => !earlier.has(id))
    .map((id) => `"${step.title}" must come after "${id}", which is not an earlier ${section} step.`);
  const before = ancestors(steps, step.id);
  const inputs = step.inputs ?? [];
  messages.push(
    ...inputs
      .filter((id) => !before.has(id))
      .map((id) => `"${step.title}" reads "${id}", which does not run before it.`),
  );
  return messages;
}

/**
 * Field, kind, ordering and input rules for every step of one section.
 *
 * @param steps - The section's steps in execution order.
 * @param section - Planning or delivery, which decides the allowed kinds.
 * @returns Explanations, each tied to its step.
 */
function sectionStepProblems(steps: readonly DraftStep[], section: SectionName): Problem[] {
  const problems: Problem[] = [];
  const earlier = new Set<string>();
  const kinds = sectionKinds(section);
  for (const step of steps) {
    const messages = [...stepFieldProblems(step), ...referenceProblems(steps, step, earlier, section)];
    if (!kinds.includes(step.kind)) {
      messages.push(`"${step.title}" uses kind ${step.kind}, which is not allowed in the ${section} section.`);
    }
    problems.push(...messages.map((message) => ({ section, uid: step.uid, message })));
    earlier.add(step.id);
  }
  return problems;
}

/**
 * Steps of one kind.
 *
 * @param steps - One section.
 * @param kind - Kind to select.
 * @returns Matching steps in order.
 */
function ofKind(steps: readonly DraftStep[], kind: string): DraftStep[] {
  return steps.filter((step) => step.kind === kind);
}

/**
 * Implement first, final then verify last, everything joined before final (mirrors `deliveryShapeProblems`).
 *
 * @param steps - Delivery section.
 * @returns Problems, on the offending step where there is one.
 */
function deliveryShapeProblems(steps: readonly DraftStep[]): Problem[] {
  const at = (step: DraftStep | undefined, message: string): Problem => {
    return {
      section: 'delivery',
      uid: step?.uid ?? null,
      message,
    };
  };
  const problems: Problem[] = [];
  const implementations = ofKind(steps, 'implement');
  const [implement] = implementations;
  if (implementations.length !== 1 || steps[0] !== implement || implement?.after.length !== 0) {
    problems.push(at(implement, 'Delivery needs exactly one implement step, and it must be first.'));
  }
  if (ofKind(steps, 'final').length !== 1 || ofKind(steps, 'verify').length !== 1) {
    problems.push(at(undefined, 'Delivery needs exactly one final step and one verify step.'));
  }
  const [final] = ofKind(steps, 'final');
  const last = steps.at(-1);
  if (final === undefined || last?.kind !== 'verify' || !last.after.includes(final.id)) {
    problems.push(
      at(ofKind(steps, 'verify')[0], 'The verify step must be last and come directly after the final step.'),
    );
  }
  return [...problems, ...finalJoinProblems(steps, final)];
}

/**
 * Everything except verification finishes before the final check (mirrors `finalJoinProblems`).
 *
 * @param steps - Delivery steps in execution order.
 * @param final - Its final step, if there is one.
 * @returns Explanations tied to each step that can still run after the final check.
 */
function finalJoinProblems(steps: readonly DraftStep[], final: DraftStep | undefined): Problem[] {
  if (final === undefined) {
    return [];
  }
  const before = ancestors(steps, final.id);
  return steps
    .filter((step) => step !== final && step.kind !== 'verify' && !before.has(step.id))
    .map((step) => {
      return {
        section: 'delivery',
        uid: step.uid,
        message: `"${step.title}" must finish before the final step.`,
      };
    });
}

/**
 * The fixer rules on every review (mirrors `adjudicationProblems`), plus the review rules.
 *
 * @param steps - Delivery section.
 * @returns Explanations, each tied to a section or step.
 */
function reviewProblems(steps: readonly DraftStep[]): Problem[] {
  const [fix] = ofKind(steps, 'adjudicate');
  const before = fix === undefined ? new Set<string>() : ancestors(steps, fix.id);
  const hasUnjudgedReview = fix !== undefined && ofKind(steps, 'review').some((review) => !before.has(review.id));
  const fixProblems: Problem[] = hasUnjudgedReview
    ? [{ section: 'delivery', uid: fix.uid, message: 'The adjudicate step must come after every review.' }]
    : [];
  return [...fixProblems, ...independenceProblems(steps)];
}

/**
 * At least one review, never by the implementer (mirrors `reviewProblems`).
 *
 * @param steps - Delivery steps in execution order.
 * @returns Explanations, each tied to a section or step.
 */
function independenceProblems(steps: readonly DraftStep[]): Problem[] {
  const reviews = ofKind(steps, 'review');
  const [implement] = ofKind(steps, 'implement');
  const problems: Problem[] =
    reviews.length === 0
      ? [{ section: 'delivery', uid: null, message: 'Delivery needs at least one independent review.' }]
      : [];
  for (const review of reviews) {
    if (implement?.roles.some((role) => review.roles.includes(role)) === true) {
      problems.push({
        section: 'delivery',
        uid: review.uid,
        message: `"${review.title}" cannot be performed by the implementer.`,
      });
    }
  }
  return problems;
}

/**
 * Planning, when present, has exactly one plan step.
 *
 * @param steps - Planning section.
 * @returns Explanations, each tied to a section or step.
 */
function planningProblems(steps: readonly DraftStep[]): Problem[] {
  return steps.length > 0 && ofKind(steps, 'plan').length !== 1
    ? [
        {
          section: 'planning',
          uid: null,
          message: 'Planning needs exactly one plan step, which produces the deliveries.',
        },
      ]
    : [];
}

/**
 * Duplicate ids across both sections, reported on each repeat.
 *
 * @param draft - The workflow being edited.
 * @returns Explanations, each tied to a section or step.
 */
function duplicateProblems(draft: DraftWorkflow): Problem[] {
  const seen = new Set<string>();
  const problems: Problem[] = [];
  for (const section of SECTIONS) {
    const steps = draft[section];
    for (const step of steps) {
      if (seen.has(step.id)) {
        problems.push({ section, uid: step.uid, message: `Step id "${step.id}" is used more than once.` });
      }
      seen.add(step.id);
    }
  }
  return problems;
}

/**
 * Every browser-side problem in a draft, with where to show it.
 *
 * @param draft - The workflow being edited.
 * @param library - Workflows already shipped or saved, for id collisions.
 * @param origin - Where the draft came from.
 * @returns Problems; empty when no common rule is broken (the server may still find others).
 */
export function draftProblems(draft: DraftWorkflow, library: Library, origin: DraftOrigin): Problem[] {
  return [
    ...workflowFieldProblems(draft, library, origin),
    ...duplicateProblems(draft),
    ...sectionStepProblems(draft.planning, 'planning'),
    ...sectionStepProblems(draft.delivery, 'delivery'),
    ...planningProblems(draft.planning),
    ...deliveryShapeProblems(draft.delivery),
    ...reviewProblems(draft.delivery),
  ];
}

/**
 * Split a server error that joins every problem into one list item per sentence.
 *
 * @param message - Server error text.
 * @returns Separate problems; a single item when nothing can be split.
 */
export function splitProblems(message: string): string[] {
  return message
    .split(/(?<=[!.?])\s+(?=["A-Z])/v)
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

/**
 * Whether a server error reports that a newer revision was saved first.
 *
 * @param message - Server error text.
 * @returns True for a stale-revision refusal.
 */
export function isStaleRevision(message: string): boolean {
  return message.includes(STALE_MARKER);
}
