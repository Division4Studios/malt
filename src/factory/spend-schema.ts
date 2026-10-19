/**
 * Shapes for USD spend caps: a project cap over a rolling window, default
 * caps for every objective and delivery with per-scope overrides, and the
 * policy for attempts whose cost is unknown. Caps are operator data fenced
 * by revision, like the price table.
 *
 * @file
 */
import { z } from 'zod/v3';

/** Largest accepted cap in USD. */
const CAP_MAX = 1_000_000;
/** Most per-objective or per-delivery overrides. */
const OVERRIDES_MAX = 500;
/** Longest project window in days. */
const WINDOW_MAX_DAYS = 90;
/** Default project window in days. */
const DEFAULT_WINDOW_DAYS = 30;

/** A cap in USD, or `null` for no cap. */
const capSchema = z.number().finite().positive().max(CAP_MAX).nullable();
/** Per-scope overrides; `null` lifts the default for that scope. */
const overridesSchema = z
  .record(z.string().uuid(), capSchema)
  .refine((overrides) => Object.keys(overrides).length <= OVERRIDES_MAX, {
    message: `At most ${String(OVERRIDES_MAX)} overrides.`,
  });

/** Complete cap settings. */
export const spendCapsSchema = z
  .object({
    /** Project cap over the rolling window. */
    project: capSchema.default(null),
    /** Rolling window for the project cap, in days. */
    windowDays: z.number().int().min(1).max(WINDOW_MAX_DAYS).default(DEFAULT_WINDOW_DAYS),
    /** Cap applied to every objective without an override. */
    objectiveDefault: capSchema.default(null),
    /** Cap applied to every delivery without an override. */
    deliveryDefault: capSchema.default(null),
    /** Objective overrides by id. */
    objectives: overridesSchema.default({}),
    /** Delivery overrides by id. */
    deliveries: overridesSchema.default({}),

    /**
     * Unpriced attempts in a capped scope: `ignore` leaves them to token caps,
     * `block` stops new attempts until their model is priced.
     */
    unpriced: z.enum(['ignore', 'block']).default('ignore'),
  })
  .strict();
/** Cap settings. */
export type SpendCaps = z.output<typeof spendCapsSchema>;

/** Revision-fenced replacement of the caps (`factory_spend_caps`). */
export const spendCapsInputSchema = z
  .object({ caps: spendCapsSchema, expectedRevision: z.number().int().nonnegative().safe() })
  .strict();

/** Which scope a cap applies to. */
export const spendScopeSchema = z.enum(['project', 'objective', 'delivery']);
/** A scope kind. */
export type SpendScope = z.output<typeof spendScopeSchema>;

/** Spend against one capped scope. */
export const spendUsageSchema = z
  .object({
    scope: spendScopeSchema,
    /** Objective or delivery id; empty for the project. */
    id: z.string(),
    label: z.string(),
    usd: z.number().nonnegative(),
    unpricedAttempts: z.number().int().nonnegative(),
    cap: z.number().positive().nullable(),
    /** Why new attempts are stopped, or `null` while within the cap. */
    blocked: z.enum(['cap', 'unpriced']).nullable(),
  })
  .strict();
/** Spend against one scope. */
export type SpendUsage = z.output<typeof spendUsageSchema>;

/** An open objective or delivery without a cap of its own, which the operator can cap. */
export const spendChoiceSchema = z
  .object({ scope: z.enum(['objective', 'delivery']), id: z.string(), label: z.string() })
  .strict();

/** Caps and current spend, carried in the cost summary. */
export const spendStatusSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    caps: spendCapsSchema,
    /** The project and every open objective or delivery that has a cap. */
    usage: z.array(spendUsageSchema),
    /** Open objectives and deliveries that have no cap yet, including ones that have not run. */
    choices: z.array(spendChoiceSchema),
  })
  .strict();
/** An uncapped open scope. */
export type SpendChoice = z.output<typeof spendChoiceSchema>;
/** Caps and current spend. */
export type SpendStatus = z.output<typeof spendStatusSchema>;

/** Spend operations merged into the factory operation table. */
export const spendSchemas = { factory_spend_caps: spendCapsInputSchema };
/** Spend operation names. */
export const SPEND_OPERATIONS = ['factory_spend_caps'] as const;
