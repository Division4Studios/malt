/** @file Durable remote-effect shape, independent of planning and process schemas. */
import { z } from 'zod/v3';

/** Durable, retryable remote effects. */
export const effectSchema = z.object({
  id: z.string(),
  kind: z.enum(['status', 'comment', 'close', 'close_not_planned', 'close_pr']),
  issue: z.number().int().positive(),
  value: z.string(),
  attempts: z.number().int().nonnegative(),
  retryAt: z.number(),
  error: z.string().nullable(),
});
/** One outbox entry. */
export type FactoryEffect = z.output<typeof effectSchema>;
