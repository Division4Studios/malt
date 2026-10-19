/**
 * Per-objective and per-delivery step overrides as data. An operator may skip
 * a workflow's optional steps, or change who performs a step: its seats, its
 * organization profile or its preferred provider family. Overrides live beside
 * the frozen workflow copy, like gates, so the copy's revision still names
 * exactly what was frozen. An objective's overrides are copied onto each of
 * its deliveries when they are provisioned.
 *
 * @file
 */

import { z } from 'zod/v3';

import { FACTORY_ROLES, PROVIDERS, keySchema } from './seats.ts';

/** Seats that may take one step, as in workflow definitions. */
const MAX_STEP_ROLES = 4;
/** One override per step; workflows have at most this many steps in all. */
const MAX_OVERRIDES = 36;

/** One step's override; omitted fields keep the workflow's value. */
export const stepOverrideSchema = z
  .object({
    stepId: keySchema,
    /** Skip an optional step for this objective or delivery. */
    skip: z.boolean().optional(),
    /** Seats that perform the step instead of the workflow's. */
    roles: z.array(z.enum(FACTORY_ROLES)).min(1).max(MAX_STEP_ROLES).optional(),
    /** Organization profile instead of the step's; `null` uses the seat's own type. */
    profile: keySchema.nullable().optional(),
    /** Preferred provider family instead of the step's; `null` uses normal routing. */
    provider: z.enum(PROVIDERS).nullable().optional(),
  })
  .strict();
/** One validated override. */
export type StepOverride = z.output<typeof stepOverrideSchema>;
/** A bounded override list naming each step at most once. */
export const stepOverridesSchema = z
  .array(stepOverrideSchema)
  .max(MAX_OVERRIDES)
  .refine((overrides) => {
    const ids = new Set(overrides.map((override) => override.stepId));
    return ids.size === overrides.length;
  }, 'Name each step at most once.');
/** Operator change of one objective's or one delivery's overrides, fenced by the version the editor saw. */
export const stepOverridesControlSchema = z
  .object({
    taskId: z.string().uuid().optional(),
    featureId: z.string().uuid().optional(),
    /** The delivery's `version`, or the objective's `updatedAt`. */
    expectedVersion: z.number().int().nonnegative(),
    overrides: stepOverridesSchema,
  })
  .strict();
