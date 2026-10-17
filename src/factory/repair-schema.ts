/**
 * Shapes for bounded repair rounds. When a delivery's pull request fails CI,
 * or refreshing it onto current main conflicts, the unpaid supervisor records
 * one repair round and returns the delivery to its code owner with that
 * evidence, instead of leaving it blocked. Each round has a stable key, so
 * the same failure on the same source never starts a second round, and each
 * kind has its own per-delivery cap.
 *
 * @file
 */
import { z } from 'zod/v3';

/** Default CI repair rounds per delivery before the operator decides. */
export const DEFAULT_CI_REPAIRS = 2;
/** Default conflict repair rounds per delivery before the operator decides. */
export const DEFAULT_CONFLICT_REPAIRS = 2;
/** Upper bound on either cap, so a misconfiguration cannot loop for long. */
const MAX_REPAIRS = 10;
/** Most names or files recorded on one round. */
const MAX_ITEMS = 50;
/** Longest recorded finding, after redaction and excerpting. */
export const REPAIR_FINDING_MAX = 6000;
/** Most findings recorded on one round. */
export const MAX_FINDINGS = 10;
/** Longest recorded check name. */
const CHECK_NAME_MAX = 200;
/** Longest recorded conflicted path. */
export const PATH_MAX = 1000;
/** Longest recorded round summary. */
export const SUMMARY_MAX = 1000;

/** Per-project repair caps; projects saved before repairs existed get the defaults. */
export const repairPolicySchema = z
  .object({
    maxCiRepairs: z.number().int().nonnegative().max(MAX_REPAIRS).default(DEFAULT_CI_REPAIRS),
    maxConflictRepairs: z.number().int().nonnegative().max(MAX_REPAIRS).default(DEFAULT_CONFLICT_REPAIRS),
  })
  .strict();

/** One recorded repair round. */
export const repairRoundSchema = z.object({
  /** What failed: required CI checks, or a merge with current main. */
  kind: z.enum(['ci', 'conflict']),
  /** Idempotency key: the kind, the failing source and the failure's identity. */
  key: z
    .string()
    .min(1)
    .max(MAX_ITEMS * CHECK_NAME_MAX),
  /** Source that failed. */
  head: z.string(),
  /** Main it was measured against. */
  base: z.string(),
  /** When the round was recorded. */
  at: z.number(),
  /** Failed check names, for CI rounds. */
  checks: z.array(z.string().max(CHECK_NAME_MAX)).max(MAX_ITEMS).default([]),
  /** Conflicted paths, for conflict rounds. */
  files: z.array(z.string().max(PATH_MAX)).max(MAX_ITEMS).default([]),
  /** Redacted, bounded evidence the code owner receives. */
  findings: z.array(z.string().max(REPAIR_FINDING_MAX)).max(MAX_FINDINGS).default([]),
  /** One-line description for the console and the public comment. */
  summary: z.string().max(SUMMARY_MAX),
});
/** A recorded repair round. */
export type RepairRound = z.output<typeof repairRoundSchema>;

/**
 * Developer attempts a delivery may use: the project's limit plus one per repair round.
 *
 * @param task - Delivery and its recorded repair rounds.
 * @param config - Project policy with the base attempt limit.
 * @returns Developer attempts allowed before the delivery stops.
 */
export function attemptBudget(
  task: { readonly repairs: readonly unknown[] },
  config: { readonly maxAttempts: number },
): number {
  return config.maxAttempts + task.repairs.length;
}

/**
 * Bound a list of names or paths for a round.
 *
 * @param items - Names or paths.
 * @param length - Longest recorded item.
 * @returns At most the recorded number, each within the recorded length.
 */
export function boundedItems(items: readonly string[], length = CHECK_NAME_MAX): string[] {
  return items.slice(0, MAX_ITEMS).map((item) => item.slice(0, length));
}
