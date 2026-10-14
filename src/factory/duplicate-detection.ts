/**
 * Deterministic, evidence-backed duplicate versus related classification. Pure: no persistence, network
 * or queueing. Free text is reduced to normalized word tokens, so hostile markup or instructions in an
 * issue can never reach the output structure.
 *
 * @file
 */

/** Longest token list considered per field, bounding work on hostile input. */
const MAX_TOKENS = 2000;
/** Shortest word that carries meaning. */
const MIN_WORD = 3;
/** Shared tokens quoted per evidence item. */
const MAX_SHARED = 8;
/** Longest identity string echoed back. */
const MAX_IDENTITY = 80;
/** Full agreement, in thousandths. */
const FULL = 1000;
/** Thousandths of overlap that count as strong agreement on a behavior dimension. */
const STRONG = 600;
/** Thousandths of overlap that count as some agreement. */
const WEAK = 250;
/** Thousandths below which two filled-in behavior dimensions contradict each other. */
const CONTRARY = 150;
/** Candidates whose scores lie this close (thousandths) to the best are comparably strong. */
const TIE_MARGIN = 100;

const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'not', 'has', 'have']);

/** Comparable text of one ticket-like record. */
export interface DetectionRecord {
  /** Display title; never used as evidence. */
  title: string;
  /** Described behavior. */
  body: string;
  /** Acceptance criteria. */
  acceptance: readonly string[];
  /** Reproduction steps, if any. */
  reproduction?: string | undefined;
  /** Affected components. */
  components: readonly string[];
  /** Issue numbers this record depends on. */
  dependencies: readonly number[];
}

/** Snapshot of one remote issue. */
export interface IssueSnapshot extends DetectionRecord {
  /** Issue number. */
  number: number;
  /** Lifecycle state. */
  state: 'open' | 'closed';
}

/** Snapshot of one local objective, optionally tied to issues. */
export interface ObjectiveSnapshot extends DetectionRecord {
  /** Objective identity. */
  id: string;
  /** Issues provisioned for it. */
  issues: readonly number[];
}

/** Remote operation recorded in the journal. */
export interface OperationSnapshot {
  /** Stable operation identity. */
  identity: string;
  /** Whether the operation already finished. */
  resolved: boolean;
  /** Issue it targets, if known. */
  issue?: number | undefined;
}

/** Incoming request, optionally carrying the identity of an interrupted operation. */
export interface DetectionRequest extends DetectionRecord {
  /** Identity of an interrupted operation this request resumes. */
  operationIdentity?: string | undefined;
}

/** Compared aspect of a ticket. */
export type EvidenceDimension = 'behavior' | 'acceptance' | 'reproduction' | 'components' | 'dependencies';

/** One concrete overlap (or contradiction) built only from normalized tokens and numbers. */
export interface EvidenceItem {
  /** Compared aspect. */
  dimension: EvidenceDimension;
  /** Overlap in thousandths. */
  overlap: number;
  /** Sorted shared tokens, or shared dependency numbers. */
  shared: string[];
}

/** One classified candidate. */
export interface DetectionMatch {
  /** Duplicate needs strong behavioral evidence and no contradiction. */
  classification: 'duplicate' | 'related';
  /** Issue numbers involved, ascending. */
  issues: number[];
  /** Objective identities involved. */
  objectives: string[];
  /** Overall score in thousandths. */
  score: number;
  /** Supporting evidence. */
  evidence: EvidenceItem[];
  /** Behavior dimensions that contradict the match. */
  contrary: EvidenceItem[];
}

/** Whole classification outcome. */
export interface DetectionResult {
  /** Stable-ordered matches. */
  matches: DetectionMatch[];
  /** True when several open duplicates are comparably strong. */
  ambiguous: boolean;
  /** The single existing open issue to keep, only when one duplicate clearly leads. */
  survivor: number | null;
  /** Unresolved operations with the request identity: reuse them instead of recommending. */
  reuse: { identity: string; issue: number | null }[];
}

/** Evidence gathered for one candidate. */
interface Evaluation {
  /** Supporting items. */
  evidence: EvidenceItem[];
  /** Contradicting items. */
  contrary: EvidenceItem[];
  /** Dimensions in strong agreement. */
  strong: number;
  /** Mean overlap in thousandths. */
  score: number;
}

/**
 * Reduce free text to a bounded set of lowercase word tokens.
 *
 * @param text - Untrusted text.
 * @returns Distinct tokens.
 */
function tokens(text: string): Set<string> {
  const found = new Set<string>();
  for (const word of text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/v)
    .slice(0, MAX_TOKENS)) {
    if (word.length >= MIN_WORD && !STOPWORDS.has(word)) {
      found.add(word);
    }
  }
  return found;
}

/**
 * Compare two token sets.
 *
 * @param a - First set.
 * @param b - Second set.
 * @returns Overlap in thousandths and the sorted shared tokens, or null when either side is empty.
 */
function compare(a: Set<string>, b: Set<string>): { overlap: number; shared: string[] } | null {
  if (a.size === 0 || b.size === 0) {
    return null;
  }
  const shared = [...a].filter((token) => b.has(token)).toSorted(ordinal);
  const union = a.size + b.size - shared.length;
  return { overlap: Math.round((shared.length * FULL) / union), shared: shared.slice(0, MAX_SHARED) };
}

/**
 * Bound an echoed identity to inert characters.
 *
 * @param value - Untrusted identity.
 * @returns Bounded word-character string.
 */
