/**
 * Input schemas of the connector setup and resource operations: read-only
 * discovery, per-section save and verification, and repository labels. The
 * protocol merges them into its operation table.
 *
 * @file
 */
import { z } from 'zod/v3';

import type { Operation } from './protocol.ts';

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
/** A Jira project chosen from `jira_discover`, and where its API token lives. */
const savedJiraTrackerSchema = z
  .object({
    site: z.string().url(),
    projectKey: z.string().regex(/^[A-Z][\dA-Z_]{1,99}$/v),
    projectId: z.string().regex(/^[1-9]\d{0,17}$/v),
    email: z.string().email(),
    tokenVariable: z.string().regex(/^[A-Z][\dA-Z_]{0,127}$/v),
  })
  .strict();
/** Longest JQL intake filter accepted; `connector.ts` keeps the same bound. */
const JQL_MAX = 2000;
/** Longest Jira status ID or name, or MALT stage name, accepted. */
const STATUS_TEXT_MAX = 255;
/** The Jira status one MALT stage moves an issue to; stage names are checked when saved. */
const stageTargetSchema = z
  .object({
    statusId: z.string().min(1).max(STATUS_TEXT_MAX),
    statusName: z.string().min(1).max(STATUS_TEXT_MAX),
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

/** Longest MCP binding name accepted. */
const BINDING_NAME_MAX = 32;

/** Longest saved view name accepted. */
const VIEW_NAME_MAX = 100;

/** Longest Project field name accepted. */
const FIELD_NAME_MAX = 100;
/** Most options a created single-select field may carry. */
const FIELD_OPTIONS_MAX = 50;

/** Connector operation inputs, keyed by operation name. */
export const connectorSchemas = {
  mcp_binding_status: z.object({}).strict(),
  // The binding store validates the binding itself.
  mcp_binding_propose: z.object({ binding: z.unknown() }).strict(),
  mcp_binding_approve: z
    .object({ name: z.string().min(1).max(BINDING_NAME_MAX), hash: z.string().regex(/^[\da-f]{64}$/v) })
    .strict(),
  github_view_manage: z
    .object({
      requestId: z.string().regex(/^[\w\-]{1,64}$/v),
      action: z.enum(['change', 'delete']),
      viewNumber: z.number().int().positive(),
      name: z.string().min(1).max(VIEW_NAME_MAX).optional(),
      layout: z.enum(['table', 'board', 'roadmap']).optional(),
    })
    .strict(),
  github_field_manage: z
    .object({
      requestId: z.string().regex(/^[\w\-]{1,64}$/v),
      action: z.enum(['create', 'change', 'delete']),
      fieldId: z.string().min(1).max(IDENTIFIER_MAX).optional(),
      name: z.string().min(1).max(FIELD_NAME_MAX),
      dataType: z.enum(['text', 'number', 'date', 'single_select']).optional(),
      options: z.array(z.string().min(1).max(FIELD_NAME_MAX)).max(FIELD_OPTIONS_MAX).optional(),
    })
    .strict(),
  github_views: z.object({}).strict(),
  github_view_create: z
    .object({
      requestId: z.string().regex(/^[\w\-]{1,64}$/v),
      name: z.string().min(1).max(VIEW_NAME_MAX),
      layout: z.enum(['table', 'board', 'roadmap']),
    })
    .strict(),
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
    .object({
      tracker: savedTrackerSchema.optional(),
      jiraTracker: savedJiraTrackerSchema.optional(),
      source: savedSourceSchema.optional(),
    })
    .strict(),
  jira_workflow_save: z
    .object({
      jql: z.string().trim().min(1).max(JQL_MAX).nullable().optional(),
      stages: z.record(z.string().min(1).max(STATUS_TEXT_MAX), stageTargetSchema).optional(),
    })
    .strict(),
  jira_discover: z
    .object({
      site: z.string().url(),
      projectKey: z.string().regex(/^[A-Z][\dA-Z_]{1,99}$/v),
      email: z.string().email(),
      tokenVariable: z.string().regex(/^[A-Z][\dA-Z_]{0,127}$/v),
    })
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

/** Connector MCP binding reads and human changes; never exported as agent tools. */
export const BINDING_OPERATIONS = [
  'mcp_binding_status',
  'mcp_binding_propose',
  'mcp_binding_approve',
] as const satisfies readonly Operation[];

/** A connector MCP binding read, proposal or approval. */
export type BindingOperation = (typeof BINDING_OPERATIONS)[number];

/**
 * Identify connector MCP binding controls.
 *
 * @param operation - Validated wire operation.
 * @returns Whether the broker routes it to the binding store.
 */
export function isBindingOperation(operation: Operation): operation is BindingOperation {
  return (BINDING_OPERATIONS as readonly Operation[]).includes(operation);
}
