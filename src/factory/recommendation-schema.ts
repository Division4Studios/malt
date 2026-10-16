/** @file Bounded recommendation content/state contracts; historical public exports stay compatible. */
import { z } from 'zod/v3';

import { observedIssueSchema, recommendationAddress } from './recommendation-read-schema.ts';

/** Maximum descriptive proposal field. */
const TEXT_MAX = 32_000;
/** Opaque bounded proposal key. */
const TITLE_MAX = 200;
/** Canonical text bounds match the existing factory boundary. */
const textSchema = z.string().min(1).max(TEXT_MAX);

/** Bound each proposal's collections and identifiers independently of text. */
const RECOMMENDATION_ITEMS = 100;
/** Local-only proposals need exact semantic objective revisions without inventing GitHub tickets. */
const objectiveObservationSchema = z.object({ id: z.string().uuid(), revision: recommendationAddress }).strict();
/** Opaque project, issue revision and assignment identifiers. */
const recommendationKey = z.string().min(1).max(TITLE_MAX);
/** Exact, bounded proposal content; no ticket body snapshots are retained. */
export const recommendationBodySchema = z
  .object({
    kind: z.enum(['duplicate', 'related', 'consolidate', 'scope_change', 'guidance_suggestion']),
    tickets: z
      .array(z.number().int().safe().positive())
      .max(RECOMMENDATION_ITEMS)
      .transform((tickets) => [...new Set(tickets)].toSorted((a, b) => a - b)),
    action: textSchema,
    evidence: z.array(textSchema).min(1).max(RECOMMENDATION_ITEMS),
    observedIssues: z
      .array(observedIssueSchema)
      .max(RECOMMENDATION_ITEMS)
      .transform((issues) => issues.toSorted((a, b) => a.issue - b.issue)),
    observedObjectives: z
      .array(objectiveObservationSchema)
      .min(1)
      .max(RECOMMENDATION_ITEMS)
      .refine((items) => {
        const identities = new Set(items.map((item) => item.id));
        return identities.size === items.length;
      }, 'Duplicate local objective observation.')
      .transform((items) => items.toSorted((a, b) => a.id.localeCompare(b.id)))
      .optional(),
    survivor: z.number().int().safe().positive().nullable(),
    transferredAcceptance: z.array(textSchema).max(RECOMMENDATION_ITEMS),
    transferredDependencies: z.array(z.number().int().safe().positive()).max(RECOMMENDATION_ITEMS),
    affectedAssignments: z.array(recommendationKey).max(RECOMMENDATION_ITEMS),
    preview: z.object({ before: textSchema, after: textSchema }).strict(),
  })
  .strict()
  .refine(
    (body) => {
      return (
        (body.tickets.length > 0 ||
          (['related', 'scope_change'].includes(body.kind) && (body.observedObjectives?.length ?? 0) > 0)) &&
        (body.survivor === null || body.tickets.includes(body.survivor)) &&
        body.observedIssues.length === body.tickets.length &&
        body.observedIssues.every((issue, index) => issue.issue === body.tickets[index])
      );
    },
    { message: 'Every ticket needs exactly one observed revision; survivor must be a referenced ticket.' },
  );
/** Documented durable recommendation lifecycle. */
export const recommendationStateSchema = z.enum([
  'proposed',
  'awaiting_human',
  'approved',
  'rejected',
  'stale',
  'applying',
  'reconciling',
  'completed',
  'failed',
]);
/** One lifecycle state. */
export type RecommendationState = z.output<typeof recommendationStateSchema>;
/** Bounded proposal accepted by the repository. */
export type RecommendationBody = z.input<typeof recommendationBodySchema>;
/** One durable lifecycle observation. */
const recommendationAuditSchema = z.object({
  at: z.number(),
  from: recommendationStateSchema.nullable(),
  to: recommendationStateSchema,
  reason: textSchema,
});
/** A content-addressed revision with its lifecycle audit. */
export const recommendationSchema = z.object({
  id: z.string(),
  // Project identity follows persisted configuration, not the bounded recommendation keys.
  project: z.string().min(1),
  revision: z.string(),
  body: recommendationBodySchema,
  state: recommendationStateSchema,
  unread: z.boolean(),
  audit: z.array(recommendationAuditSchema),
});
/** Persisted recommendation revision. */
export type Recommendation = z.output<typeof recommendationSchema>;
/** Compare-and-set mutation; the repository supplies the project scope. */
export const recommendationTransitionSchema = z
  .object({
    id: recommendationKey,
    revision: recommendationKey,
    state: recommendationStateSchema,
    next: recommendationStateSchema,
    reason: textSchema,
  })
  .strict();
