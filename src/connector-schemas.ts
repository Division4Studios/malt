/**
 * Input schemas of the connector setup and resource operations: read-only
 * discovery, per-section save and verification, and repository labels. The
 * protocol merges them into its operation table.
 *
 * @file
 */
import { z } from 'zod/v3';

/** Longest Project or field identifier accepted from discovery. */
const IDENTIFIER_MAX = 200;
/** Longest repository label name GitHub accepts. */
const LABEL_NAME_MAX = 50;
/** Longest repository label description GitHub accepts. */
const LABEL_DESCRIPTION_MAX = 100;
/** Most labels applied in one call. */
const LABELS_PER_ISSUE = 20;

/** A Project and its existing Status field, chosen for the tracker section. */
const savedTrackerSchema = z
  .object({
    owner: z.string().regex(/^[\w\-]+$/v),
    projectId: z.string().min(1).max(IDENTIFIER_MAX),
    projectNumber: z.number().int().positive(),
    url: z.string().url(),
    workflowField: z.object({ id: z.string().min(1), name: z.string().min(1) }).strict(),
  })
  .strict();
/** An exact repository label name. */
const labelNameSchema = z.string().min(1).max(LABEL_NAME_MAX);

/** A repository and its node ID, chosen for the source section. */
const savedSourceSchema = z
  .object({
    repository: z.string().regex(/^[\w\-.]+\/[\w\-.]+$/v),
    repositoryId: z.string().min(1).max(IDENTIFIER_MAX).optional(),
  })
  .strict();

/** Longest milestone title GitHub accepts in practice. */
const MILESTONE_TITLE_MAX = 255;
/** Longest milestone description accepted. */
const MILESTONE_DESCRIPTION_MAX = 1000;
/** An exact milestone title. */
const milestoneTitleSchema = z.string().min(1).max(MILESTONE_TITLE_MAX);

/** Connector operation inputs, keyed by operation name. */
export const connectorSchemas = {
  github_milestones: z.object({}).strict(),
  github_milestone_assign: z.object({ issue: z.number().int().positive(), title: milestoneTitleSchema }).strict(),
  github_milestone_manage: z
    .object({
      requestId: z.string().regex(/^[\w\-]{1,64}$/v),
      action: z.enum(['create', 'edit', 'close', 'delete']),
      title: milestoneTitleSchema,
      retitle: milestoneTitleSchema.optional(),
      description: z.string().max(MILESTONE_DESCRIPTION_MAX).optional(),
      dueOn: z.string().datetime().optional(),
    })
    .strict(),
  github_verify: z.object({}).strict(),
  github_labels: z.object({}).strict(),
  github_label_apply: z
    .object({ issue: z.number().int().positive(), labels: z.array(labelNameSchema).min(1).max(LABELS_PER_ISSUE) })
    .strict(),
  github_label_manage: z
    .object({
      requestId: z.string().regex(/^[\w\-]{1,64}$/v),
      action: z.enum(['create', 'edit', 'delete']),
      name: labelNameSchema,
      rename: labelNameSchema.optional(),
      color: z
        .string()
        .regex(/^[\da-f]{6}$/iv)
        .optional(),
      description: z.string().max(LABEL_DESCRIPTION_MAX).optional(),
    })
    .strict(),
  github_section_save: z
    .object({ tracker: savedTrackerSchema.optional(), source: savedSourceSchema.optional() })
    .strict(),
  github_discover: z
    .object({
      repository: z
        .string()
        .regex(/^[\w\-.]+\/[\w\-.]+$/v)
        .optional(),
      repositoryId: z.string().min(1).max(IDENTIFIER_MAX).optional(),
      owner: z
        .string()
        .regex(/^[\w\-]+$/v)
        .optional(),
      projectNumber: z.number().int().positive().optional(),
    })
    .strict(),
};
