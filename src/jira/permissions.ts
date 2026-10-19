/**
 * What a Jira project lets the MALT account do: the project permissions MALT
 * checks, the Jira admin action that grants each, the shape of the project's
 * issue types and permission answers, and the tracker capability descriptor
 * derived from those permissions rather than assumed.
 *
 * @file
 */
import { z } from 'zod/v3';

import { unverifiedCapabilities } from '../connector.ts';

import type { Capabilities } from '../connector.ts';

/** Project permissions MALT checks, in report order. */
export const JIRA_PERMISSION_NAMES = [
  'BROWSE_PROJECTS',
  'CREATE_ISSUES',
  'EDIT_ISSUES',
  'TRANSITION_ISSUES',
  'ADD_COMMENTS',
  'LINK_ISSUES',
] as const;
/** A permission MALT checks. */
export type JiraPermission = (typeof JIRA_PERMISSION_NAMES)[number];
/** The Jira admin action that grants each permission. */
export const JIRA_PERMISSIONS: Readonly<Record<JiraPermission, string>> = {
  BROWSE_PROJECTS: 'Grant "Browse Projects" to the account in the project permission scheme.',
  CREATE_ISSUES: 'Grant "Create Issues" to the account in the project permission scheme.',
  EDIT_ISSUES: 'Grant "Edit Issues" to the account in the project permission scheme.',
  TRANSITION_ISSUES: 'Grant "Transition Issues" to the account in the project permission scheme.',
  ADD_COMMENTS: 'Grant "Add Comments" to the account in the project permission scheme.',
  LINK_ISSUES: 'Grant "Link Issues" to the account and enable issue linking in Jira settings.',
};

/** Which part of the setup a problem concerns. */
export type JiraProblemScope = 'site' | 'credential' | 'project' | 'permissions' | 'issue_types';

/** One actionable problem; it never contains the token. */
export interface JiraProblem {
  /** Setup part. */
  readonly scope: JiraProblemScope;
  /** What is wrong and what to do. */
  readonly message: string;
}

/** A project issue type with its workflow statuses. */
export interface JiraIssueType {
  /** Stable ID. */
  readonly id: string;
  /** Display name. */
  readonly name: string;
  /** Whether it is a sub-task type. */
  readonly subtask: boolean;
  /** Workflow statuses. */
  readonly statuses: readonly { readonly id: string; readonly name: string }[];
}

/** One workflow status. */
const statusSchema = z.object({ id: z.string().min(1), name: z.string() });
/** One issue type with its statuses. */
const issueTypeSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  subtask: z.boolean().default(false),
  statuses: z.array(statusSchema).default([]),
});
/** `GET /rest/api/3/project/{key}/statuses`. */
export const statusesSchema = z.array(issueTypeSchema);
/** One permission's answer. */
const heldSchema = z.object({ havePermission: z.boolean() });
/** `GET /rest/api/3/mypermissions`. */
export const permissionsSchema = z.object({ permissions: z.record(z.string(), heldSchema) });

/**
 * A capability state from whether the caller holds what it needs.
 *
 * @param isHeld - Whether the needed permissions are held.
 * @returns Supported or unsupported.
 */
function supportedWhen(isHeld: boolean): 'supported' | 'unsupported' {
  return isHeld ? 'supported' : 'unsupported';
}

/**
 * Derive the tracker capabilities from what the caller may do.
 *
 * @param held - Permissions the caller holds.
 * @param issueTypes - Project issue types.
 * @returns Capability descriptor; GitHub-only concepts are unsupported, Jira versions unverified.
 */
export function jiraCapabilities(
  held: Readonly<Partial<Record<JiraPermission, boolean>>>,
  issueTypes: readonly JiraIssueType[],
): Capabilities {
  const canCreate = held.CREATE_ISSUES === true;
  return {
    ...unverifiedCapabilities(),
    issue_create: supportedWhen(canCreate),
    sub_issues: supportedWhen(canCreate && issueTypes.some((type) => type.subtask)),
    dependencies: supportedWhen(held.LINK_ISSUES === true),
    labels: supportedWhen(held.EDIT_ISSUES === true),
    milestones: 'unverified',
    views: 'unsupported',
    pull_requests: 'unsupported',
  };
}

/**
 * A permission the caller lacks, with the admin action that grants it.
 *
 * @param permission - Permission the caller does not hold.
 * @returns Report entry.
 */
export function missingPermission(permission: JiraPermission): { permission: JiraPermission; action: string } {
  return { permission, action: JIRA_PERMISSIONS[permission] };
}

/**
 * The problem a missing permission causes.
 *
 * @param entry - Missing permission and its admin action.
 * @param entry.permission - The permission the caller lacks.
 * @param entry.action - Admin action that grants it.
 * @returns Operator-facing problem.
 */
export function permissionProblem(entry: { permission: JiraPermission; action: string }): JiraProblem {
  return { scope: 'permissions', message: `Missing ${entry.permission}. ${entry.action}` };
}
