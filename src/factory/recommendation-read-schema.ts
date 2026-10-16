/** @file Bounded recommendation inspection/read receipts, separate from human decisions. */
import { z } from 'zod/v3';

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
/** Reading one exact current revision has no approval or execution authority. */
export const recommendationReadSchemas = {
  factory_recommendations: inspectionSchema,
  factory_recommendation_read: z.object({ id: recommendationAddress, revision: recommendationAddress }).strict(),
};
