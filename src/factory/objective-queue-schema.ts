/**
 * Wire-only objective queue contracts shared by MCP and the operator gateway.
 *
 * @file
 */
import { z } from 'zod';

/** Bound the queue control to the existing request-body ceiling. */
export const MAX_OBJECTIVES = 5000;
/** Persisted order is independent of mutable delivery progress. */
export const objectiveQueueSchema = z
  .object({
    existingOnly: z.boolean().default(false),
    revision: z.number().int().nonnegative(),
    order: z.array(z.string().uuid()).max(MAX_OBJECTIVES),
    focusedFeatureId: z.string().uuid().nullable(),
  })
  .strict();
/** Complete replacement with optimistic concurrency, never a client-side claim. */
export const queueControlSchema = objectiveQueueSchema
  .extend({ expectedRevision: z.number().int().nonnegative(), existingOnly: z.boolean().optional() })
  .omit({ revision: true })
  .strict();
/** Durable queue snapshot. */
export type ObjectiveQueueState = z.output<typeof objectiveQueueSchema>;

/**
 * Clearance admits retained deliveries independently of the campaign's focus.
 *
 * @param queue - Current operator queue.
 * @returns Effective delivery-only objective filter.
 */
export function deliveryFocus(queue?: { focusedFeatureId: string | null; existingOnly?: boolean }): string | null {
  return queue?.existingOnly === true ? null : (queue?.focusedFeatureId ?? null);
}
