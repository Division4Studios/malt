/**
 * Read-only Jira Cloud discovery. It verifies the site, the caller, the
 * selected project, its issue types and their workflow statuses, the
 * caller's project permissions and, when it may create issues, the fields each
 * issue type requires, then derives the tracker capability descriptor
 * from those permissions rather than assuming any. A missing site, project or
 * credential, or a rejected credential, is reported as external setup
 * required; a reachable project with missing permissions is degraded, with the
 * Jira admin action for each. Nothing is ever reported connected while it is
 * unverified, and Data Center/Server sites are stated unsupported.
 *
 * Workflow transitions belong to individual issues in Jira, so they are read
 * when a delivery moves between stages, not here.
 *
 * @file
 */
import { z } from 'zod/v3';

import { JiraRequestError, globalJiraFetch, jiraGet, jiraProjectKeySchema, parseJiraSite } from './client.ts';
import { projectResult, setupRequired, unsupported } from './discovery-result.ts';
import { discoverCreateFields, fieldProblems } from './fields.ts';
import { JIRA_PERMISSION_NAMES, permissionsSchema, statusesSchema } from './permissions.ts';

import type { JiraCredential, JiraCredentialSource, JiraFetch, JiraSite, JiraTransport } from './client.ts';
import type { JiraDiscovery, JiraProjectAccess } from './discovery-result.ts';
import type { JiraIssueTypeFields } from './fields.ts';
import type { JiraIssueType, JiraPermission, JiraProblem, JiraProblemScope } from './permissions.ts';

export { JIRA_PERMISSION_NAMES } from './permissions.ts';
export type { JiraDiscovery, JiraDiscoveryState } from './discovery-result.ts';

/** What discovery needs. */
export interface JiraDiscoveryInput {
  /** Operator-supplied site URL. */
  readonly site: string | null;
  /** Selected project key. */
  readonly projectKey: string | null;
  /** Credential handle resolver. */
  readonly credential: JiraCredentialSource;
  /** Transport; defaults to the global `fetch`. */
  readonly fetch?: JiraFetch;
  /** Clock. */
  readonly now?: () => Date;
}

/** `GET /rest/api/3/serverInfo`. */
const serverInfoSchema = z.object({ deploymentType: z.string() });
/** `GET /rest/api/3/myself`. */
const myselfSchema = z.object({ accountId: z.string().min(1), displayName: z.string() });
/** `GET /rest/api/3/project/{key}`. */
const projectSchema = z.object({ id: z.string().min(1), key: z.string().min(1), name: z.string() });

/**
 * Explain a failed request in setup terms.
 *
 * @param error - Thrown value.
 * @param scope - Setup part the request checked.
 * @returns Problem for the operator.
 * @throws {Error} For anything that is not a Jira request failure.
 */
function requestProblem(error: unknown, scope: JiraProblemScope): JiraProblem {
  if (!(error instanceof JiraRequestError)) {
    throw error;
  }
  const hints: Readonly<Record<string, string>> = {
    unauthorized: 'Check the account email and API token, or create a new token at id.atlassian.com.',
    forbidden: 'The account lacks access; ask a Jira admin to grant it.',
    not_found: 'Check the site URL and project key.',
    rate_limited: `Retry after ${String(error.retryAfterSeconds ?? 'a short')} seconds.`,
    unreachable: 'Check the site URL and network.',
    invalid: 'Check that the site URL is a Jira Cloud site.',
  };
  return { scope, message: `${error.message} ${hints[error.failure] ?? ''}`.trim() };
}

/**
 * Check the site and caller, the steps that need no project.
 *
 * @param transport - Site, credential and transport.
 * @returns The caller, or the problem that stops discovery.
 */
async function discoverCaller(
  transport: JiraTransport,
): Promise<{ caller: JiraDiscovery['caller']; problem: JiraProblem | null; isUnsupported: boolean }> {
  try {
    const info = serverInfoSchema.parse(await jiraGet(transport, '/rest/api/3/serverInfo'));
    if (info.deploymentType !== 'Cloud') {
      return { caller: null, problem: null, isUnsupported: true };
    }
  } catch (error) {
    return { caller: null, problem: requestProblem(asRequestError(error), 'site'), isUnsupported: false };
  }
  try {
    const myself = myselfSchema.parse(await jiraGet(transport, '/rest/api/3/myself'));
    return {
      caller: { accountId: myself.accountId, displayName: myself.displayName },
      problem: null,
      isUnsupported: false,
    };
  } catch (error) {
    return { caller: null, problem: requestProblem(asRequestError(error), 'credential'), isUnsupported: false };
  }
}

