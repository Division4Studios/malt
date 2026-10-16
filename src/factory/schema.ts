/**
 * Validated factory settings, delivery state and managed job results. These
 * schemas are shared by persistence, MCP boundaries and provider adapters.
 *
 * @file
 */

import { z } from 'zod/v3';

import {
  roleChoiceOutput,
  modelChoiceSchema,
  modelPolicySchema,
  modelPolicyUpdateSchema,
  modelSelectionSchema,
  reviewedRecommendationSchema,
} from './model-policy.ts';
import { queueControlSchema } from './objective-queue-schema.ts';
import { organizationSchema, frozenOrganizationSchema } from './organization.ts';
import { subscriptionWindowsSchema } from './quota-windows.ts';
import { recommendationReadSchemas } from './recommendation-read-schema.ts';
import { terminalPolicySchema } from './terminal-lifetime.ts';

/** Bound operator triage context independently of model transcripts. */
const TRIAGE_NOTE_MAX = 4000;
/** Named min free percent bound. */
const MIN_FREE_PERCENT = 15;
/** Extra reviewed project skills attached to one stage. */
const MAX_ASSIGNMENT_SKILLS = 4;
/** Bound the lead's per-role routing explanation. */
const ROUTING_REASON_MAX = 1000;
/** Absolute operator-selected workspace path bound. */
const WORKSPACE_MAX = 4096;
/** Maximum explicitly configured descendants in a Windows managed process job. */
const MAX_JOB_PROCESSES = 128;
/** Bound forks and tool processes without leaving idle role shells alive. */
const DEFAULT_JOB_PROCESSES = 32;
/** Named default job CPU bound. */
const DEFAULT_JOB_CPU = 50;
/** Named percent max bound. */
const PERCENT_MAX = 100;

/** Roles have independent process slots even when they use the same provider. */
export const FACTORY_ROLES = [
  'product-owner',
  'team-lead',
  'developer-1',
  'developer-2',
  'qa-1',
  'qa-2',
  'final-tester',
  'learning-steward',
] as const;
/** Provider CLI families supported by the managed runtime. */
export const PROVIDERS = ['codex', 'claude'] as const;
/** Longest descriptive task text. */
const TEXT_MAX = 32_000;
/** Longest public title. */
const TITLE_MAX = 200;
/** Largest atomic plan accepted at once. */
const PLAN_MAX = 100;
/** Conservative capacity reservation for a job without usage telemetry yet. */
const TOKEN_RESERVATION = 32_000;
/** Default scheduling accounting window. */
const WINDOW_MS = 3_600_000;
/** Default managed process deadline. */
const JOB_TIMEOUT_MS = 1_800_000;
/** Default periodic board reconciliation interval. */
const RECONCILE_MS = 30_000;
/** Default learning interval; meaningful delivery changes also trigger it. */
const LEARNING_MS = 21_600_000;
/** Maximum attempts before escalating a genuine blocker. */
const MAX_ATTEMPTS = 5;
/** Maximum source files in one atomic delivery. */
const MAX_FILES = 20;
/** Default publication ceiling; explicit project policies may override it. */
const MAX_LINES = 500;
/** Conservative local resource defaults for transient model/test processes. */
const MEMORY_MB = 2048;
/** Stop admitting work before the machine approaches memory exhaustion. */
const FREE_MEMORY_MB = 1024;
/** Admission threshold for aggregate CPU utilization. */
const CPU_PERCENT = 85;
/** Default verified rate-limit cooldown. */
export const COOLDOWN_MS = 300_000;
/** Duration of a supervisor/job lease, renewed without involving a model. */
export const LEASE_MS = 30_000;
/** A safe internal key, used in branch and artifact names. */
export const keySchema = z.string().regex(/^[\da-z][\w\-]{0,63}$/v);
/** Lead-reviewed role routing carried through a delivery's durable handoff. */
const assignmentProfilesSchema = z
  .array(
    z
      .object({
        role: z.enum(FACTORY_ROLES),
        tier: z.enum(['small', 'standard', 'advanced']),
        effort: z.enum(['low', 'medium', 'high']),
        reason: z.string().min(1).max(ROUTING_REASON_MAX),
        modelChoice: modelChoiceSchema.nullable().optional(),
      })
      .strict(),
  )
  .max(FACTORY_ROLES.length)
  .refine((profiles) => {
    const roles = new Set(profiles.map((profile) => profile.role));
    return profiles.every((profile) => profile.modelChoice === undefined) || roles.size === profiles.length;
  }, 'Duplicate role recommendations.')
  .optional();
