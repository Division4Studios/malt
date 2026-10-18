/**
 * Lesson text and identity for supervisor-recorded rework: the cause's first
 * line for summaries, and a normalized key so the same cause reported against
 * a new head or attempt is one lesson.
 *
 * @file
 */

/** Longest cause excerpt used in a lesson's summary and prevention. */
const CAUSE_EXCERPT = 200;

/**
 * The first line of a finding, bounded, for lesson text.
 *
 * @param finding - Reviewed finding.
 * @returns Its first non-empty line, at most the excerpt length.
 */
export function causeLine(finding: string): string {
  const line = finding.split('\n').find((candidate) => candidate.trim() !== '') ?? finding;
  return line.trim().slice(0, CAUSE_EXCERPT);
}

/**
 * Normalize a finding so the same cause reported against a new head or attempt maps to one lesson.
 *
 * @param finding - Reviewed finding.
 * @returns Lowercased text without commit ids, numbers or extra whitespace.
 */
export function causeKey(finding: string): string {
  return finding
    .toLowerCase()
    .replaceAll(/\b[\da-f]{7,40}\b/gv, '')
    .replaceAll(/\d+/gv, '')
    .replaceAll(/\s+/gv, ' ')
    .trim();
}
