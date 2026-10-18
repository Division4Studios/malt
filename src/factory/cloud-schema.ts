/**
 * Cloud developer routing policy. Disabled by default: developer assignments
 * run as local subscription CLI processes unless the operator routes advanced
 * or all deliveries to a configured Codex Cloud environment.
 *
 * @file
 */

import { z } from 'zod/v3';

/** Fastest permitted unpaid cloud status poll. */
const POLL_MIN_MS = 5000;
/** Default unpaid cloud status poll interval. */
const POLL_MS = 30_000;
/** Default cloud task deadline. */
const TIMEOUT_MS = 7_200_000;
/** Longest environment identifier. */
const ENVIRONMENT_MAX = 200;

/** Validated cloud routing policy. */
export const cloudPolicySchema = z
  .object({
    developers: z.enum(['off', 'advanced', 'all']).default('off'),
    executable: z.string().min(1).default('codex'),
    environment: z.string().min(1).max(ENVIRONMENT_MAX).optional(),
    remote: z
      .string()
      .regex(/^[\da-z][\w\-]{0,63}$/v)
      .default('origin'),
    pollMs: z.number().int().min(POLL_MIN_MS).default(POLL_MS),
    timeoutMs: z.number().int().positive().default(TIMEOUT_MS),
  })
  .strict();
