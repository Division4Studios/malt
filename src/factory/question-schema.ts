/**
 * Durable questions a managed agent asks the operator. A question is bound to
 * the attempt that asked it and to the step it was working on; the operator
 * answers it once in the Inbox, and the step runs again with the answer.
 *
 * @file
 */

import { z } from 'zod/v3';

import { keySchema } from './seats.ts';

/** Longest question or answer text. */
export const QUESTION_TEXT_MAX = 2000;
/** Longest offered choice. */
const CHOICE_MAX = 200;
/** Most offered choices. */
const MAX_CHOICES = 6;

/** One offered choice. */
const choiceSchema = z.string().trim().min(1).max(CHOICE_MAX);

/** A managed agent's question, as it asks it; `askQuestion` requires a choice or a written answer. */
export const askSchema = z
  .object({
    /** Stable per-attempt key; a retry with the same key and text is deduplicated. */
    key: keySchema,
    question: z.string().trim().min(1).max(QUESTION_TEXT_MAX),
    choices: z.array(choiceSchema).max(MAX_CHOICES).default([]),
    /** Whether the operator may answer in their own words. */
    allowText: z.boolean().default(true),
  })
  .strict();

/** The operator's answer to one question; `answerQuestion` requires a choice or text. */
export const answerSchema = z
  .object({
    questionId: z.string().uuid(),
    /** Idempotency key: repeating it reports the first result. */
    requestId: z.string().uuid(),
    choice: choiceSchema.nullable().default(null),
    text: z.string().trim().max(QUESTION_TEXT_MAX).default(''),
  })
  .strict();

/** One stored question and, once given, its answer. */
export const questionSchema = z.object({
  id: z.string().uuid(),
  key: keySchema,
  jobId: z.string().uuid(),
  role: z.string(),
  kind: z.string(),
  taskId: z.string().uuid().nullable(),
  featureId: z.string().uuid().nullable(),
  stepId: z.string().nullable(),
  question: z.string(),
  choices: z.array(z.string()),
  allowText: z.boolean(),
  askedAt: z.number(),
  answer: z
    .object({ requestId: z.string().uuid(), choice: z.string().nullable(), text: z.string(), at: z.number() })
    .nullable(),
});
/** A stored question. */
export type Question = z.output<typeof questionSchema>;

/** Question operations: managed agents ask, the operator answers. */
export const QUESTION_OPERATIONS = ['factory_ask', 'factory_answer'] as const;
/** Their input schemas. */
export const questionSchemas = { factory_ask: askSchema, factory_answer: answerSchema };
