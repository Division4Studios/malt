/**
 * Validated factory settings, delivery state and managed job results. These
 * schemas are shared by persistence, MCP boundaries and provider adapters.
 *
 * @file
 */

import { z } from 'zod/v3';

import { proofJobIdSchema, reconcileGitHubSchema } from './adoption-schema.ts';
import { MAX_ASSIGNMENT_SKILLS, MAX_INSTRUCTION_RECEIPTS, PLAN_MAX, ROUTING_REASON_MAX } from './agent-output.ts';
import {
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
import { recommendationBodySchema } from './recommendation-schema.ts';
import { FACTORY_ROLES, PROVIDERS, SPECIALIST_ROLES, keySchema } from './seats.ts';
import { terminalPolicySchema } from './terminal-lifetime.ts';
import {
  approvalSchema,
  approveRequestSchema,
  defaultWorkflowRequestSchema,
  frozenWorkflowSchema,
  saveWorkflowRequestSchema,
  stepResultSchema,
  planningResultSchema,
  dispositionsSchema,
} from './workflow-schema.ts';

export { AGENT_OUTPUT_SCHEMA } from './agent-output.ts';
export { FACTORY_ROLES, PROVIDERS, SPECIALIST_ROLES, keySchema } from './seats.ts';

/** Bound operator triage context independently of model transcripts. */
const TRIAGE_NOTE_MAX = 4000;
/** Named min free percent bound. */
const MIN_FREE_PERCENT = 15;
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

/** Longest descriptive task text. */
const TEXT_MAX = 32_000;
/** Longest public title. */
const TITLE_MAX = 200;
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
export {
  recommendationBodySchema,
  recommendationStateSchema,
  recommendationSchema,
  recommendationTransitionSchema,
} from './recommendation-schema.ts';
export type { RecommendationState, RecommendationBody, Recommendation } from './recommendation-schema.ts';
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
    organization: organizationSchema(FACTORY_ROLES, SPECIALIST_ROLES),
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
/** A provider's structured result; irrelevant fields must be empty arrays. */
export const resultSchema = z
  .object({
    outcome: z.enum(['success', 'changes_requested', 'blocked']),
    summary: textSchema,
    findings: z.array(textSchema),
    deliveries: z.array(deliverySchema).max(PLAN_MAX),
    skillActions: z.array(skillActionSchema).default([]),
    instructionReceipts: z.array(instructionReceiptSchema).max(MAX_INSTRUCTION_RECEIPTS).default([]),
    dispositions: dispositionsSchema.optional(),
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
  /** Absent for objectives saved before workflows existed; they run the original pipeline. */
  workflow: frozenWorkflowSchema.optional(),
  approvals: z.array(approvalSchema).default([]),
  /** When the plan step last produced a plan; plan reviews must postdate it. */
  planAt: z.number().nullable().optional(),
  planningResults: z.array(planningResultSchema).optional(),
});
/** One durable product request. */
export type Feature = z.output<typeof featureSchema>;
/** Exact-head independent review evidence; `stepId` is absent on results saved before workflows. */
export const reviewSchema = z.object({
  role: z.enum(FACTORY_ROLES),
  stepId: keySchema.optional(),
  head: z.string(),
  base: z.string(),
  outcome: z.enum(['success', 'changes_requested', 'blocked']),
  summary: textSchema,
  jobId: z.string().uuid(),
  findings: z.array(textSchema).optional(),
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
  verifiedMain: z
    .object({
      head: z.string(),
      jobId: proofJobIdSchema,
      summary: textSchema,
      /** Closed as not planned or duplicate: done, but never counted as delivered. */
      undelivered: z.literal(true).optional(),
    })
    .nullable()
    .default(null),
  approvals: z.array(approvalSchema).default([]),
  /** Source published by the implementation step; fixes and regressions build on it. */
  implementation: z.object({ head: z.string(), base: z.string(), at: z.number() }).nullable().default(null),
  stepResults: z.array(stepResultSchema).default([]),
  /** Frozen from the objective at provisioning; absent on deliveries saved before workflows. */
  workflow: frozenWorkflowSchema.optional(),
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
  /** Workflow step this attempt performs; `null` for attempts saved before workflows. */
  step: keySchema.nullable().default(null),
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
export { effectSchema } from './outbox-schema.ts';
export type { FactoryEffect } from './outbox-schema.ts';
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
  factory_recommendation_propose: z.object({ key: keySchema, proposal: recommendationBodySchema }).strict(),
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
  factory_request: z
    .object({ objective: textSchema, requestId: z.string().uuid().optional(), workflowId: keySchema.optional() })
    .strict(),
  factory_approve: approveRequestSchema,
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
      action: z.enum(['lead', 'owner', 'existing', 'retire']),
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
        'adopt_delivered',
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
  factory_workflow_save: saveWorkflowRequestSchema,
  factory_workflow_default: defaultWorkflowRequestSchema,
  factory_reconcile_github: reconcileGitHubSchema,
};
/** An exposed factory operation. */
export type FactoryOperation = keyof typeof factorySchemas;
/** Factory operation names for routing without importing the supervisor. */
export const FACTORY_OPERATIONS = [
  'factory_recommendation_propose',
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
  'factory_workflow_save',
  'factory_workflow_default',
  'factory_approve',
  'factory_reconcile_github',
] as const;