/**
 * Treat a malformed document like an invalid response.
 *
 * @param error - Thrown value.
 * @returns A Jira request error for schema failures; the value itself otherwise.
 */
function asRequestError(error: unknown): unknown {
  return error instanceof z.ZodError
    ? new JiraRequestError('Jira returned a document MALT does not recognise.', { failure: 'invalid' })
    : error;
}

/**
 * Read the project's issue types, the caller's permissions and, when the
 * caller may create issues, each issue type's required create fields.
 *
 * @param transport - Site, credential and transport.
 * @param key - Selected project's key, such as PROJ.
 * @returns Issue types, required fields and held permissions.
 */
async function discoverProjectAccess(transport: JiraTransport, key: string): Promise<JiraProjectAccess> {
  const problems: JiraProblem[] = [];
  let issueTypes: JiraIssueType[] = [];
  try {
    issueTypes = statusesSchema.parse(await jiraGet(transport, `/rest/api/3/project/${key}/statuses`));
  } catch (error) {
    problems.push(requestProblem(asRequestError(error), 'issue_types'));
  }
  const held: Partial<Record<JiraPermission, boolean>> = {};
  try {
    const response = permissionsSchema.parse(
      await jiraGet(transport, '/rest/api/3/mypermissions', {
        projectKey: key,
        permissions: JIRA_PERMISSION_NAMES.join(','),
      }),
    );
    for (const name of JIRA_PERMISSION_NAMES) {
      held[name] = response.permissions[name]?.havePermission === true;
    }
  } catch (error) {
    problems.push(requestProblem(asRequestError(error), 'permissions'));
  }
  let fields: JiraIssueTypeFields[] = [];
  if (held.CREATE_ISSUES === true && issueTypes.length > 0) {
    try {
      fields = await discoverCreateFields(transport, key, issueTypes);
      problems.push(...fieldProblems(fields));
    } catch (error) {
      problems.push(requestProblem(asRequestError(error), 'fields'));
    }
  }
  return { issueTypes, fields, held, problems };
}

/**
 * Validate the configured site, credential and project key before any request.
 *
 * @param input - Discovery input.
 * @returns Validated parts, `null` for each missing one, and the problems to report.
 */
function checkInput(input: JiraDiscoveryInput): {
  site: JiraSite | null;
  credential: JiraCredential | null;
  key: string | null;
  problems: JiraProblem[];
  base: Pick<JiraDiscovery, 'site' | 'deployment'>;
} {
  const site = input.site === null || input.site.trim() === '' ? null : parseJiraSite(input.site);
  const credential = input.credential();
  const key = jiraProjectKeySchema.safeParse(input.projectKey ?? '');
  const problems: JiraProblem[] = [];
  if (site === null) {
    problems.push({
      scope: 'site',
      message: 'Set an https Jira Cloud site URL such as https://example.atlassian.net.',
    });
  }
  if (credential === null) {
    problems.push({ scope: 'credential', message: 'Set the account email and the API token credential handle.' });
  }
  if (!key.success) {
    problems.push({ scope: 'project', message: 'Select a Jira project key such as PROJ.' });
  }
  return {
    site,
    credential,
    key: key.success ? key.data : null,
    problems,
    base: { site: site?.origin ?? null, deployment: site?.deployment ?? null },
  };
}

/**
 * Discover a Jira Cloud site, account, project and permissions without mutating anything.
 *
 * @param input - Site, project key, credential handle and optional transport.
 * @returns Discovery outcome; the token never appears in it.
 */
export async function discoverJira(input: JiraDiscoveryInput): Promise<JiraDiscovery> {
  const checked = checkInput(input);
  const { base } = checked;
  if (base.deployment === 'data-center') {
    return unsupported(base);
  }
  if (checked.site === null || checked.credential === null || checked.key === null) {
    return setupRequired(base, checked.problems);
  }
  const { site, credential, key } = checked;
  const transport: JiraTransport = { site, credential, fetch: input.fetch ?? globalJiraFetch };
  const { caller, problem, isUnsupported } = await discoverCaller(transport);
  if (isUnsupported) {
    return unsupported(base);
  }
  if (problem !== null) {
    return setupRequired(base, [problem]);
  }
  let project: JiraDiscovery['project'];
  try {
    const found = projectSchema.parse(await jiraGet(transport, `/rest/api/3/project/${key}`));
    project = { ...found, url: `${site.origin}/browse/${found.key}` };
  } catch (error) {
    return setupRequired({ ...base, caller }, [requestProblem(asRequestError(error), 'project')]);
  }
  const access = await discoverProjectAccess(transport, project.key);
  return projectResult({ ...base, caller, project }, access, input.now?.() ?? new Date());
}
