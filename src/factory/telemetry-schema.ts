/**
 * Validated contracts for attempt telemetry: transcript nodes, per-attempt
 * metrics, the operator price table, cost summaries and attempt listings.
 * This leaf module imports only role vocabularies, so both the factory
 * operation table and the web gateway can share it without import cycles.
 *
 * @file
 */
import { z } from 'zod/v3';

import { FAILURE_CLASSES, LIVENESS_STATES } from './liveness-schema.ts';
import { FACTORY_ROLES, JOB_KINDS, PROVIDERS } from './seats.ts';
import { spendStatusSchema } from './spend-schema.ts';

/** Largest transcript page returned by one read. */
export const TRANSCRIPT_PAGE_MAX = 500;
/** Default transcript page. */
const TRANSCRIPT_PAGE_DEFAULT = 200;
/** Largest attempt listing page. */
export const ATTEMPT_PAGE_MAX = 100;
/** Default attempt listing page. */
const ATTEMPT_PAGE_DEFAULT = 50;
/** Longest free-text attempt query. */
const QUERY_MAX = 200;
/** Longest stored model identifier. */
const MODEL_MAX = 200;
/** Most priced models an operator may enter. */
export const PRICE_ROWS_MAX = 200;
/** Upper bound on any per-million-token price, catching unit mistakes. */
const PRICE_MAX = 100_000;
/** Longest accepted IANA time zone name. */
const TIME_ZONE_MAX = 64;
/** Durable attempt lifecycle states. */
export const ATTEMPT_STATES = ['running', 'succeeded', 'failed', 'interrupted'] as const;
/** One-day cost window. */
const DAY = 1;
/** One-week cost window. */
const WEEK = 7;
/** Thirty-day cost window. */
const MONTH = 30;
/** Ninety-day cost window. */
const QUARTER = 90;

/** Opaque, stable listing cursor: the last row's start time and job id. */
const attemptCursorSchema = z.string().regex(/^\d{1,16}:[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/v);
/** Non-negative safe millisecond timestamp. */
const timestampSchema = z.number().int().nonnegative().safe();

/**
 * Accept only time zones the local Intl implementation can actually apply.
 *
 * @param zone - Candidate IANA time zone name.
 * @returns Whether formatting in that zone succeeds.
 */
export function isTimeZone(zone: string): boolean {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return formatter.resolvedOptions().timeZone !== '';
  } catch {
    return false;
  }
}

/** Filters and cursor accepted by `factory_attempts`. */
export const attemptsInputSchema = z
  .object({
    role: z.enum(FACTORY_ROLES).optional(),
    kind: z.enum(JOB_KINDS).optional(),
    provider: z.enum(PROVIDERS).optional(),
    state: z.enum(ATTEMPT_STATES).optional(),
    taskId: z.string().uuid().optional(),
    featureId: z.string().uuid().optional(),
    since: timestampSchema.optional(),
    until: timestampSchema.optional(),
    query: z.string().trim().min(1).max(QUERY_MAX).optional(),
    cursor: attemptCursorSchema.optional(),
    limit: z.number().int().min(1).max(ATTEMPT_PAGE_MAX).default(ATTEMPT_PAGE_DEFAULT),
  })
  .strict();
/** Validated attempt filters. */
export type AttemptFilters = z.output<typeof attemptsInputSchema>;
/** One transcript page request accepted by `factory_transcript`. */
export const transcriptInputSchema = z
  .object({
    jobId: z.string().uuid(),
    cursor: z.number().int().nonnegative().safe().default(0),
    limit: z.number().int().min(1).max(TRANSCRIPT_PAGE_MAX).default(TRANSCRIPT_PAGE_DEFAULT),
  })
  .strict();
/** Cost window accepted by `factory_costs`. */
export const costsInputSchema = z
  .object({
    days: z.union([z.literal(DAY), z.literal(WEEK), z.literal(MONTH), z.literal(QUARTER)]).default(WEEK),
    timeZone: z
      .string()
      .min(1)
      .max(TIME_ZONE_MAX)
      .refine((zone) => isTimeZone(zone), { message: 'Expected a supported IANA time zone.' })
      .default('UTC'),
  })
  .strict();
/** One operator-entered model price in USD per million tokens. */
export const modelPriceSchema = z
  .object({
    model: z.string().trim().min(1).max(MODEL_MAX),
    input: z.number().finite().min(0).max(PRICE_MAX),
    cachedInput: z.number().finite().min(0).max(PRICE_MAX),
    cacheWrite: z.number().finite().min(0).max(PRICE_MAX),
    output: z.number().finite().min(0).max(PRICE_MAX),
  })
  .strict();