function inertIdentity(value: string): string {
  return value.replaceAll(/[^\w\-.:]/gv, '_').slice(0, MAX_IDENTITY);
}

/**
 * Score one candidate against the request on every dimension.
 *
 * @param request - Incoming request.
 * @param candidate - Existing ticket-like record.
 * @returns Supporting and contrary evidence, strong dimension count and an overall score.
 */
function evaluate(request: DetectionRecord, candidate: DetectionRecord): Evaluation {
  const evidence: EvidenceItem[] = [];
  const contrary: EvidenceItem[] = [];
  let strong = 0;
  let total = 0;
  let counted = 0;
  const textual: [EvidenceDimension, string, string][] = [
    ['behavior', request.body, candidate.body],
    ['acceptance', request.acceptance.join('\n'), candidate.acceptance.join('\n')],
    ['reproduction', request.reproduction ?? '', candidate.reproduction ?? ''],
  ];
  for (const [dimension, left, right] of textual) {
    const result = compare(tokens(left), tokens(right));
    if (result === null) {
      continue;
    }
    counted += 1;
    total += result.overlap;
    const item: EvidenceItem = { dimension, overlap: result.overlap, shared: result.shared };
    if (result.overlap >= WEAK) {
      evidence.push(item);
    }
    if (result.overlap >= STRONG) {
      strong += 1;
    }
    if (result.overlap < CONTRARY) {
      contrary.push(item);
    }
  }
  const components = compare(tokens(request.components.join(' ')), tokens(candidate.components.join(' ')));
  if (components !== null && components.shared.length > 0) {
    evidence.push({ dimension: 'components', overlap: components.overlap, shared: components.shared });
  }
  const mine = new Set(request.dependencies);
  const common = [...new Set(candidate.dependencies)].filter((number) => mine.has(number)).toSorted((x, y) => x - y);
  if (common.length > 0) {
    evidence.push({ dimension: 'dependencies', overlap: FULL, shared: common.map(String).slice(0, MAX_SHARED) });
  }
  return { evidence, contrary, strong, score: counted === 0 ? 0 : Math.round(total / counted) };
}

/**
 * Order matches: duplicates first, then by score, then by identity.
 *
 * @param a - First match.
 * @param b - Second match.
 * @returns Sort order.
 */
function byRank(a: DetectionMatch, b: DetectionMatch): number {
  if (a.classification !== b.classification) {
    return a.classification === 'duplicate' ? -1 : 1;
  }
  if (a.score !== b.score) {
    return b.score - a.score;
  }
  const issues = ordinal(a.issues.join(','), b.issues.join(','));
  return issues === 0 ? ordinal(a.objectives.join(','), b.objectives.join(',')) : issues;
}

/**
 * Compare stable string keys by UTF-16 ordinal value, independent of host locale.
 *
 * @param left - First key.
 * @param right - Second key.
 * @returns Stable ordering.
 */
function ordinal(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

/**
 * Classify the request against existing issues and objectives. Title similarity is never evidence.
 *
 * @param input - Request plus issue, objective and remote operation snapshots.
 * @returns Stable-ordered matches, ambiguity, survivor and reusable operations.
 */
export function detectDuplicates(input: {
  request: DetectionRequest;
  issues: readonly IssueSnapshot[];
  objectives: readonly ObjectiveSnapshot[];
  operations: readonly OperationSnapshot[];
}): DetectionResult {
  const identity = input.request.operationIdentity;
  const reused =
    identity === undefined
      ? []
      : input.operations.filter((operation) => !operation.resolved && operation.identity === identity);
  const reuse = reused
    .map((operation) => ({ identity: inertIdentity(operation.identity), issue: operation.issue ?? null }))
    .toSorted((a, b) => (a.issue ?? 0) - (b.issue ?? 0));
  if (reuse.length > 0) {
    return { matches: [], ambiguous: false, survivor: null, reuse };
  }

  const matches: DetectionMatch[] = [];
  const issueNumbers = new Set(input.issues.map((issue) => issue.number));
  for (const issue of input.issues) {
    const result = evaluate(input.request, issue);
    if (result.evidence.length === 0) {
      continue;
    }
    // Closed tickets are references only; contradicting behavior keeps a candidate merely related.
    const isDuplicate = issue.state === 'open' && result.strong > 0 && result.contrary.length === 0;
    matches.push({
      classification: isDuplicate ? 'duplicate' : 'related',
      issues: [issue.number],
      objectives: [],
      score: result.score,
      evidence: result.evidence,
      contrary: result.contrary,
    });
  }
  for (const objective of input.objectives) {
    const result = evaluate(input.request, objective);
    if (result.evidence.length === 0) {
      continue;
    }
    matches.push({
      classification: 'related',
      issues: [...new Set(objective.issues)].filter((number) => issueNumbers.has(number)).toSorted((a, b) => a - b),
      objectives: [inertIdentity(objective.id)],
      score: result.score,
      evidence: result.evidence,
      contrary: result.contrary,
    });
  }
  const ranked = matches.toSorted(byRank);

  const duplicates = ranked.filter((match) => match.classification === 'duplicate');
  const best = duplicates[0];
  const isAmbiguous =
    best !== undefined && duplicates.some((match) => match !== best && best.score - match.score <= TIE_MARGIN);
  return {
    matches: ranked,
    ambiguous: isAmbiguous,
    survivor: best === undefined || isAmbiguous ? null : (best.issues[0] ?? null),
    reuse,
  };
}
