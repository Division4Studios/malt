/**
 * Per-workspace Jira modes over the connector capability policy. A human
 * chooses read-only, comment-only or full, and which roles may perform the
 * enabled mutations; with no roles only the human operator may. Each mode is
 * simply a set of capability policies, so enforcement stays in one place, and
 * a mix set capability by capability reads back as `custom`. The admin
 * summary lists exactly what MALT reads from Jira and what each enabled
 * capability lets it change, before the connection is turned on.
 *
 * @file
 */
import { JIRA_WRITE_CAPABILITIES } from './writes.ts';

import type { Capability, CapabilityPolicy, CapabilityPolicyStore } from '../capability-policy.ts';
import type { FACTORY_ROLES } from '../factory/seats.ts';

/** How much MALT may change in Jira. */
export const JIRA_MODES = ['read-only', 'comment-only', 'full'] as const;
/** A Jira mode. */
export type JiraMode = (typeof JIRA_MODES)[number];
/** A factory role that may be granted Jira mutations. */
export type JiraRole = (typeof FACTORY_ROLES)[number];

/** Every capability a Jira mutation exercises, in summary order. */
export const JIRA_CAPABILITIES: readonly Capability[] = [...new Set(Object.values(JIRA_WRITE_CAPABILITIES).flat())];

/** The capabilities each mode enables. */
const ENABLED: Readonly<Record<JiraMode, readonly Capability[]>> = {
  'read-only': [],
  'comment-only': ['comment'],
  full: JIRA_CAPABILITIES,
};

/** What each capability lets MALT change in Jira. */
const CHANGES: Readonly<Partial<Record<Capability, string>>> = {
  'issue-create': 'Create issues in the project, with acceptance criteria in the description.',
  relationships: 'Create sub-tasks under a parent and link issues as dependencies.',
  transition: 'Move issues through the workflow transitions mapped to MALT stages.',
  comment: 'Comment progress, pull request links and merged-main evidence on issues.',
  'label-use': 'Add or remove existing labels on issues; labels themselves are never created or deleted.',
};

/** What MALT always reads, whatever the mode. */
export const JIRA_READS = [
  'The site and its deployment type.',
  "The connected account's ID and display name (never its email).",
  'The selected project, its issue types and their workflow statuses.',
  "The connected account's permissions in that project.",
  'Issues matching the intake filter: key, summary, status, assignee and resolution.',
  'An issue’s available transitions before moving it.',
] as const;

/**
 * The capability policies a mode stands for.
 *
 * @param mode - Chosen mode.
 * @param roles - Roles that may perform enabled mutations; none means the human operator only.
 * @returns One policy per Jira capability.
 */
export function jiraModePolicies(mode: JiraMode, roles: readonly JiraRole[]): Map<Capability, CapabilityPolicy> {
  const granted: CapabilityPolicy =
    roles.length === 0
      ? { mode: 'human-only', roles: [] }
      : {
          mode: 'approved-agent-roles',
          roles: [...new Set(roles)].toSorted((left, right) => left.localeCompare(right)),
        };
  const enabled = new Set(ENABLED[mode]);
  const disabled: CapabilityPolicy = { mode: 'disabled', roles: [] };
  const policies = new Map<Capability, CapabilityPolicy>();
  for (const capability of JIRA_CAPABILITIES) {
    policies.set(capability, enabled.has(capability) ? granted : disabled);
  }
  return policies;
}

/**
 * Apply a mode. Only a human principal may; the policy store refuses anyone else.
 *
 * @param store - Project capability policies.
 * @param principal - Authenticated human operator.
 * @param mode - Chosen mode.
 * @param roles - Roles that may perform the enabled mutations.
 */
export function setJiraMode(
  store: Pick<CapabilityPolicyStore, 'set'>,
  principal: unknown,
  mode: JiraMode,
  roles: readonly JiraRole[],
): void {
  for (const [capability, policy] of jiraModePolicies(mode, roles)) {
    store.set(principal, capability, policy);
  }
}

/**
 * The mode the current policies amount to.
 *
 * @param store - Project capability policies.
 * @returns The matching mode and its roles, or `custom` when capabilities were set individually.
 */
export function currentJiraMode(store: Pick<CapabilityPolicyStore, 'get'>): {
  mode: JiraMode | 'custom';
  roles: JiraRole[];
} {
  const current = new Map(JIRA_CAPABILITIES.map((capability) => [capability, store.get(capability)]));
  const granted = new Set(current.values().flatMap((policy) => policy.roles));
  const roles = [...granted].toSorted((left, right) => left.localeCompare(right));
  for (const mode of JIRA_MODES) {
    const expected = jiraModePolicies(mode, roles);
    const isMatch = JIRA_CAPABILITIES.every(
      (capability) => JSON.stringify(current.get(capability)) === JSON.stringify(expected.get(capability)),
    );
    if (isMatch) {
      return { mode, roles };
    }
  }
  return { mode: 'custom', roles };
}

/** One write the admin summary lists. */
export interface JiraWriteSummary {
  /** Capability behind it. */
  readonly capability: Capability;
  /** What it lets MALT change. */
  readonly change: string;
  /** Current policy mode. */
  readonly mode: CapabilityPolicy['mode'];
  /** Roles granted, when any. */
  readonly roles: readonly string[];
}

/**
 * Exactly what MALT will read from and change in Jira under the current policies.
 *
 * @param store - Project capability policies.
 * @returns Reads, then every Jira write with its current policy.
 */
export function jiraAccessSummary(store: Pick<CapabilityPolicyStore, 'get'>): {
  reads: readonly string[];
  writes: JiraWriteSummary[];
} {
  return {
    reads: JIRA_READS,
    writes: JIRA_CAPABILITIES.map((capability) => {
      const policy = store.get(capability);
      return { capability, change: CHANGES[capability] ?? capability, mode: policy.mode, roles: policy.roles };
    }),
  };
}
