/** @file Bounded explicit model policy; capability declarations never imply verified CLI support. */
import { z } from 'zod/v3';

/** Account-local choices are finite operator configuration, not a remote catalog. */
const MAX_MODELS = 24;
/** Three capability defaults for each supported provider. */
const MAX_DEFAULTS = 6;
/** Native identifiers are literal arguments, never shell syntax or flags. */
const MODEL_MAX = 256;
/** Bounded provenance and rationale. */
const NOTE_MAX = 2000;
/** Native support choices are deliberately limited to low, medium and high. */
const MAX_EFFORTS = 3;
/** Ordered capability floors shared by validation and resolution. */
export const MODEL_TIERS = ['small', 'standard', 'advanced'] as const;
/** Explicit effort choices; null means no native effort argument. */
export const effortSchema = z.enum(['low', 'medium', 'high']);
/** Safe policy-local identity. */
const idSchema = z.string().regex(/^[a-z][\-0-9a-z]{0,63}$/v);
/** An exact provider/model with declared capability and interface evidence. */
export const modelEntrySchema = z
  .object({
    id: idSchema,
    provider: z.enum(['codex', 'claude']),
    model: z
      .string()
      .min(1)
      .max(MODEL_MAX)
      .regex(/^[0-9A-Za-z][\w\-.\/:]*$/v),
    capability: z.enum(MODEL_TIERS),
    effortSupport: z.enum(['unknown', 'none', 'codex-config', 'claude-effort']),
    efforts: z.array(effortSchema).max(MAX_EFFORTS),
    evidence: z
      .object({
        source: z.string().min(1).max(NOTE_MAX),
        version: z.string().min(1).max(MODEL_MAX),
        observedAt: z.number().int().safe().positive(),
      })
      .strict()
      .nullable(),
  })
  .strict()
  .superRefine((entry, context) => {
    const invalid = (message: string): void => {
      context.addIssue({ code: z.ZodIssueCode.custom, message });
    };
    const efforts = new Set(entry.efforts);
    if (efforts.size !== entry.efforts.length) {
      invalid('Duplicate effort choice.');
    }
    const isExplicit = entry.effortSupport === 'codex-config' || entry.effortSupport === 'claude-effort';
    const hasEfforts = entry.efforts.length > 0;
    if (isExplicit !== hasEfforts) {
      invalid('Effort choices require an explicit supported interface.');
    }
    if (entry.effortSupport !== 'unknown' && entry.evidence === null) {
      invalid('Known support requires recorded interface evidence.');
    }
    if (
      (entry.effortSupport === 'codex-config' && entry.provider !== 'codex') ||
      (entry.effortSupport === 'claude-effort' && entry.provider !== 'claude')
    ) {
      invalid('Effort interface contradicts provider.');
    }
  });
/** One allowed default combination at a capability floor. */
const defaultSchema = z
  .object({
    provider: z.enum(['codex', 'claude']),
    tier: z.enum(MODEL_TIERS),
    entryId: idSchema,
    effort: effortSchema.nullable(),
  })
  .strict();
/** A revision is immutable once accepted; updates use the next consecutive revision. */
export const modelPolicySchema = z
  .object({
    revision: z.number().int().safe().positive(),
    entries: z.array(modelEntrySchema).min(1).max(MAX_MODELS),
    defaults: z.array(defaultSchema).min(1).max(MAX_DEFAULTS),
  })
  .strict()
  .superRefine((policy, context) => {
    const invalid = (message: string): void => {
      context.addIssue({ code: z.ZodIssueCode.custom, message });
    };
    const ids = new Set<string>();
    const models = new Set<string>();
    for (const entry of policy.entries) {
      const key = `${entry.provider}:${entry.model}`;
      if (ids.has(entry.id) || models.has(key)) {
        invalid('Duplicate model identity or contradictory capability.');
      }
      ids.add(entry.id);
      models.add(key);
    }
    const defaults = new Set<string>();
    for (const choice of policy.defaults) {
      const key = `${choice.provider}:${choice.tier}`;
      if (defaults.has(key)) {
        invalid('Duplicate provider capability default.');
      }
      defaults.add(key);
      const entry = policy.entries.find((candidate) => candidate.id === choice.entryId);
      if (
        entry?.provider !== choice.provider ||
        MODEL_TIERS.indexOf(entry.capability) < MODEL_TIERS.indexOf(choice.tier)
      ) {
        invalid('Default references an absent or inadequate provider/model.');
      }
      if (
        entry !== undefined &&
        (choice.effort === null ? entry.efforts.length > 0 : !entry.efforts.includes(choice.effort))
      ) {
        invalid('Default effort is not allowed for this model.');
      }
    }
  });
/** Validated explicit policy. */
export type ModelPolicy = z.output<typeof modelPolicySchema>;
/** Assignment-local native selection, including its exact evidence revision. */
export const modelSelectionSchema = z
  .object({
    policyRevision: z.number().int().safe().positive(),
    observedVersion: z.string().min(1).max(MODEL_MAX).optional(),
    entry: modelEntrySchema,
    effort: effortSchema.nullable(),
  })
  .strict();
/** Project authorization is supplied by the existing transport, never the payload. */
export const modelPolicyUpdateSchema = z
  .object({ expectedRevision: z.number().int().safe().positive().nullable(), policy: modelPolicySchema })
  .strict();
