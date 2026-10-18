/**
 * Input contract of the `factory_local` operation. It is a flat object so the
 * MCP facade can expose its fields; per-action requirements are enforced by
 * the local delivery controls.
 *
 * @file
 */

import { z } from 'zod/v3';

/** Longest descriptive text, matching factory task text. */
const TEXT_MAX = 32_000;
/** Longest title or status label. */
const TITLE_MAX = 200;
/** Most acceptance criteria in one delivery, matching the planning bound. */
const CRITERIA_MAX = 100;
/** Bounded descriptive text. */
const text = z.string().min(1).max(TEXT_MAX);

/** Validated local delivery control. */
export const localControlSchema = z
  .object({
    action: z.enum(['summary', 'issue', 'pull', 'create_issue', 'set_status', 'comment', 'sync']),
    number: z.number().int().positive().optional(),
    requestId: z
      .string()
      .regex(/^[\da-z][\w\-]{0,63}$/v)
      .optional(),
    kind: z.enum(['feature', 'delivery']).optional(),
    title: z.string().min(1).max(TITLE_MAX).optional(),
    description: text.optional(),
    acceptanceCriteria: z.array(text).max(CRITERIA_MAX).optional(),
    parent: z.number().int().positive().optional(),
    status: z.string().min(1).max(TITLE_MAX).optional(),
    body: text.optional(),
  })
  .strict();
