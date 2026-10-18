/**
 * Request and ledger shapes for operator delivery controls: holding a
 * delivery so no new attempt starts on it, and archiving finished deliveries
 * off the board. A request names several deliveries, one objective, or every
 * delivery, so a bulk action is the same request as a single one.
 *
 * @file
 */
import { z } from 'zod/v3';

/** Most deliveries one request may name. */
const MAX_TARGETS = 200;
/** Longest operator hold reason. */
const REASON_MAX = 500;

/** Which deliveries a control applies to; exactly one selector is required. */
const targetShape = {
  taskIds: z.array(z.string().uuid()).min(1).max(MAX_TARGETS).optional(),
  featureId: z.string().uuid().optional(),
  all: z.literal(true).optional(),
};

/** Hold deliveries, or resume them with `hold: false`. */
export const holdRequestSchema = z
  .object({ ...targetShape, hold: z.boolean(), reason: z.string().trim().max(REASON_MAX).default('') })
  .strict();
/** A parsed hold request. */
export type HoldRequest = z.output<typeof holdRequestSchema>;

/** Archive finished deliveries, or bring them back to the board with `archive: false`. */
export const archiveRequestSchema = z.object({ ...targetShape, archive: z.boolean() }).strict();
/** A parsed archive request. */
export type ArchiveRequest = z.output<typeof archiveRequestSchema>;

/** Operator hold recorded on a delivery. */
export const holdSchema = z.object({ at: z.number(), reason: z.string() });

/**
 * Operator archive choice recorded on a delivery. `kept` overrides the
 * automatic archive of finished deliveries; no mark means the default applies.
 */
export const archiveMarkSchema = z.object({ state: z.enum(['archived', 'kept']), at: z.number() });

/** Delivery control operations merged into the factory operation table. */
export const deliveryControlSchemas = {
  factory_hold: holdRequestSchema,
  factory_archive: archiveRequestSchema,
};
/** Delivery control operation names, in the same order as {@link deliveryControlSchemas}. */
export const DELIVERY_CONTROL_OPERATIONS = ['factory_hold', 'factory_archive'] as const;