/** One model price. */
export type ModelPrice = z.output<typeof modelPriceSchema>;
/** Revision-fenced replacement of the whole price table (`factory_prices`). */
export const pricesInputSchema = z
  .object({
    prices: z
      .array(modelPriceSchema)
      .max(PRICE_ROWS_MAX)
      .refine(
        (rows) => {
          const models = new Set(rows.map((row) => row.model));
          return models.size === rows.length;
        },
        { message: 'Each model may appear only once.' },
      ),
    expectedRevision: z.number().int().nonnegative().safe(),
  })
  .strict();
/** Telemetry operations merged into the factory operation table. */
export const telemetrySchemas = {
  factory_attempts: attemptsInputSchema,
  factory_transcript: transcriptInputSchema,
  factory_costs: costsInputSchema,
  factory_prices: pricesInputSchema,
};
/** Telemetry operation names, in the same order as {@link telemetrySchemas}. */
export const TELEMETRY_OPERATIONS = [
  'factory_attempts',
  'factory_transcript',
  'factory_costs',
  'factory_prices',
] as const;
/** Persisted price table projection. */
export const priceTableSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    prices: z.array(modelPriceSchema),
    updatedAt: timestampSchema.nullable(),
  })
  .strict();
/** Saved price table. */
export type PriceTable = z.output<typeof priceTableSchema>;

/** Where an attempt's cost figure came from. */
export const costSourceSchema = z.enum(['reported', 'estimated', 'unpriced']);
/** Split token counts; `null` fields were not reported by the provider. */
export const tokenSplitSchema = z
  .object({
    input: z.number().nonnegative().nullable(),
    cacheRead: z.number().nonnegative().nullable(),
    cacheWrite: z.number().nonnegative().nullable(),
    output: z.number().nonnegative().nullable(),
    reasoning: z.number().nonnegative().nullable(),
    total: z.number().nonnegative().nullable(),
  })
  .strict();
/** Token split for one attempt or aggregate. */
export type TokenSplit = z.output<typeof tokenSplitSchema>;
/** Count of calls to one tool name. */
const toolCountSchema = z
  .object({ name: z.string(), calls: z.number().int().nonnegative(), failed: z.number().int().nonnegative() })
  .strict();
