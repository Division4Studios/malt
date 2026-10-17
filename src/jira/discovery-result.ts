/**
 * The outcome of Jira discovery and how it is assembled: verified only when
 * every read succeeded and every permission is held, degraded when the project
 * is readable but permissions are missing, external setup required when the
 * site, credential, project or Browse Projects is missing, and unsupported for
 * Data Center/Server sites. Capabilities stay unverified until the project can
 * be read.
 *
 * @file
 */
import { unverifiedCapabilities } from '../connector.ts';

import { JIRA_PERMISSION_NAMES, jiraCapabilities, missingPermission, permissionProblem } from './permissions.ts';

import type { Capabilities } from '../connector.ts';
import type { JiraDeployment } from './client.ts';
import type { JiraIssueType, JiraPermission, JiraProblem } from './permissions.ts';

/** Discovery outcome; only `verified` means every check passed. */
export type JiraDiscoveryState = 'verified' | 'degraded' | 'external_setup_required' | 'unsupported';

/** Everything discovery learned. */
export interface JiraDiscovery {
  /** Tracker provider. */
  readonly provider: 'jira';
  /** Outcome. */
  readonly state: JiraDiscoveryState;
  /** Validated site origin, when one was given. */
  readonly site: string | null;
  /** Cloud or Data Center/Server, when known. */
  readonly deployment: JiraDeployment | null;
  /** The authenticated account, without email. */
  readonly caller: { readonly accountId: string; readonly displayName: string } | null;
  /** The selected project. */
  readonly project: { readonly id: string; readonly key: string; readonly name: string; readonly url: string } | null;
  /** Issue types and statuses. */
  readonly issueTypes: readonly JiraIssueType[];
  /** Each checked permission and whether the caller holds it. */
  readonly permissions: Readonly<Partial<Record<JiraPermission, boolean>>>;
  /** Missing permissions with the admin action for each. */
  readonly missing: readonly { readonly permission: JiraPermission; readonly action: string }[];
  /** Capability descriptor derived from the permissions. */
  readonly capabilities: Capabilities;
  /** Actionable problems. */
  readonly problems: readonly JiraProblem[];
  /** When every check passed; `null` otherwise. */
  readonly verifiedAt: string | null;
}

/** What discovery read about the project itself. */
export interface JiraProjectAccess {
  /** Issue types and statuses. */
  readonly issueTypes: JiraIssueType[];
  /** Each checked permission and whether the caller holds it. */
  readonly held: Partial<Record<JiraPermission, boolean>>;
  /** Problems reading them. */
  readonly problems: JiraProblem[];
}

/** Discovery result before any request: nothing verified yet. */
const EMPTY = {
  provider: 'jira',
  site: null,
  deployment: null,
  caller: null,
  project: null,
  issueTypes: [],
  permissions: {},
  missing: [],
  verifiedAt: null,
} as const;

/**
 * A setup problem result.
 *
 * @param base - Fields known so far.
 * @param problems - What blocks verification.
 * @returns External-setup-required discovery.
 */
export function setupRequired(base: Partial<JiraDiscovery>, problems: readonly JiraProblem[]): JiraDiscovery {
  return {
    ...EMPTY,
    ...base,
    state: 'external_setup_required',
    capabilities: unverifiedCapabilities(),
    problems,
  };
}

/**
 * A Data Center/Server result: stated unsupported, never contacted.
 *
 * @param base - Site fields.
 * @returns Unsupported discovery.
 */
export function unsupported(base: Pick<JiraDiscovery, 'site' | 'deployment'>): JiraDiscovery {
  return {
    ...EMPTY,
    ...base,
    deployment: 'data-center',
    state: 'unsupported',
    capabilities: unverifiedCapabilities(),
    problems: [
      { scope: 'site', message: 'Jira Data Center and Server are not supported in MALT 1.0; use a Jira Cloud site.' },
    ],
  };
}

/**
 * Combine project access into the final outcome.
 *
 * @param base - Site, caller and project.
 * @param access - Issue types, held permissions and access problems.
 * @param now - Verification time, recorded only when every check passed.
 * @returns Verified, degraded or setup-required discovery.
 */
export function projectResult(
  base: Pick<JiraDiscovery, 'site' | 'deployment' | 'caller' | 'project'>,
  access: JiraProjectAccess,
  now: Date,
): JiraDiscovery {
  // A permission Jira did not confirm counts as missing, so a partial answer is never verified.
  const missing = JIRA_PERMISSION_NAMES.filter((name) => access.held[name] !== true).map((permission) =>
    missingPermission(permission),
  );
  const problems: JiraProblem[] = [...access.problems, ...missing.map((entry) => permissionProblem(entry))];
  const canBrowse = access.held.BROWSE_PROJECTS === true;
  let state: JiraDiscoveryState = 'degraded';
  if (!canBrowse) {
    state = 'external_setup_required';
  } else if (problems.length === 0) {
    state = 'verified';
  }
  return {
    ...EMPTY,
    ...base,
    state,
    issueTypes: access.issueTypes,
    permissions: access.held,
    missing,
    capabilities: canBrowse ? jiraCapabilities(access.held, access.issueTypes) : unverifiedCapabilities(),
    problems,
    verifiedAt: state === 'verified' ? now.toISOString() : null,
  };
}
