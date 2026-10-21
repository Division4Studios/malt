/** @file Connector inspection routes: bounded read-only GitHub discovery for the Connections view. */
import { z } from 'zod/v3';

import { MeshError } from '../protocol.ts';

import type { ProjectGateway } from './projects.ts';

/** Public selected-project identifiers are finite, never arbitrary filesystem reads. */
const PROJECT_MAX = 4096;
/** Discovery query; the broker validates each field again. */
const querySchema = z
  .object({
    project: z.string().min(1).max(PROJECT_MAX),
    repository: z.string().min(1).max(PROJECT_MAX).optional(),
    owner: z.string().min(1).max(PROJECT_MAX).optional(),
    projectNumber: z
      .string()
      .regex(/^[1-9]\d{0,8}$/v)
      .transform(Number)
      .optional(),
  })
  .strict();

/**
 * Parse a discovery route without duplicate fields.
 *
 * @param url - Actual local request URL.
 * @returns Selected public project and the read-only discovery input.
 * @throws {MeshError} For repeated or unrelated query fields.
 */
function discoveryQuery(url: URL): { project: string; input: Record<string, unknown> } {
  const keys = url.searchParams.keys().toArray();
  const unique = new Set(keys);
  if (unique.size !== keys.length) {
    throw new MeshError('INVALID_INPUT', 'Discovery query parameters must not repeat.');
  }
  const { project, ...input } = querySchema.parse(Object.fromEntries(url.searchParams));
  return { project, input };
}

/**
 * Answer a connector inspection route, or defer to the next route table.
 *
 * @param url - Actual local request URL.
 * @param gateway - Scoped project gateway.
 * @param fallback - Routes for any other path.
 * @returns The route's result.
 */
export async function connectorRoute(
  url: URL,
  gateway: Pick<ProjectGateway, 'discovery'>,
  fallback: () => Promise<unknown>,
): Promise<unknown> {
  if (url.pathname !== '/api/github-discovery') {
    return fallback();
  }
  const query = discoveryQuery(url);
  return gateway.discovery(query.project, query.input);
}
