/**
 * Brief revalidation as data. When a project enables it, a delivery whose
 * dependencies merged after it was planned is rechecked by the team lead
 * before implementation starts: does its brief still hold against what its
 * predecessors actually merged? The verdict is recorded once per set of
 * predecessor merges, bound to the exact source the lead read.
 *
 * @file
 */

import { z } from 'zod/v3';

/** Bound one recorded summary or finding. */
export const REVALIDATION_TEXT_MAX = 4000;
/** Bound findings kept per verdict. */
const MAX_FINDINGS = 20;
/** Bound predecessors recorded per verdict; plans allow at most 100 deliveries. */
const MAX_PREDECESSORS = 100;
/** Bound a commit identity. */
const COMMIT_MAX = 64;

/** One predecessor as the lead judged it. */
export const predecessorSchema = z
  .object({
    taskId: z.string().uuid(),
    issue: z.number().int().positive(),
    /** Merge commit on main, when recorded. */
    merge: z.string().min(1).max(COMMIT_MAX).nullable(),
  })
  .strict();
/** One recorded predecessor. */
export type Predecessor = z.output<typeof predecessorSchema>;

/** The lead's verdict on a dependent delivery's brief. */
export const revalidationSchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    jobId: z.string().uuid(),
    /** Exact main the lead read. */
    source: z.string().min(1).max(COMMIT_MAX).nullable(),
    /** Source the objective's plan was made against, when recorded. */
    plannedAgainst: z.string().min(1).max(COMMIT_MAX).nullable(),
    predecessors: z.array(predecessorSchema).max(MAX_PREDECESSORS),
    /** `confirmed` lets implementation start; `revise` stops the delivery for the operator. */
    outcome: z.enum(['confirmed', 'revise']),
    summary: z.string().max(REVALIDATION_TEXT_MAX),
    findings: z.array(z.string().max(REVALIDATION_TEXT_MAX)).max(MAX_FINDINGS),
    at: z.number(),
  })
  .strict();
/** One recorded verdict. */
export type Revalidation = z.output<typeof revalidationSchema>;
