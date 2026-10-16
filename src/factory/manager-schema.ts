/**
 * Persistent delivery manager policy. The manager is off until the operator
 * starts it; these bounds keep its process, wakeups and waiting honest.
 *
 * @file
 */

import { z } from 'zod/v3';

/** Smallest permitted manager memory ceiling. */
const MEMORY_MIN_MB = 256;
/** Default manager memory ceiling. */
const MEMORY_MB = 2048;
/** Smallest process ceiling that still allows the MCP bridge. */
const PROCESS_MIN = 4;
/** Largest process ceiling. */
const PROCESS_MAX = 64;
/** Default process ceiling. */
const PROCESS_DEFAULT = 16;
/** Shortest gap between unsolicited wakeups. */
const URGENT_MIN_MS = 10_000;
/** Default gap after an urgent report. */
const URGENT_MS = 60_000;
/** Shortest routine digest interval. */
const DIGEST_MIN_MS = 60_000;
/** Default routine digest interval. */
const DIGEST_MS = 900_000;
/** Shortest acknowledgment wait. */
const ACK_MIN_MS = 5000;
/** Default acknowledgment wait. */
const ACK_MS = 60_000;
/** Shortest reply wait. */
const REPLY_MIN_MS = 60_000;
/** Default reply wait. */
const REPLY_MS = 1_800_000;
/** Longest model name. */
const MODEL_MAX = 200;

/** Validated manager policy. */
export const managerPolicySchema = z
  .object({
    provider: z.enum(['claude', 'codex']).default('claude'),
    model: z.string().min(1).max(MODEL_MAX).optional(),
    effort: z.enum(['low', 'medium', 'high']).default('medium'),
    memoryMb: z.number().int().min(MEMORY_MIN_MB).default(MEMORY_MB),
    processLimit: z.number().int().min(PROCESS_MIN).max(PROCESS_MAX).default(PROCESS_DEFAULT),
    urgentDelayMs: z.number().int().min(URGENT_MIN_MS).default(URGENT_MS),
    digestMs: z.number().int().min(DIGEST_MIN_MS).default(DIGEST_MS),
    ackTimeoutMs: z.number().int().min(ACK_MIN_MS).default(ACK_MS),
    replyTimeoutMs: z.number().int().min(REPLY_MIN_MS).default(REPLY_MS),
  })
  .strict();
/** Parsed manager policy with every default applied. */
export type ManagerPolicy = z.output<typeof managerPolicySchema>;

/** Longest operator message or answer. */
const TEXT_MAX = 32_000;
/** Longest decision question. */
const QUESTION_MAX = 2000;
/** Most answer options in one decision. */
const OPTIONS_MAX = 8;
/** Largest conversation page. */
const PAGE_MAX = 500;

/** Factory operations owned by the manager. */
export const MANAGER_FACTORY_OPERATIONS = ['factory_manager', 'factory_brief', 'factory_ask'] as const;

/** Input contracts of the manager operations; flat objects so MCP can expose their fields. */
export const managerOperationSchemas = {
  factory_manager: z
    .object({
      action: z.enum(['status', 'start', 'stop', 'send', 'answer', 'history']),
      text: z.string().trim().min(1).max(TEXT_MAX).optional(),
      decisionId: z.string().uuid().optional(),
      after: z.number().int().nonnegative().optional(),
      limit: z.number().int().positive().max(PAGE_MAX).optional(),
    })
    .strict(),
  factory_brief: z.object({}).strict(),
  factory_ask: z
    .object({
      question: z.string().trim().min(1).max(QUESTION_MAX),
      options: z.array(z.string().trim().min(1).max(QUESTION_MAX)).max(OPTIONS_MAX).default([]),
      evidence: z.string().trim().min(1).max(TEXT_MAX),
    })
    .strict(),
};
