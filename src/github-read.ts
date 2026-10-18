/**
 * One read-only GitHub GraphQL query through the GitHubRunner seam, with its
 * failure classified and its remote text discarded: callers learn whether the
 * account may not read something, the schema lacks it, or GitHub was
 * unavailable, but never see remote messages, tokens or headers.
 *
 * @file
 */
import { z } from 'zod/v3';

import type { GitHubRunner } from './github-runner.ts';

/** GraphQL error types that mean the account may not read this. */
const FORBIDDEN_TYPES: ReadonlySet<string> = new Set(['FORBIDDEN', 'INSUFFICIENT_SCOPES']);
/** GraphQL error entry. */
const graphQLErrorSchema = z.object({ type: z.string().optional(), message: z.string().optional() });
/** GraphQL response envelope. */
const envelopeSchema = z.object({ data: z.unknown().optional(), errors: z.array(graphQLErrorSchema).optional() });

/** Outcome of one read-only query. */
export type QueryResult =
  { readonly data: unknown } | { readonly failure: 'forbidden' | 'unsupported' | 'unavailable' };

/**
 * Classify a GraphQL error without keeping its text.
 *
 * @param error - First error entry.
 * @returns Failure class.
 */
function failureOf(error: z.output<typeof graphQLErrorSchema>): 'forbidden' | 'unsupported' | 'unavailable' {
  if (FORBIDDEN_TYPES.has(error.type ?? '')) {
    return 'forbidden';
  }
  return /doesn't exist on type|undefinedField/v.test(error.message ?? '') ? 'unsupported' : 'unavailable';
}

/**
 * Run one read-only GraphQL query and classify any failure.
 *
 * @param runner - GitHub CLI seam.
 * @param query - Fixed query document; never a mutation.
 * @param variables - Validated variables.
 * @returns Data, or the failure class.
 */
export async function readGraphQL(
  runner: GitHubRunner,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<QueryResult> {
  let raw: unknown;
  try {
    raw = await runner(['api', 'graphql', '--input', '-'], { query, variables });
  } catch {
    return { failure: 'unavailable' };
  }
  const envelope = envelopeSchema.safeParse(raw);
  if (!envelope.success) {
    return { failure: 'unavailable' };
  }
  const [error] = envelope.data.errors ?? [];
  if (error !== undefined) {
    return { failure: failureOf(error) };
  }
  return envelope.data.data === undefined ? { failure: 'unavailable' } : { data: envelope.data.data };
}

/**
 * Validate a query's data.
 *
 * @param result - Query outcome.
 * @param schema - Expected data shape.
 * @returns Parsed data, or null when the query failed or the shape differs.
 */
export function dataOf<Output>(result: QueryResult, schema: z.ZodType<Output, z.ZodTypeDef, unknown>): Output | null {
  if (!('data' in result)) {
    return null;
  }
  const parsed = schema.safeParse(result.data);
  return parsed.success ? parsed.data : null;
}
