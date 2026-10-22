/**
 * Jira as a connection's work tracker: read-only discovery for the setup flow
 * and verification of a saved Jira tracker section. The API token is read
 * only through the section's environment credential handle, which registers
 * the value for redaction before it is used, and never stored. A verified
 * section takes the project's real ID, URL and Status options from Jira and
 * the capabilities derived from the caller's permissions; anything short of
 * full verification is recorded with each problem and never reports connected:
 * missing permissions are degraded, a missing site, project or token, or one
 * Jira rejects, needs external setup, and a Data Center/Server site fails.
 *
 * @file
 */
import { ERRORS_KEPT } from '../connection-state.ts';
import { resolveCredential } from '../credentials.ts';
import { MeshError } from '../protocol.ts';

import { globalJiraFetch, parseJiraSite } from './client.ts';
import { discoverJira } from './discovery.ts';

import type { VerificationState } from '../connection-state.ts';
import type { JiraWorkflow, TrackerConnection } from '../connector.ts';
import type { JiraCredentialSource, JiraFetch, JiraTransport } from './client.ts';
import type { JiraDiscovery, JiraDiscoveryState } from './discovery.ts';

/** What `jira_discover` needs. */
export interface JiraConnectionInput {
  /** Operator-supplied site URL. */
  readonly site: string;
  /** Selected project key. */
  readonly projectKey: string;
  /** Atlassian account email. */
  readonly email: string;
  /** Environment variable holding the API token. */
  readonly tokenVariable: string;
}

/** Discovery state to the verification state a tracker section records. */
const SECTION_STATES: Readonly<Record<JiraDiscoveryState, VerificationState>> = {
  verified: 'verified',
  degraded: 'degraded',
  // The fix is in Jira or the supervisor's environment, not in MALT: a site, project, token or Browse Projects.
  external_setup_required: 'external',
  unsupported: 'failed',
};

/**
 * A credential source reading one environment handle; an unset variable is no credential.
 *
 * @param email - Account email.
 * @param tokenVariable - Environment variable name.
 * @param environment - The supervisor's environment.
 * @returns Resolver that registers the token for redaction when it reads it.
 * @throws {Error} For anything other than a missing variable.
 */
function handleCredential(email: string, tokenVariable: string, environment: NodeJS.ProcessEnv): JiraCredentialSource {
  return () => {
    try {
      return { email, token: resolveCredential({ kind: 'env', name: tokenVariable }, environment) };
    } catch (error) {
      if (error instanceof MeshError && error.code === 'CREDENTIALS_MISSING') {
        return null;
      }
      throw error;
    }
  };
}

/** A saved Jira tracker's connection details. */
export interface SavedJiraTracker {
  /** Site origin. */
  readonly site: string;
  /** Project key. */
  readonly projectKey: string;
  /** Account email. */
  readonly email: string;
  /** Environment variable holding the API token. */
  readonly tokenVariable: string;
  /** Intake filter and stage mapping, if a human chose them. */
  readonly workflow: JiraWorkflow;
}

/**
 * The Jira details of a saved tracker section.
 *
 * @param tracker - Saved tracker section.
 * @returns Site, project, account, token variable and workflow settings.
 * @throws {MeshError} INVALID_INPUT for a tracker that is not a Jira tracker with an environment handle.
 */
export function savedJiraTracker(tracker: TrackerConnection): SavedJiraTracker {
  const { jira, credential } = tracker;
  if (jira === undefined || tracker.provider !== 'jira' || credential?.kind !== 'env') {
    throw new MeshError('INVALID_INPUT', 'Save the Jira tracker again with its site, project and token variable.');
  }
  return {
    site: jira.site,
    projectKey: jira.projectKey,
    email: jira.email,
    tokenVariable: credential.name,
    workflow: jira.workflow ?? {},
  };
}

/**
 * The transport for a saved Jira tracker section. The token is read through the
 * section's environment handle, which registers it for redaction, and is never
 * kept beyond the transport.
 *
 * @param tracker - Saved Jira tracker section.
 * @param environment - The supervisor's environment, holding the token's variable.
 * @param fetch - Transport; defaults to the global `fetch`.
 * @returns Site, credential and transport for `jiraGet` and the capability-checked writes.
 * @throws {MeshError} INVALID_INPUT for a section without Jira details or a site that is not Jira Cloud;
 *   CREDENTIALS_MISSING while the token variable is unset.
 */
