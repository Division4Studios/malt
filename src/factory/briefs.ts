/**
 * Turn an operator brief into one atomic delivery for workflows without
 * planning. A brief may follow the recommended Markdown shape (title line,
 * then sections such as Goal, Changes, Out of scope, Constraints and
 * Acceptance); bullet items under "Acceptance" become acceptance criteria.
 * Free text is accepted too, with a conservative default criterion.
 *
 * @file
 */

import type { AgentResult } from './schema.ts';

/** Public title bound used by delivery tickets. */
const TITLE_MAX = 200;
/** A numbered list marker such as "1." or "2)" followed by a space. */
const NUMBERED = /^\d+[\).]\s/v;
/** Task-list boxes that may follow a list marker. */
const TASK_BOXES = ['[ ] ', '[x] ', '[X] '];
/** Used when a free-text brief names no acceptance criteria. */
const DEFAULT_CRITERION = 'The delivered change does what the brief describes, and the project checks pass.';

/**
 * The text of a Markdown heading line.
 *
 * @param line - One brief line.
 * @returns Heading text without markers, or `undefined` for other lines.
 */
function headingText(line: string): string | undefined {
  const trimmed = line.trim();
  return trimmed.startsWith('#') ? trimmed.replaceAll('#', ' ').trim() : undefined;
}

/**
 * The text of a bullet or numbered list item, without a task-list box.
 *
 * @param line - One brief line.
 * @returns Item text, or `undefined` for other lines.
 */
function itemText(line: string): string | undefined {
  const trimmed = line.trim();
  const marker =
    NUMBERED.exec(trimmed)?.[0] ?? (['- ', '* ', '+ '].some((prefix) => trimmed.startsWith(prefix)) ? '- ' : '');
  if (marker.length === 0) {
    return undefined;
  }
  const text = trimmed.slice(marker.length).trim();
  const box = TASK_BOXES.find((prefix) => text.startsWith(prefix));
  return box === undefined ? text : text.slice(box.length).trim();
}

/**
 * Bullet items under the brief's Acceptance heading.
 *
 * @param lines - Lines of the operator brief, in order.
 * @returns Criteria in order; empty when the brief has no such section.
 */
function acceptanceItems(lines: readonly string[]): string[] {
  const items: string[] = [];
  let isInside = false;
  for (const line of lines) {
    const heading = headingText(line);
    if (heading !== undefined) {
      isInside = /^acceptance\b/iv.test(heading);
      continue;
    }
    const item = itemText(line);
    if (isInside && item !== undefined && item.length > 0) {
      items.push(item);
    }
  }
  return items;
}

/**
 * The delivery title: the first non-empty line without heading markers.
 *
 * @param lines - Lines of the operator brief, in order.
 * @returns Bounded single-line title.
 */
function briefTitle(lines: readonly string[]): string {
  const first = lines.find((line) => line.trim().length > 0) ?? 'Delivery';
  const text = headingText(first) ?? first.trim();
  return text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX - 1)}…` : text;
}

/**
 * A complete one-delivery plan built from the brief, as if a lead had planned it.
 *
 * @param objective - Operator brief.
 * @returns Successful plan result with exactly one delivery.
 */
export function briefPlan(objective: string): AgentResult {
  const lines = objective.split(/\r?\n/v);
  const criteria = acceptanceItems(lines);
  return {
    outcome: 'success',
    summary: 'This workflow has no planning steps, so the brief is the single delivery.',
    findings: [],
    deliveries: [
      {
        key: 'brief',
        title: briefTitle(lines),
        description: objective,
        acceptanceCriteria: criteria.length > 0 ? criteria : [DEFAULT_CRITERION],
        dependencies: [],
        capabilityTier: null,
        assignmentProfiles: undefined,
        skills: [],
      },
    ],
    skillActions: [],
    instructionReceipts: [],
  };
}
