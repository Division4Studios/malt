/**
 * Shapes for an objective's definition of done and its progress log. The
 * operator owns the checklist; managed agents may propose an item or check
 * one only with evidence, and the operator can override either. The log is
 * append-only and read a page at a time.
 *
 * @file
 */
import { z } from 'zod/v3';

/** Most checklist items per objective. */
export const DONE_ITEMS_MAX = 50;
/** Longest checklist item. */
const ITEM_TEXT_MAX = 300;
/** Longest evidence text or link. */
const EVIDENCE_MAX = 1000;
/** Shortest evidence an agent must give. */
const EVIDENCE_MIN = 10;
/** Longest operator note. */
const NOTE_MAX = 2000;
/** Largest log page. */
const LOG_PAGE_MAX = 100;
/** Default log page. */
const LOG_PAGE_DEFAULT = 30;

/** Where a checklist item stands. */
export const doneStateSchema = z.enum(['open', 'proposed', 'checked', 'waived']);
/** A checklist state. */
export type DoneState = z.output<typeof doneStateSchema>;

/** One definition-of-done item as stored on its objective. */
export const doneItemSchema = z
  .object({
    id: z.string().uuid(),
    text: z.string().trim().min(1).max(ITEM_TEXT_MAX),
    state: doneStateSchema,
    /** Who last set the state: `operator` or a factory role. */
    by: z.string().nullable(),
    /** When the state was last set. */
    at: z.number().nullable(),
    /** Evidence or link supporting a check. */
    evidence: z.string().max(EVIDENCE_MAX).nullable(),
  })
  .strict();
/** One checklist item. */
export type DoneItem = z.output<typeof doneItemSchema>;

/** One item as the operator saves it; an id keeps an existing item. */
const savedItemSchema = z
  .object({
    id: z.string().uuid().optional(),
    text: z.string().trim().min(1).max(ITEM_TEXT_MAX),
    state: z.enum(['open', 'checked', 'waived']),
    evidence: z.string().trim().max(EVIDENCE_MAX).nullable().default(null),
  })
  .strict();

/** Operator replacement of a whole checklist (`factory_objective_done`). */
export const doneSaveSchema = z
  .object({
    featureId: z.string().uuid(),
    expectedUpdatedAt: z.number(),
    items: z.array(savedItemSchema).max(DONE_ITEMS_MAX),
  })
  .strict();

/** A managed agent's check or proposal (`factory_objective_check`); exactly one of `itemId` and `text`. */
export const doneCheckSchema = z
  .object({
    itemId: z.string().uuid().optional(),
    text: z.string().trim().min(1).max(ITEM_TEXT_MAX).optional(),
    evidence: z.string().trim().min(EVIDENCE_MIN).max(EVIDENCE_MAX),
  })
  .strict();

/** Operator note appended to the progress log (`factory_objective_note`). */
export const objectiveNoteSchema = z
  .object({ featureId: z.string().uuid(), note: z.string().trim().min(1).max(NOTE_MAX) })
  .strict();

/** One page of the progress log (`factory_objective_log`). */
export const objectiveLogInputSchema = z
  .object({
    featureId: z.string().uuid(),
    before: z.number().int().positive().optional(),
    limit: z.number().int().min(1).max(LOG_PAGE_MAX).default(LOG_PAGE_DEFAULT),
  })
  .strict();

/** What a log entry records. */
export const logKindSchema = z.enum(['plan', 'delivery', 'check_in', 'criteria', 'note', 'objective']);
/** A log entry kind. */
export type LogKind = z.output<typeof logKindSchema>;

/** One progress log entry. */
export const logEntrySchema = z
  .object({
    seq: z.number().int().positive(),
    at: z.number(),
    kind: logKindSchema,
    /** `operator`, a factory role, or `supervisor`. */
    actor: z.string(),
    body: z.string(),
  })
  .strict();
/** One log entry. */
export type LogEntry = z.output<typeof logEntrySchema>;

/** One page of log entries, newest first. */
export const logPageSchema = z
  .object({
    featureId: z.string().uuid(),
    entries: z.array(logEntrySchema),
    total: z.number().int().nonnegative(),
    /** Cursor for the next older page, or `null` at the start. */
    next: z.number().int().positive().nullable(),
  })
  .strict();
/** One page of log entries. */
export type LogPage = z.output<typeof logPageSchema>;

/** Objective goal operations merged into the factory operation table. */
export const objectiveGoalSchemas = {
  factory_objective_done: doneSaveSchema,
  factory_objective_check: doneCheckSchema,
  factory_objective_note: objectiveNoteSchema,
  factory_objective_log: objectiveLogInputSchema,
};
/** Objective goal operation names, in the same order as {@link objectiveGoalSchemas}. */
export const OBJECTIVE_GOAL_OPERATIONS = [
  'factory_objective_done',
  'factory_objective_check',
  'factory_objective_note',
  'factory_objective_log',
] as const;
