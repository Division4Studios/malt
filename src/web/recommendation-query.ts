/** @file Explicit project selection and bounded recommendation route parameters. */
import { z } from 'zod/v3';

import { RECOMMENDATION_PAGE_MAX, recommendationAddress } from '../factory/recommendation-read-schema.ts';
import { MeshError } from '../protocol.ts';

/** Public selected-project identifiers are finite, never arbitrary filesystem reads. */
const PROJECT_MAX = 4096;
/** Reject alternate integer spellings and nonfinite page limits. */
const limitSchema = z
  .string()
  .regex(/^[1-9]\d*$/v)
  .transform(Number)
  .pipe(z.number().int().max(RECOMMENDATION_PAGE_MAX));
/** GET list query; kind is chosen by the server route, never overridden by a query. */
const listSchema = z
  .object({
    project: z.string().min(1).max(PROJECT_MAX),
    after: recommendationAddress.optional(),
    limit: limitSchema.optional(),
  })
  .strict();
/** Exact detail query with an optional historical content revision. */
const detailSchema = z
  .object({
    project: z.string().min(1).max(PROJECT_MAX),
    id: recommendationAddress,
    revision: recommendationAddress.optional(),
  })
  .strict();
/** Mutations require explicit project scope and place their exact receipt in the bounded body. */
const projectSchema = z.object({ project: z.string().min(1).max(PROJECT_MAX) }).strict();

/**
 * Parse one route without duplicate fields or an implicit broker-home fallback.
 *
 * @param url - Actual local request URL.
 * @param kind - Server-selected list/detail/read route.
 * @returns Selected public project and exact backend inspection input.
 * @throws {MeshError} For repeated or unrelated query fields.
 */
export function recommendationQuery(url: URL, kind: 'list' | 'get' | 'read'): { project: string; input: unknown } {
  const keys = url.searchParams.keys().toArray();
  const unique = new Set(keys);
  if (unique.size !== keys.length) {
    throw new MeshError('INVALID_INPUT', 'Recommendation query parameters must not repeat.');
  }
  const raw = Object.fromEntries(url.searchParams);
  if (kind === 'read') {
    return { project: projectSchema.parse(raw).project, input: {} };
  }
  const { project, ...input } = kind === 'list' ? listSchema.parse(raw) : detailSchema.parse(raw);
  return { project, input: { ...input, kind } };
}
