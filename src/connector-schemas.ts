/**
 * Input schemas of the connector setup operations: read-only discovery and
 * per-section save and verification. The protocol merges them into its
 * operation table.
 *
 * @file
 */
import { z } from 'zod/v3';

/** Longest Project or field identifier accepted from discovery. */
const IDENTIFIER_MAX = 200;

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
/** A repository and its node ID, chosen for the source section. */
const savedSourceSchema = z
  .object({
    repository: z.string().regex(/^[\w\-.]+\/[\w\-.]+$/v),
    repositoryId: z.string().min(1).max(IDENTIFIER_MAX).optional(),
  })
  .strict();

/** Connector operation inputs, keyed by operation name. */
export const connectorSchemas = {
  github_verify: z.object({}).strict(),
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
