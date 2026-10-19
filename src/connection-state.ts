/**
 * The verification state a connection section records. This leaf module is
 * shared by the connection record schema and the verifier without a cycle.
 *
 * @file
 */
import { z } from 'zod/v3';

/** Most step errors kept on one section. */
export const ERRORS_KEPT = 10;

/** Verification states of one section. */
export const VERIFICATION_STATES = ['saved', 'verified', 'degraded', 'failed', 'external'] as const;
/** One section's verification state. */
export type VerificationState = (typeof VERIFICATION_STATES)[number];

/** One step's failure. */
const stepErrorSchema = z.object({ step: z.string(), message: z.string() }).strict();

/** The latest verification of one section. */
export const verificationSchema = z
  .object({
    state: z.enum(VERIFICATION_STATES),
    checkedAt: z.string().datetime().nullable(),
    errors: z.array(stepErrorSchema).max(ERRORS_KEPT).default([]),
  })
  .strict();
/** A section's recorded verification. */
export type Verification = z.output<typeof verificationSchema>;
