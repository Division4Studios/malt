/**
 * Wire and proof contracts for unpaid operator reconciliation with GitHub.
 *
 * @file
 */
import { z } from 'zod/v3';

/** Proof identity for an operator-adopted delivery that ran no factory job. */
export const OPERATOR_ADOPTED = 'operator-adopted';
/** Bound one applied reconciliation batch below the broker's operation timeout. */
const RECONCILE_BATCH_MAX = 100;
/** Default applied reconciliation batch. */
const RECONCILE_BATCH_DEFAULT = 20;

/** A merged-main proof comes from a factory job or an explicit operator adoption. */
export const proofJobIdSchema = z.union([z.string().uuid(), z.literal(OPERATOR_ADOPTED)]);

/** Dry-run by default; apply writes at most one bounded batch. */
export const reconcileGitHubSchema = z
  .object({
    apply: z.boolean().default(false),
    limit: z.number().int().positive().max(RECONCILE_BATCH_MAX).default(RECONCILE_BATCH_DEFAULT),
  })
  .strict();
