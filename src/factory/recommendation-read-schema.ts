/** @file Bounded recommendation inspection/read receipts and the retry rule, separate from human decisions. */
import { z } from 'zod/v3';

import type { Recommendation } from './schema.ts';

/** Recommendation kinds that change remote tickets. */
const EXECUTED_KINDS: ReadonlySet<string> = new Set(['duplicate', 'consolidate']);

/** Maximum external freshness-token length; matches bounded proposal identifiers. */
const REVISION_MAX = 200;
/** One native issue and its observed revision, shared by proposal and inspection boundaries. */
export const observedIssueSchema = z
  .object({ issue: z.number().int().safe().positive(), revision: z.string().min(1).max(REVISION_MAX) })
  .strict();
/** Finite operator pages; large private proposal bodies are inspected individually. */
export const RECOMMENDATION_PAGE_MAX = 20;
/** Bounded inline detail; oversized historical records remain preserved in the ledger. */
export const RECOMMENDATION_DETAIL_MAX = 262_144;
/** Stable SHA-256 identities, distinct from observed external issue revisions. */
export const recommendationAddress = z.string().regex(/^[0-9a-f]{64}$/v);
/** Explicit list/get operations cannot accidentally mark a proposal read. */
export const recommendationListInput = z
  .object({
    kind: z.literal('list'),
    after: recommendationAddress.nullable().default(null),
    limit: z.number().int().min(1).max(RECOMMENDATION_PAGE_MAX).default(RECOMMENDATION_PAGE_MAX),
  })
  .strict();
/** Exact detail read, including an explicitly requested historical content revision. */
export const recommendationDetailInput = z
  .object({ kind: z.literal('get'), id: recommendationAddress, revision: recommendationAddress.optional() })
  .strict();
/** Object-shaped MCP input; the backend additionally enforces the selected strict variant. */
const inspectionSchema = z
  .object({
    kind: z.enum(['list', 'get']),
    after: recommendationAddress.nullable().optional(),
    limit: z.number().int().min(1).max(RECOMMENDATION_PAGE_MAX).optional(),
    id: recommendationAddress.optional(),
    revision: recommendationAddress.optional(),
  })
  .strict();
/** Operator retry of a failed duplicate or consolidation at its exact revision. */
export const recommendationRetrySchema = z
  .object({ id: recommendationAddress, revision: recommendationAddress })
  .strict();

/**
 * Whether a record is a remote ticket operation the executor applies.
 *
 * @param record - Current recommendation revision.
 * @returns True for duplicates and consolidations with a survivor.
 */
export function isTicketOperation(record: Recommendation): boolean {
  return EXECUTED_KINDS.has(record.body.kind) && record.body.survivor !== null && record.body.tickets.length > 1;
}

/**
 * Whether the executor advances a record: ticket operations and guidance suggestions.
 *
 * @param record - Current recommendation revision.
 * @returns True for records with an executable approved outcome.
 */
export function isExecutable(record: Recommendation): boolean {
  return isTicketOperation(record) || record.body.kind === 'guidance_suggestion';
}

/**
 * Whether the operator may retry a record: one the executor applies, settled as failed.
 *
 * @param record - Recommendation revision.
 * @returns True exactly when `factory_recommendation_retry` accepts it at this revision.
 */
export function isRetryable(record: Recommendation): boolean {
  return record.state === 'failed' && isExecutable(record);
}

/** Reading one exact current revision has no approval or execution authority. */
export const recommendationReadSchemas = {
  factory_recommendations: inspectionSchema,
  factory_recommendation_read: z.object({ id: recommendationAddress, revision: recommendationAddress }).strict(),
};