/** Bounded text which cannot be empty. */
export const textSchema = z.string().min(1).max(TEXT_MAX);
/** Bound each proposal's collections and identifiers independently of text. */
const RECOMMENDATION_ITEMS = 100;
/** Opaque project, issue revision and assignment identifiers. */
const recommendationKey = z.string().min(1).max(TITLE_MAX);
/** One observed issue identifier and freshness token. */
const observedIssueSchema = z
  .object({ issue: z.number().int().safe().positive(), revision: recommendationKey })
  .strict();
/** Exact, bounded proposal content; no ticket body snapshots are retained. */
export const recommendationBodySchema = z
  .object({
    kind: z.enum(['duplicate', 'related', 'consolidate', 'scope_change', 'guidance_suggestion']),
    tickets: z
      .array(z.number().int().safe().positive())
      .min(1)
      .max(RECOMMENDATION_ITEMS)
      .transform((tickets) => [...new Set(tickets)].toSorted((a, b) => a - b)),
    action: textSchema,
    evidence: z.array(textSchema).min(1).max(RECOMMENDATION_ITEMS),
    observedIssues: z
      .array(observedIssueSchema)
      .min(1)
      .max(RECOMMENDATION_ITEMS)
      .transform((issues) => issues.toSorted((a, b) => a.issue - b.issue)),
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
/** Shell-free project validation command. */
export const commandSchema = z.object({ file: z.string().min(1), args: z.array(z.string()).default([]) }).strict();
/** Configurable provider capacity and executable; credentials remain external. */
export const providerSchema = z
  .object({
    enabled: z.boolean().default(true),
    executable: z.string().min(1),
    model: z.string().min(1).optional(),
    developerAccess: z.enum(['workspace', 'full-access']).default('workspace'),
    windowsSandbox: z.enum(['mxc', 'elevated', 'unelevated']).default('unelevated'),
    preferMxc: z.boolean().default(true),
    models: z
      .object({
        small: z.string().min(1).optional(),
        standard: z.string().min(1).optional(),
        advanced: z.string().min(1).optional(),
      })
      .strict()
      .default({}),
    concurrency: z.number().int().min(1).max(FACTORY_ROLES.length).default(2),
    budgetTokens: z.number().int().positive().nullable().default(null),
    reservationTokens: z.number().int().positive().default(TOKEN_RESERVATION),
    windowMs: z.number().int().positive().default(WINDOW_MS),
  })
  .strict();

/**
 * Apply a token cap only when an operator explicitly configured one.
 *
 * @param budget - Optional diagnostic-token ceiling; null means subscription-only.
 * @param usage - Observed, reserved and requested accounting total.
 * @returns Whether that explicit cap would be exceeded.
 */
export function isTokenCapExceeded(budget: number | null, usage: number): boolean {
  return budget !== null && usage > budget;
}
/** Project-specific factory setup; meaningful validation commands are mandatory. */
export const factoryConfigSchema = z
  .object({
    version: z.literal(1).default(1),
    modelPolicy: modelPolicySchema.optional(),
    organization: organizationSchema(FACTORY_ROLES),
    requireBranchProtection: z.boolean().default(true),
    requireProjectAttachment: z.literal(true).default(true),
    baseBranch: keySchema.default('main'),
    remote: keySchema.default('origin'),
    testCommands: z.array(commandSchema).min(1),
    endToEndCommands: z.array(commandSchema).min(1),
    prepareCommands: z.array(commandSchema).default([]),
    reviewStandards: z
      .array(textSchema)
      .min(1)
      .default([
        'Check correctness, regressions, security boundaries, maintainability and acceptance criteria adversarially.',
      ]),
    requiredChecks: z.array(z.string().min(1)).default([]),
    providers: z
      .object({
        codex: providerSchema.default({ executable: 'codex' }),
        claude: providerSchema.default({ executable: 'claude' }),
      })
      .default({ codex: { executable: 'codex' }, claude: { executable: 'claude' } }),
    maxAttempts: z.number().int().positive().default(MAX_ATTEMPTS),
    maxFiles: z.number().int().positive().default(MAX_FILES),
    maxDiffLines: z.number().int().positive().default(MAX_LINES),
    jobTimeoutMs: z.number().int().positive().default(JOB_TIMEOUT_MS),
    reconcileMs: z.number().int().positive().default(RECONCILE_MS),
    learningMs: z.number().int().positive().default(LEARNING_MS),
    assignmentSkills: z
      .record(
        z.enum(['plan', 'refine', 'develop', 'review', 'final', 'verify', 'learn', 'skill', 'triage']),
        z.array(keySchema).max(MAX_ASSIGNMENT_SKILLS),
      )
      .default({}),
    resources: z
      .object({
        maxActiveJobs: z.number().int().min(1).max(FACTORY_ROLES.length).default(2),
        minFreeMemoryMb: z.number().nonnegative().default(FREE_MEMORY_MB),
        minFreeMemoryPercent: z.number().min(0).max(PERCENT_MAX).default(MIN_FREE_PERCENT),
        maxCpuPercent: z.number().min(1).max(PERCENT_MAX).default(CPU_PERCENT),
        jobMemoryMb: z.number().positive().default(MEMORY_MB),
        jobCpuPercent: z.number().min(1).max(PERCENT_MAX).default(DEFAULT_JOB_CPU),
        jobProcessLimit: z.number().int().min(2).max(MAX_JOB_PROCESSES).default(DEFAULT_JOB_PROCESSES),
      })
      .default({}),
    terminals: terminalPolicySchema.default({}),
  })
  .strict();
/** A configured project factory. */
export type FactoryConfig = z.output<typeof factoryConfigSchema>;
/** A managed role. */
export type FactoryRole = (typeof FACTORY_ROLES)[number];
/** A provider family. */
export type Provider = (typeof PROVIDERS)[number];
/** One atomic scope produced by product refinement and lead review. */
export const deliverySchema = z
  .object({
    key: keySchema,
    title: z.string().min(1).max(TITLE_MAX),
    description: textSchema,
    acceptanceCriteria: z.array(textSchema).min(1),
    dependencies: z.array(keySchema),
    capabilityTier: z.enum(['small', 'standard', 'advanced']).nullable().default(null),
    assignmentProfiles: assignmentProfilesSchema,
    skills: z.array(keySchema).max(MAX_ASSIGNMENT_SKILLS).default([]),
  })
  .strict();
/** Proposed skill lifecycle action; adoption still requires independent lead review. */
export const skillActionSchema = z
  .object({
    name: keySchema,
    revision: z.string().regex(/^[\da-f]{64}$/v),
    state: z.enum(['active', 'archived']),
    reason: textSchema,
  })
  .strict();
/** A provider's structured result; irrelevant fields must be empty arrays. */
const instructionReceiptSchema = z
  .object({ id: z.string().uuid(), acknowledged: z.boolean(), applied: z.boolean(), evidence: textSchema })
  .strict()
  .refine((receipt) => !receipt.applied || receipt.acknowledged, {
    message: 'Applied instructions require explicit acknowledgement.',
  });
/** Maximum focused instruction receipts per assignment. */
const MAX_INSTRUCTION_RECEIPTS = 20;
/** A provider's structured result; irrelevant fields must be empty arrays. */
export const resultSchema = z
  .object({
    outcome: z.enum(['success', 'changes_requested', 'blocked']),
    summary: textSchema,
    findings: z.array(textSchema),
    deliveries: z.array(deliverySchema).max(PLAN_MAX),
    skillActions: z.array(skillActionSchema).default([]),
    instructionReceipts: z.array(instructionReceiptSchema).max(MAX_INSTRUCTION_RECEIPTS).default([]),
  })
  .strict();
/** Validated managed agent output. */
export type AgentResult = z.output<typeof resultSchema>;
/** Product objectives persist independently of model sessions. */
export const featureSchema = z.object({
  rank: z.number().int().nonnegative().optional(),
  id: z.string().uuid(),
  scopeReplacement: z.string().uuid().optional(),
  scopeCleanup: z.object({ at: z.number(), note: z.string() }).optional(),
  objective: textSchema,
  phase: z.enum(['queued', 'refining', 'provisioning', 'active', 'done', 'blocked']),
  productPlan: resultSchema.nullable(),
  plan: resultSchema.nullable(),
  parentIssue: z.number().int().positive().nullable(),
  error: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
/** One durable product request. */
export type Feature = z.output<typeof featureSchema>;
/** Exact-head independent QA evidence. */
export const reviewSchema = z.object({
  role: z.enum(['qa-1', 'qa-2']),
  head: z.string(),
  base: z.string(),
  outcome: z.enum(['success', 'changes_requested', 'blocked']),
  summary: textSchema,
  jobId: z.string().uuid(),
});
/** Exact source and size measured after successful delivery validation. */
const publicationSizeSchema = z.object({
  head: z.string().min(1),
  base: z.string().min(1),
  files: z.number().int().positive(),
  lines: z.number().int().nonnegative(),
});
/** Durable delivery and PR lifecycle. */
export const taskSchema = z.object({
  publicationGate: publicationSizeSchema.optional(),
  sizeApproval: publicationSizeSchema.extend({ reason: z.string().min(1), at: z.number() }).optional(),
  id: z.string().uuid(),
  scopeReplacement: z.string().uuid().optional(),
  featureId: z.string().uuid().nullable(),
  scopeCleanup: z.object({ at: z.number(), note: z.string() }).optional(),
  issue: z.number().int().positive(),
  parentIssue: z.number().int().positive(),
  key: keySchema,
  title: z.string(),
  description: z.string(),
  acceptanceCriteria: z.array(textSchema),
  dependencies: z.array(z.string().uuid()),
  capabilityTier: z.enum(['small', 'standard', 'advanced']).nullable().default(null),
  assignmentProfiles: assignmentProfilesSchema,
  skills: z.array(keySchema).max(MAX_ASSIGNMENT_SKILLS).default([]),
  phase: z.enum([
    'ready',
    'development',
    'publishing',
    'review',
    'merge_ready',
    'merging',
    'verifying',
    'closing',
    'done',
    'blocked',
  ]),
  developer: z.enum(['developer-1', 'developer-2']).nullable(),
  branch: z.string().nullable(),
  worktree: z.string().nullable(),
  head: z.string().nullable(),
  base: z.string().nullable(),
  pr: z.number().int().positive().nullable(),
  prUrl: z.string().nullable(),
  merge: z.string().nullable(),
  reviews: z.array(reviewSchema),
  feedback: z.array(z.string()),
  attempts: z.number().int().nonnegative(),
  finalReview: z
    .object({ head: z.string(), base: z.string(), jobId: z.string().uuid(), summary: textSchema })
    .nullable()
    .default(null),
  verifiedMain: z.object({ head: z.string(), jobId: z.string().uuid(), summary: textSchema }).nullable().default(null),
  version: z.number().int().nonnegative(),
  error: z.string().nullable(),
  updatedAt: z.number(),
});
/** One atomic delivery. */
export type FactoryTask = z.output<typeof taskSchema>;
/** Stage-specific jobs occupy an exclusive role slot and fence late results. */
export const jobSchema = z.object({
  id: z.string().uuid(),
  role: z.enum(FACTORY_ROLES),
  provider: z.enum(PROVIDERS),
  routing: z
    .object({
      tier: z.enum(['small', 'standard', 'advanced']),
      model: z.string().nullable(),
      effort: z.enum(['low', 'medium', 'high']).nullable().optional(),
      selection: modelSelectionSchema.optional(),
      reviewed: reviewedRecommendationSchema.optional(),
      reason: textSchema,
      skillNames: z.array(keySchema),
      organization: frozenOrganizationSchema.optional(),
    })
    .optional(),
  kind: z.enum(['plan', 'refine', 'develop', 'review', 'final', 'verify', 'learn', 'skill', 'triage']),
  taskId: z.string().uuid().nullable(),
  featureId: z.string().uuid().nullable(),
  target: z.string().uuid().nullable().default(null),
  token: z.string().uuid(),
  state: z.enum(['running', 'succeeded', 'failed', 'interrupted']),
  startedAt: z.number(),
  finishedAt: z.number().nullable(),
  expiresAt: z.number(),
  reservation: z.number(),
  usageTokens: z.number().nonnegative().nullable(),
  pid: z.number().int().positive().nullable(),
  head: z.string().nullable(),
  base: z.string().nullable(),
  summary: z.string().nullable(),
  artifact: z.string(),
});
/** One managed process attempt. */
export type FactoryJob = z.output<typeof jobSchema>;
/** Operator views do not need the internal stale-result fencing token. */
export const publicJobSchema = jobSchema.omit({ token: true });
/** Capacity accounting is project-local and explicitly distinguishes unknown quota. */
export const capacitySchema = z.object({
  provider: z.enum(PROVIDERS),
  usedTokens: z.number().nonnegative(),
  reservedTokens: z.number().nonnegative(),
  resetAt: z.number(),
  cooldownUntil: z.number(),
  subscriptionUsedPercent: z.number().min(0).max(PERCENT_MAX).nullable(),
  subscriptionResetAt: z.number().nullable(),
  subscriptionWindows: subscriptionWindowsSchema.optional().catch([]),
  telemetrySource: z.string().nullable(),
  updatedAt: z.number(),
});
/** Persisted capacity snapshot. */
export type Capacity = z.output<typeof capacitySchema>;
/** Durable, retryable remote effects. */
export const effectSchema = z.object({
  id: z.string(),
  kind: z.enum(['status', 'comment', 'close', 'close_not_planned', 'close_pr']),
  issue: z.number().int().positive(),
  value: z.string(),
  attempts: z.number().int().nonnegative(),
  retryAt: z.number(),
  error: z.string().nullable(),
});
/** One outbox entry. */
export type FactoryEffect = z.output<typeof effectSchema>;
/** Independent lead review of a learning steward's adoption/retirement request. */
export const skillRequestSchema = skillActionSchema.extend({
  id: z.string().uuid(),
  status: z.enum(['pending', 'awaiting_operator', 'approved', 'rejected']),
  previousRevision: z.string().nullable().optional(),
  leadSummary: z.string().nullable().optional(),
  operatorDecision: z.object({ approved: z.boolean(), reason: textSchema, at: z.number() }).optional(),
  requestedAt: z.number(),
  reviewedAt: z.number().nullable(),
  summary: z.string().nullable(),
});
/** One durable reviewed-learning action. */
export type SkillRequest = z.output<typeof skillRequestSchema>;
/** MCP/CLI operations exposed by the factory. */
export const factorySchemas = {
  ...recommendationReadSchemas,
  factory_progress: z.object({ key: keySchema, body: z.string().min(1).max(TEXT_MAX) }).strict(),
  factory_read_source: z
    .object({
      path: z.string().min(1).max(WORKSPACE_MAX).optional(),
      revision: z.enum(['head', 'base']).default('head'),
      cursor: z.number().int().safe().nonnegative().default(0),
    })
    .strict(),
  factory_export_maintenance: z
    .object({ requestId: z.string().uuid(), workspace: z.string().min(1).max(WORKSPACE_MAX) })
    .strict(),
  factory_skill_decide: z
    .object({ requestId: z.string().uuid(), approve: z.boolean(), reason: textSchema.max(TITLE_MAX) })
    .strict(),
  factory_instruct: z
    .object({
      requestId: z.string().uuid().optional(),
      role: z.enum(FACTORY_ROLES),
      body: textSchema,
      taskId: z.string().uuid().optional(),
      replan: z.boolean().default(false),
    })
    .strict(),
  factory_setup: factoryConfigSchema,
  factory_model_policy: modelPolicyUpdateSchema,
  factory_status: z.object({}).strict(),
  factory_start: z.object({}).strict(),
  factory_pause: z.object({}).strict(),
  factory_request: z.object({ objective: textSchema, requestId: z.string().uuid().optional() }).strict(),
  factory_queue: queueControlSchema,
  factory_reorder_objective: z
    .object({
      featureId: z.string().uuid(),
      beforeFeatureId: z.string().uuid().optional(),
      afterFeatureId: z.string().uuid().optional(),
      expectedRevision: z.number().int().nonnegative(),
      requestId: z.string().uuid().optional(),
    })
    .strict(),
  factory_retry: z.object({ taskId: z.string().uuid().optional(), featureId: z.string().uuid().optional() }).strict(),
  factory_recover: z
    .object({
      requestId: z.string().uuid(),
      featureId: z.string().uuid(),
      expectedUpdatedAt: z.number(),
      action: z.enum(['lead', 'owner', 'existing']),
      note: z.string().trim().min(1).max(TRIAGE_NOTE_MAX),
    })
    .strict(),
  factory_triage: z
    .object({
      requestId: z.string().uuid(),
      taskId: z.string().uuid(),
      expectedVersion: z.number().int().nonnegative(),
      action: z.enum([
        'acknowledge',
        'investigate',
        'repair',
        'review',
        'verify',
        'wait',
        'approve_size',
        'adopt_merge',
      ]),
      note: z.string().trim().max(TRIAGE_NOTE_MAX).default(''),
      mergeCommit: z
        .string()
        .regex(/^[\da-f]{40}$/v, 'Expected a full 40-character lowercase hexadecimal commit.')
        .optional(),
    })
    .strict(),
  factory_enqueue: z
    .object({
      issue: z.number().int().positive(),
      parentIssue: z.number().int().positive(),
      title: textSchema,
      description: textSchema,
      acceptanceCriteria: z.array(textSchema).min(1),
      dependencies: z.array(z.string().uuid()).default([]),
    })
    .strict(),
  factory_capacity: z
    .object({
      provider: z.enum(PROVIDERS),
      usedPercent: z.number().min(0).max(PERCENT_MAX),
      resetAt: z.number().int().positive(),
      source: textSchema,
    })
    .strict(),
  factory_cancel_job: z.object({ jobId: z.string().uuid() }).strict(),
};
/** An exposed factory operation. */
export type FactoryOperation = keyof typeof factorySchemas;
/** Factory operation names for routing without importing the supervisor. */
export const FACTORY_OPERATIONS = [
  'factory_recommendations',
  'factory_recommendation_read',
  'factory_model_policy',
  'factory_progress',
  'factory_read_source',
  'factory_export_maintenance',
  'factory_skill_decide',
  'factory_setup',
  'factory_status',
  'factory_start',
  'factory_pause',
  'factory_request',
  'factory_retry',
  'factory_queue',
  'factory_triage',
  'factory_recover',
  'factory_reorder_objective',
  'factory_enqueue',
  'factory_capacity',
  'factory_cancel_job',
  'factory_instruct',
] as const;
/** Strict JSON Schema passed to both providers for their final result. */
export const AGENT_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['outcome', 'summary', 'findings', 'deliveries', 'skillActions', 'instructionReceipts'],
  properties: {
    outcome: { type: 'string', enum: ['success', 'changes_requested', 'blocked'] },
    summary: { type: 'string' },
    findings: { type: 'array', items: { type: 'string' } },
    instructionReceipts: {
      type: 'array',
      maxItems: MAX_INSTRUCTION_RECEIPTS,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'acknowledged', 'applied', 'evidence'],
        properties: {
          id: { type: 'string' },
          acknowledged: { type: 'boolean' },
          applied: { type: 'boolean' },
          evidence: { type: 'string' },
        },
      },
    },
    skillActions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'revision', 'state', 'reason'],
        properties: {
          name: { type: 'string' },
          revision: { type: 'string' },
          state: { type: 'string', enum: ['active', 'archived'] },
          reason: { type: 'string' },
        },
      },
    },
    deliveries: {
      type: 'array',
      maxItems: PLAN_MAX,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'key',
          'title',
          'description',
          'acceptanceCriteria',
          'dependencies',
          'capabilityTier',
          'assignmentProfiles',
          'skills',
        ],
        properties: {
          key: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          acceptanceCriteria: { type: 'array', items: { type: 'string' } },
          dependencies: { type: 'array', items: { type: 'string' } },
          capabilityTier: { type: ['string', 'null'], enum: ['small', 'standard', 'advanced', null] },
          assignmentProfiles: {
            type: 'array',
            maxItems: FACTORY_ROLES.length,
            items: roleChoiceOutput(FACTORY_ROLES, ROUTING_REASON_MAX),
          },
          skills: { type: 'array', maxItems: MAX_ASSIGNMENT_SKILLS, items: { type: 'string' } },
        },
      },
    },
  },
};