/** Per-attempt metrics derived from the provider stream and the job record. */
export const attemptMetricsSchema = z
  .object({
    tokens: tokenSplitSchema,
    cost: z.object({ usd: z.number().nonnegative().nullable(), source: costSourceSchema }).strict(),
    model: z.string().nullable(),
    turns: z.number().int().nonnegative().nullable(),
    tools: z
      .object({
        total: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        byName: z.array(toolCountSchema),
      })
      .strict(),
    durationMs: z.number().nonnegative().nullable(),
    apiDurationMs: z.number().nonnegative().nullable(),
    filesTouched: z.number().int().nonnegative(),
    outcome: z.enum(ATTEMPT_STATES),
    providerError: z.boolean(),
    stream: z
      .object({
        available: z.boolean(),
        bytes: z.number().int().nonnegative(),
        truncated: z.boolean(),
        malformedLines: z.number().int().nonnegative(),
        unknownEvents: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
/** Metrics for one attempt. */
export type AttemptMetrics = z.output<typeof attemptMetricsSchema>;

/** Tool call execution status shown by the transcript viewer. */
export const toolStatusSchema = z.enum(['ok', 'error', 'running', 'incomplete']);
/** A paired tool call and its bounded result. */
export const toolDetailSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    summary: z.string(),
    input: z.string(),
    inputTruncated: z.boolean(),
    output: z.string(),
    outputTruncated: z.boolean(),
    status: toolStatusSchema,
    exitCode: z.number().int().nullable(),
  })
  .strict();
/** One file named by a change. */
export const fileChangeSchema = z.object({ path: z.string(), kind: z.string() }).strict();
/** One ordered transcript node. */
export const transcriptNodeSchema = z
  .object({
    seq: z.number().int().nonnegative(),
    kind: z.enum(['input', 'assistant', 'thinking', 'tool', 'file_change', 'result', 'status']),
    label: z.string(),
    text: z.string(),
    truncated: z.boolean(),
    level: z.enum(['info', 'warning', 'error']),
    tool: toolDetailSchema.nullable(),
    changes: z.array(fileChangeSchema),
  })
  .strict();
/** One transcript node. */
export type TranscriptNode = z.output<typeof transcriptNodeSchema>;
/** A path changed by the attempt and how many edits named it. */
export const fileTouchSchema = z.object({ path: z.string(), touches: z.number().int().positive() }).strict();
/** One touched file. */
export type FileTouch = z.output<typeof fileTouchSchema>;
/** One transcript page plus attempt-wide context (`factory_transcript` result). */
export const transcriptPageSchema = z
  .object({
    jobId: z.string().uuid(),
    provider: z.enum(PROVIDERS),
    live: z.boolean(),
    nodes: z.array(transcriptNodeSchema),
    totalNodes: z.number().int().nonnegative(),
    nextCursor: z.number().int().nonnegative().nullable(),
    nodesTruncated: z.boolean(),
    filesTouched: z.array(fileTouchSchema),
    filesTruncated: z.boolean(),
    metrics: attemptMetricsSchema,
  })
  .strict();
/** One transcript page. */
export type TranscriptPage = z.output<typeof transcriptPageSchema>;

/** One listed attempt without transcript bodies. */
export const attemptRowSchema = z
  .object({
    id: z.string().uuid(),
    role: z.enum(FACTORY_ROLES),
    kind: z.enum(JOB_KINDS),
    provider: z.enum(PROVIDERS),
    model: z.string().nullable(),
    tier: z.string().nullable(),
    effort: z.string().nullable(),
    state: z.enum(ATTEMPT_STATES),
    startedAt: z.number(),
    finishedAt: z.number().nullable(),
    taskId: z.string().uuid().nullable(),
    featureId: z.string().uuid().nullable(),
    step: z.string().nullable(),
    summary: z.string().nullable(),
    task: z.object({ issue: z.number().int().positive(), title: z.string() }).strict().nullable(),
    objective: z.string().nullable(),
    metrics: attemptMetricsSchema,
    /** Checkpoint liveness: extensions and, once stopped, `stalled N min` or `hard ceiling`. */
    liveness: z
      .object({
        state: z.enum(LIVENESS_STATES),
        lastSignal: z.string().nullable(),
        extensions: z.number().int().nonnegative(),
        stopReason: z.string().nullable(),
      })
      .strict()
      .nullable(),
    /** Why a finished attempt did not succeed. */
    failureClass: z.enum(FAILURE_CLASSES).nullable(),
  })
  .strict();
/** One attempt listing row. */
export type AttemptRow = z.output<typeof attemptRowSchema>;
/** One attempt listing page (`factory_attempts` result). */
export const attemptPageSchema = z
  .object({
    attempts: z.array(attemptRowSchema),
    nextCursor: z.string().nullable(),
    priceRevision: z.number().int().nonnegative(),
  })
  .strict();
/** One attempt listing page. */
export type AttemptPage = z.output<typeof attemptPageSchema>;

/** Cost and volume of one breakdown group. */
export const costGroupSchema = z
  .object({
    key: z.string(),
    label: z.string(),
    costUsd: z.number().nonnegative(),
    attempts: z.number().int().nonnegative(),
    unpricedAttempts: z.number().int().nonnegative(),
    tokens: z.number().nonnegative(),
  })
  .strict();
/** One breakdown group. */
export type CostGroup = z.output<typeof costGroupSchema>;
/** One calendar day of cost by role. */
export const costDaySchema = z
  .object({
    day: z.string(),
    totalUsd: z.number().nonnegative(),
    attempts: z.number().int().nonnegative(),
    byRole: z.record(z.number().nonnegative()),
  })
  .strict();
/** One costed attempt in the top list. */
export const topAttemptSchema = z
  .object({
    jobId: z.string().uuid(),
    role: z.string(),
    kind: z.string(),
    provider: z.string(),
    model: z.string().nullable(),
    state: z.enum(ATTEMPT_STATES),
    startedAt: z.number(),
    costUsd: z.number().nonnegative(),
    costSource: costSourceSchema,
    delivery: z.string().nullable(),
  })
  .strict();
/** Local cost summary for the costs view (`factory_costs` result). */
export const costSummarySchema = z
  .object({
    days: z.number().int().positive(),
    timeZone: z.string(),
    from: z.string(),
    to: z.string(),
    generatedAt: z.number(),
    truncated: z.boolean(),
    totals: z
      .object({
        costUsd: z.number().nonnegative(),
        attempts: z.number().int().nonnegative(),
        pricedAttempts: z.number().int().nonnegative(),
        reportedAttempts: z.number().int().nonnegative(),
        estimatedAttempts: z.number().int().nonnegative(),
        unpricedAttempts: z.number().int().nonnegative(),
        averagePerPricedAttempt: z.number().nonnegative().nullable(),
        wasteUsd: z.number().nonnegative(),
        wasteAttempts: z.number().int().nonnegative(),
      })
      .strict(),
    roles: z.array(z.string()),
    daily: z.array(costDaySchema),
    byRole: z.array(costGroupSchema),
    byModel: z.array(costGroupSchema),
    byObjective: z.array(costGroupSchema),
    byDelivery: z.array(costGroupSchema),
    topAttempts: z.array(topAttemptSchema),
    tokens: tokenSplitSchema.extend({ cacheHitPercent: z.number().min(0).nullable() }).strict(),
    unpricedModels: z.array(z.string()),
    prices: priceTableSchema,
    spend: spendStatusSchema,
  })
  .strict();
/** Local cost summary. */
export type CostSummary = z.output<typeof costSummarySchema>;
