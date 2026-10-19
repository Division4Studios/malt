/**
 * Approval gates as data. A project declares default gates; each objective
 * freezes them when it is filed (with any per-objective override), and each
 * delivery freezes its merge gate when it is provisioned, so changing the
 * project default never moves work already in flight. The plan gate asks for
 * a human approval of the plan before deliveries are created; the merge gate
 * asks for one on the exact head before the final check merges it.
 *
 * @file
 */

import { z } from 'zod/v3';

/** Gates an objective or project applies. */
export const gatesSchema = z
  .object({
    /** Approve the plan before its deliveries are created. */
    plan: z.boolean().default(false),
    /** Approve each delivery's exact head before the final check merges it. */
    merge: z.boolean().default(false),
  })
  .strict();
/** Resolved gates. */
export type Gates = z.output<typeof gatesSchema>;
/** Per-dispatch override; omitted gates keep the project default. */
export const gateOverrideSchema = z.object({ plan: z.boolean().optional(), merge: z.boolean().optional() }).strict();
/** A delivery's frozen merge gate. */
export const deliveryGatesSchema = z.object({ merge: z.boolean() }).strict();

/** Operator change of one objective's or one delivery's gates; `changeGates` checks the combination. */
export const gatesControlSchema = z
  .object({
    taskId: z.string().uuid().optional(),
    featureId: z.string().uuid().optional(),
    plan: z.boolean().optional(),
    merge: z.boolean().optional(),
  })
  .strict();

/** Id of the approval step the merge gate adds before the final check. */
export const MERGE_GATE_STEP = 'operator-merge-gate';
