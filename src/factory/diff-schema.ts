/**
 * Validated contracts for a delivery's source diff: the request accepted by
 * `factory_delivery_diff`, the changed-file summary and one file's bounded
 * patch. This leaf module imports only Zod, so the factory operation table and
 * the web gateway can share it without import cycles.
 *
 * @file
 */
import { z } from 'zod/v3';

/** Longest Git-relative path accepted or returned. */
export const DIFF_PATH_MAX = 4096;
/** Most changed files listed in one summary. */
export const DIFF_FILES_MAX = 1000;
/** Largest patch text returned for one file, in bytes. */
export const PATCH_BYTES_MAX = 524_288;
/** Changed lines above which a file's patch is not generated at all. */
export const PATCH_LINES_MAX = 20_000;
/** Git change kinds, from the `--raw` status letter. */
export const DIFF_STATUSES = ['added', 'deleted', 'modified', 'renamed', 'copied', 'type_changed'] as const;

/** Largest similarity percent. */
const PERCENT_MAX = 100;
/** Full Git object name, never a ref the caller could steer. */
const commitSchema = z.string().regex(/^(?:[\da-f]{40}|[\da-f]{64})$/v);
/** A non-negative line count, or null for binary content. */
const countSchema = z.number().int().nonnegative().safe().nullable();
/** A Git-relative path. */
const pathSchema = z.string().min(1).max(DIFF_PATH_MAX);

/** One summary or patch request. */
export const deliveryDiffInputSchema = z
  .object({
    taskId: z.string().uuid(),
    /** A changed path from the summary; absent asks for the summary. */
    path: pathSchema.optional(),
  })
  .strict();
/** Delivery diff operation merged into the factory operation table. */
export const diffSchemas = { factory_delivery_diff: deliveryDiffInputSchema };
/** Delivery diff operation names, in the same order as {@link diffSchemas}. */
export const DIFF_OPERATIONS = ['factory_delivery_diff'] as const;

/** One changed file. */
export const diffFileSchema = z
  .object({
    path: pathSchema,
    /** Source path of a rename or copy. */
    oldPath: pathSchema.nullable(),
    status: z.enum(DIFF_STATUSES),
    additions: countSchema,
    deletions: countSchema,
    isBinary: z.boolean(),
    /** Octal modes at the base and head; `000000` when that side does not exist. */
    baseMode: z.string().regex(/^\d{6}$/v),
    headMode: z.string().regex(/^\d{6}$/v),
    /** Rename or copy similarity percent. */
    similarity: z.number().int().min(0).max(PERCENT_MAX).nullable(),
  })
  .strict();
/** One changed file. */
export type DiffFileSummary = z.output<typeof diffFileSchema>;

/** A non-negative total. */
const totalSchema = z.number().int().nonnegative().safe();
/** Totals over every listed and unlisted public file. */
const totalsSchema = z.object({ files: totalSchema, additions: totalSchema, deletions: totalSchema }).strict();
/** Why a delivery has no diff to show. */
const unavailableSchema = z
  .object({ taskId: z.string().uuid(), state: z.literal('unavailable'), reason: z.string().min(1) })
  .strict();

/** The changed files of a delivery's head against its base. */
export const diffSummarySchema = z.union([
  z
    .object({
      taskId: z.string().uuid(),
      state: z.literal('ready'),
      base: commitSchema,
      head: commitSchema,
      files: z.array(diffFileSchema).max(DIFF_FILES_MAX),
      totals: totalsSchema,
      /** Changed private runtime or credential paths, counted but never listed. */
      privateChanges: z.number().int().nonnegative().safe(),
      /** More files changed than were listed. */
      isTruncated: z.boolean(),
    })
    .strict(),
  unavailableSchema,
]);
/** A delivery diff summary. */
export type DiffSummary = z.output<typeof diffSummarySchema>;

/** One file's unified patch. */
export const diffPatchSchema = z.union([
  z
    .object({
      taskId: z.string().uuid(),
      state: z.literal('ready'),
      base: commitSchema,
      head: commitSchema,
      path: pathSchema,
      patch: z.string().max(PATCH_BYTES_MAX),
      /** The patch was cut at a line boundary, or not generated because the file is too large. */
      isTruncated: z.boolean(),
      /** Bytes of the full patch, when it was generated. */
      bytes: z.number().int().nonnegative().safe().nullable(),
    })
    .strict(),
  unavailableSchema,
]);
/** A delivery file patch. */
export type DiffPatch = z.output<typeof diffPatchSchema>;
