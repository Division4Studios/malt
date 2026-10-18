/**
 * Shapes for automations that create objectives without a person at the
 * console: cron schedules evaluated in a time zone, and loopback webhook
 * triggers authenticated by a per-trigger secret. Only a SHA-256 hash of a
 * trigger secret is stored; the secret itself is shown once.
 *
 * @file
 */
import { z } from 'zod/v3';

import { keySchema } from './seats.ts';

/** Longest automation name. */
const NAME_MAX = 120;
/** Longest objective an automation files, matching objective requests. */
const OBJECTIVE_MAX = 20_000;
/** Longest cron expression. */
const CRON_MAX = 120;
/** Longest IANA zone name. */
const ZONE_MAX = 64;

/** Operator-facing automation name. */
const nameSchema = z.string().trim().min(1).max(NAME_MAX);
/** Objective text an automation files. */
const objectiveSchema = z.string().trim().min(1).max(OBJECTIVE_MAX);
/** Revision the editor started from; absent when creating. */
const revisionSchema = z.number().int().nonnegative();

/** Fields every stored automation has. */
const automationShape = {
  id: z.string().uuid(),
  name: nameSchema,
  objective: objectiveSchema,
  workflowId: keySchema.nullable(),
  isEnabled: z.boolean(),
  revision: revisionSchema,
  lastFiredAt: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
};

/** A stored cron schedule. */
export const scheduleSchema = z.object({
  ...automationShape,
  kind: z.literal('schedule'),
  cron: z.string().min(1).max(CRON_MAX),
  timeZone: z.string().min(1).max(ZONE_MAX),
  /** Next fire time; `null` when disabled or the expression never fires. */
  nextAt: z.number().nullable(),
});
/** A stored cron schedule. */
export type Schedule = z.output<typeof scheduleSchema>;

/** A stored webhook trigger. */
export const triggerSchema = z.object({
  ...automationShape,
  kind: z.literal('trigger'),
  /** Hex SHA-256 of the secret; the secret itself is never stored. */
  secretHash: z.string().regex(/^[\da-f]{64}$/v),
});
/** A stored webhook trigger. */
export type Trigger = z.output<typeof triggerSchema>;

/** Any stored automation. */
export const automationSchema = z.discriminatedUnion('kind', [scheduleSchema, triggerSchema]);
/** Any stored automation. */
export type Automation = z.output<typeof automationSchema>;

/** One recorded fire and what it produced. */
export const fireSchema = z.object({
  id: z.string().uuid(),
  automationId: z.string().uuid(),
  kind: z.enum(['schedule', 'trigger', 'manual']),
  at: z.number(),
  /** Objective created or matched, when the fire succeeded. */
  featureId: z.string().uuid().nullable(),
  /** Why the fire did not create an objective. */
  error: z.string().nullable(),
});
/** One recorded fire. */
export type Fire = z.output<typeof fireSchema>;

/** Fields an editor sends for either kind. */
const saveShape = {
  id: z.string().uuid().optional(),
  expectedRevision: revisionSchema.optional(),
  name: nameSchema,
  objective: objectiveSchema,
  workflowId: keySchema.nullable().default(null),
  isEnabled: z.boolean().default(true),
};

/** Create or edit a schedule. */
export const scheduleSaveSchema = z
  .object({ ...saveShape, cron: z.string().trim().min(1).max(CRON_MAX), timeZone: z.string().min(1).max(ZONE_MAX) })
  .strict();
/** Create or edit a trigger; `rotateSecret` issues a new secret and revokes the old one. */
export const triggerSaveSchema = z.object({ ...saveShape, rotateSecret: z.boolean().default(false) }).strict();
/** Delete an automation the editor last saw at a revision. */
export const automationDeleteSchema = z.object({ id: z.string().uuid(), expectedRevision: revisionSchema }).strict();
/** Fire an automation now, once per request id. */
export const automationRunSchema = z.object({ id: z.string().uuid(), requestId: z.string().uuid() }).strict();

/** Automation operations merged into the factory operation table. */
export const automationSchemas = {
  factory_schedule_save: scheduleSaveSchema,
  factory_trigger_save: triggerSaveSchema,
  factory_automation_delete: automationDeleteSchema,
  factory_automation_run: automationRunSchema,
};
/** Automation operation names, in the same order as {@link automationSchemas}. */
export const AUTOMATION_OPERATIONS = [
  'factory_schedule_save',
  'factory_trigger_save',
  'factory_automation_delete',
  'factory_automation_run',
] as const;
