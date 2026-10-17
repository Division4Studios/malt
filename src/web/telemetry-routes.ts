/**
 * Strict query parsing for the read-only telemetry routes `/api/attempts`,
 * `/api/transcript` and `/api/costs`, and for an objective's progress log at
 * `/api/objective-log`. Every parameter is a known, unrepeated
 * key; numbers must be plain decimals. Data comes from broker operations.
 *
 * @file
 */
import { z } from 'zod/v3';

import { FACTORY_ROLES, JOB_KINDS, PROVIDERS } from '../factory/seats.ts';
import { ATTEMPT_PAGE_MAX, ATTEMPT_STATES, TRANSCRIPT_PAGE_MAX } from '../factory/telemetry-schema.ts';
import { MeshError } from '../protocol.ts';

import type { ProjectGateway } from './projects.ts';

/** Read-only routes served by this module. */
const TELEMETRY_ROUTES = new Set(['/api/attempts', '/api/transcript', '/api/costs', '/api/objective-log']);
/** Largest progress log page. */
const LOG_PAGE_MAX = 100;
/** Maximum project scope identifier. */
const PROJECT_MAX = 4096;
/** Longest free-text attempt query. */
const QUERY_MAX = 200;
/** Longest IANA time zone name. */
const TIME_ZONE_MAX = 64;
/** Longest cursor text. */
const CURSOR_MAX = 64;
/** A plain decimal; coercion alone would accept blanks, signs and exponents. */
const decimal = z
  .string()
  .regex(/^\d{1,16}$/v)
  .transform(Number)
  .pipe(z.number().int().min(0).safe());
/** Explicit project scope. */
const project = z.string().min(1).max(PROJECT_MAX);
/** Attempt listing query. */
const attemptsQuerySchema = z
  .object({
    project,
    role: z.enum(FACTORY_ROLES).optional(),
    kind: z.enum(JOB_KINDS).optional(),
    provider: z.enum(PROVIDERS).optional(),
    state: z.enum(ATTEMPT_STATES).optional(),
    taskId: z.string().uuid().optional(),
    featureId: z.string().uuid().optional(),
    since: decimal.optional(),
    until: decimal.optional(),
    query: z.string().min(1).max(QUERY_MAX).optional(),
    cursor: z.string().min(1).max(CURSOR_MAX).optional(),
    limit: decimal.pipe(z.number().min(1).max(ATTEMPT_PAGE_MAX)).optional(),
  })
  .strict();
/** Transcript page query. */
const transcriptQuerySchema = z
  .object({
    project,
    job: z.string().uuid(),
    cursor: decimal.optional(),
    limit: decimal.pipe(z.number().min(1).max(TRANSCRIPT_PAGE_MAX)).optional(),
  })
  .strict();
/** Cost window query. */
const costsQuerySchema = z
  .object({
    project,
    days: z.enum(['1', '7', '30', '90']).transform(Number).optional(),
    timeZone: z.string().min(1).max(TIME_ZONE_MAX).optional(),
  })
  .strict();
/** Objective progress log page query. */
const objectiveLogQuerySchema = z
  .object({
    project,
    featureId: z.string().uuid(),
    before: decimal.pipe(z.number().min(1)).optional(),
    limit: decimal.pipe(z.number().min(1).max(LOG_PAGE_MAX)).optional(),
  })
  .strict();

/**
 * Decode query parameters, rejecting any repeated key.
 *
 * @param url - Parsed local URL.
 * @returns One value per key.
 * @throws {MeshError} For repeated parameters.
 */
function uniqueParameters(url: URL): Record<string, string> {
  const keys = url.searchParams.keys().toArray();
  const unique = new Set(keys);
  if (unique.size !== keys.length) {
    throw new MeshError('INVALID_INPUT', 'Query parameters must not repeat.');
  }
  return Object.fromEntries(url.searchParams);
}

/**
 * Parse a telemetry route's query and read its data through the broker.
 *
 * @param url - Parsed local URL whose path selects the route.
 * @param gateway - Authenticated project gateway.
 * @returns Validated broker result for the route.
 * @throws {MeshError} For any other inspection route or repeated parameters.
 */
export async function telemetryRoute(url: URL, gateway: ProjectGateway): Promise<unknown> {
  if (!TELEMETRY_ROUTES.has(url.pathname)) {
    throw new MeshError('NOT_FOUND', 'Unknown inspection route.');
  }
  const parameters = uniqueParameters(url);
  switch (url.pathname) {
    case '/api/attempts': {
      const { project: scope, ...filters } = attemptsQuerySchema.parse(parameters);
      return gateway.attempts(scope, filters);
    }
    case '/api/transcript': {
      const { project: scope, job, ...page } = transcriptQuerySchema.parse(parameters);
      return gateway.transcript(scope, { jobId: job, ...page });
    }
    case '/api/costs': {
      const { project: scope, ...window } = costsQuerySchema.parse(parameters);
      return gateway.costs(scope, window);
    }
    case '/api/objective-log': {
      const { project: scope, ...page } = objectiveLogQuerySchema.parse(parameters);
      return gateway.objectiveLog(scope, page);
    }
    default: {
      throw new MeshError('NOT_FOUND', 'Unknown inspection route.');
    }
  }
}