export function jiraTrackerTransport(
  tracker: TrackerConnection,
  environment: NodeJS.ProcessEnv,
  fetch: JiraFetch = globalJiraFetch,
): JiraTransport {
  const saved = savedJiraTracker(tracker);
  const site = parseJiraSite(saved.site);
  if (site?.deployment !== 'cloud') {
    throw new MeshError(
      'INVALID_INPUT',
      'The saved Jira tracker is not a Jira Cloud site; MALT 1.0 supports Cloud only.',
    );
  }
  const credential = handleCredential(saved.email, saved.tokenVariable, environment)();
  if (credential === null) {
    throw new MeshError(
      'CREDENTIALS_MISSING',
      `Set the ${saved.tokenVariable} environment variable to the Jira API token, then restart the broker.`,
    );
  }
  return { site, credential, fetch };
}

/**
 * Read-only discovery of a Jira Cloud project for the setup flow; nothing is saved.
 *
 * @param input - Site, project key, account email and the token's variable.
 * @param environment - The supervisor's environment.
 * @param fetch - Transport; defaults to the global `fetch`.
 * @returns Discovery outcome, which never contains the token.
 */
export async function discoverJiraConnection(
  input: JiraConnectionInput,
  environment: NodeJS.ProcessEnv,
  fetch?: JiraFetch,
): Promise<JiraDiscovery> {
  return discoverJira({
    site: input.site,
    projectKey: input.projectKey,
    credential: handleCredential(input.email, input.tokenVariable, environment),
    ...(fetch !== undefined && { fetch }),
  });
}

/**
 * Every workflow status in the project, once each, for the tracker's Status field.
 *
 * @param discovery - Verified or degraded discovery.
 * @returns Status options across every issue type's workflow.
 */
function statusOptions(discovery: JiraDiscovery): { id: string; name: string }[] {
  const options = new Map<string, string>();
  const statuses = discovery.issueTypes.flatMap((type) => type.statuses);
  for (const status of statuses) {
    options.set(status.id, status.name);
  }
  return [...options].map(([id, name]) => ({ id, name }));
}

/**
 * Verify a saved Jira tracker section against Jira.
 *
 * @param tracker - Saved Jira tracker section.
 * @param environment - The supervisor's environment, holding the token's variable.
 * @param context - Transport and clock.
 * @param context.fetch - Transport; defaults to the global `fetch`.
 * @param context.now - Verification time.
 * @returns The section with its new verification, and the project's real identity when Jira answered.
 */
export async function verifyJiraTracker(
  tracker: TrackerConnection,
  environment: NodeJS.ProcessEnv,
  context: { readonly fetch?: JiraFetch; readonly now: string },
): Promise<TrackerConnection> {
  const { jira, credential } = tracker;
  if (jira === undefined || credential?.kind !== 'env') {
    return {
      ...tracker,
      verification: {
        state: 'failed',
        checkedAt: context.now,
        errors: [
          { step: 'tracker', message: 'Save the Jira tracker again with its site, project and token variable.' },
        ],
      },
    };
  }
  const discovery = await discoverJiraConnection(
    { site: jira.site, projectKey: jira.projectKey, email: jira.email, tokenVariable: credential.name },
    environment,
    context.fetch,
  );
  const state = SECTION_STATES[discovery.state];
  const errors = discovery.problems
    .slice(0, ERRORS_KEPT)
    .map((problem) => ({ step: problem.scope, message: problem.message }));
  const { project } = discovery;
  return {
    ...tracker,
    ...(project !== null && {
      projectId: project.id,
      url: project.url,
      workflowField: { id: 'status', name: 'Status', options: statusOptions(discovery) },
      capabilities: discovery.capabilities,
    }),
    verifiedAt: state === 'verified' ? context.now : tracker.verifiedAt,
    verification: { state, checkedAt: context.now, errors },
  };
}
